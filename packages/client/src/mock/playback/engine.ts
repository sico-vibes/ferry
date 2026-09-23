import { newId } from '@ferry/shared';
import type { Message, MessagePart, ModelRef, PartId, SessionId, TaskRecord } from '@ferry/shared';
import type { ScenarioRunner } from '../scenario.js';
import type { MockStore } from '../types.js';
import type { Clock } from '../clock.js';
import type { Scenario, Step } from './script.js';
import scenariosDefault from './scenarios/index.js';

const fallback = (() => {
  const scenario = scenariosDefault.find((candidate) => candidate.id === 'explain');
  if (!scenario) throw new Error('Playback explain scenario is required');
  return scenario;
})();
const pause = (clock: Clock, ms: number, speed: number, signal: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(ok);
    };
    const cancel = clock.setTimeout(() => {
      done(true);
    }, ms * speed);
    const abort = () => {
      cancel();
      done(false);
    };
    signal.addEventListener('abort', abort, { once: true });
  });

export function createPlaybackRunner(
  options: { scenarios?: Scenario[]; speed?: number } = {},
): ScenarioRunner {
  const scenarios = options.scenarios ?? scenariosDefault;
  const speed = Math.max(0, options.speed ?? 1);
  return {
    async run(ctx) {
      const { sessionId, userText, emit, store, clock, signal } = ctx;
      const session = store.sessions.find((candidate) => candidate.id === sessionId);
      if (!session) return;
      if (!session.modelRef) {
        const preferred = store.models.find((model) => model.ref === 'gemini/gemini-3.8-flash');
        if (preferred) session.modelRef = preferred.ref;
      }
      const scenario =
        scenarios.find(
          (candidate) => candidate.id !== 'explain' && candidate.match.test(userText),
        ) ?? fallback;
      const messages = store.messages.get(sessionId);
      if (!messages) return;
      const message: Message = {
        id: newId('message') as Message['id'],
        sessionId,
        role: 'assistant',
        createdAt: clock.now().toISOString(),
        modelRef: session.modelRef,
        parts: [],
      };
      messages.push(message);
      emit('session.message', { sessionId, message });
      let runningTool: Extract<MessagePart, { type: 'tool_call' }> | undefined;
      const addPart = (part: MessagePart) => {
        message.parts.push(part);
        emit('session.part', { sessionId, messageId: message.id, part });
      };
      const updateTask = (task: TaskRecord) => {
        store.taskRecords.set(sessionId, task);
        emit('task.updated', task);
      };
      const findModel = (ref: ModelRef) => store.models.find((item) => item.ref === ref);
      const handoff = (
        from: ModelRef,
        to: ModelRef,
        reason: Extract<Step, { kind: 'handoff' }>['reason'],
        explanation: string,
        briefingTokens = 0,
      ) => {
        addPart({
          type: 'handoff_marker',
          id: newId('part') as PartId,
          from,
          to,
          reason,
          briefingTokens,
          explanation,
        });
        session.modelRef = to;
        session.updatedAt = clock.now().toISOString();
        emit('session.updated', session);
        emit('toast', { kind: 'info', title: `Switched to ${to}`, body: explanation });
      };
      const ensureCapacity = () => {
        if (!session.modelRef) return;
        const current = findModel(session.modelRef);
        if (!current) return;
        const provider = store.providers.find((item) => item.id === current.providerId);
        if (provider?.dailyStepBudget === undefined || (provider.stepsLeftToday ?? 0) > 0) return;
        const choices = store.models
          .filter((model) => {
            const candidate = store.providers.find((item) => item.id === model.providerId);
            return (
              candidate?.enabled &&
              candidate.keyStatus === 'valid' &&
              (candidate.stepsLeftToday === null || candidate.stepsLeftToday > 0)
            );
          })
          .sort(
            (a, b) =>
              Number(b.free) - Number(a.free) ||
              a.tier.localeCompare(b.tier) ||
              (store.providers.find((p) => p.id === b.providerId)?.stepsLeftToday ?? -1) -
                (store.providers.find((p) => p.id === a.providerId)?.stepsLeftToday ?? -1),
          );
        if (choices[0])
          handoff(
            session.modelRef,
            choices[0].ref,
            'quota',
            `${provider.name} daily capacity exhausted; continuing with the best available candidate.`,
          );
      };
      const play = async (steps: Step[]): Promise<boolean> => {
        for (const step of steps) {
          if (signal.aborted) return false;
          if (step.kind === 'think') {
            if (!(await pause(clock, step.ms, speed, signal))) return false;
            continue;
          }
          if (step.kind === 'text') {
            ensureCapacity();
            consumeCurrent();
            const id = newId('part') as PartId;
            const nextReset =
              store.providers
                .flatMap((provider) =>
                  provider.windows.flatMap((window) =>
                    window.resetAt === null ? [] : [window.resetAt],
                  ),
                )
                .sort()[0] ?? 'the next scheduled reset';
            const text = step.text.replaceAll('{nextReset}', nextReset);
            const words = text.match(/\S+\s*/g) ?? [];
            const chunks: string[] = [];
            for (let i = 0; i < words.length;) {
              const size = 2 + (chunks.length % 3);
              chunks.push(words.slice(i, i + size).join(''));
              i += size;
            }
            for (const chunk of chunks) {
              if (!(await pause(clock, step.chunkMs ?? 45, speed, signal))) return false;
              emit('session.delta', {
                sessionId,
                messageId: message.id,
                partId: id,
                textDelta: chunk,
              });
            }
            addPart({ type: 'text', id, text });
            continue;
          }
          if (step.kind === 'reasoning') {
            addPart({ type: 'reasoning', id: newId('part') as PartId, text: step.text });
            continue;
          }
          if (step.kind === 'plan') {
            const toolPart = {
              type: 'tool_call' as const,
              id: newId('part') as PartId,
              tool: 'update_plan' as const,
              title: 'Update task plan',
              args: { items: step.items },
              status: 'succeeded' as const,
              output: {
                text: 'Plan updated',
                filtered: false,
                originalTokens: null,
                filteredTokens: null,
                recoveryHandle: null,
              },
              changes: [],
              durationMs: 0,
            };
            addPart(toolPart);
            const existing = store.taskRecords.get(sessionId);
            if (!existing) throw new Error(`Task record missing for session ${sessionId}`);
            updateTask({
              ...existing,
              goal: step.goal ?? existing.goal,
              plan: step.items.map((item, i) => ({ id: `plan_${String(i + 1)}`, ...item })),
              nextStep: step.nextStep ?? null,
            });
            continue;
          }
          if (step.kind === 'tool') {
            ensureCapacity();
            consumeCurrent();
            const part: Extract<MessagePart, { type: 'tool_call' }> = {
              type: 'tool_call',
              id: newId('part') as PartId,
              tool: step.tool,
              title: step.title,
              args: step.args,
              status: step.denied ? 'denied' : 'running',
              output: null,
              changes: [],
              durationMs: null,
            };
            addPart(part);
            if (step.denied) {
              part.output = step.output ?? null;
              emit('session.part', { sessionId, messageId: message.id, part });
              continue;
            }
            runningTool = part;
            if (!(await pause(clock, step.runMs, speed, signal))) {
              part.status = 'failed';
              part.output = {
                text: 'Cancelled',
                filtered: true,
                originalTokens: null,
                filteredTokens: 1,
                recoveryHandle: null,
              };
              emit('session.part', { sessionId, messageId: message.id, part });
              runningTool = undefined;
              return false;
            }
            part.status = 'succeeded';
            part.output = step.output ?? {
              text: 'Completed',
              filtered: false,
              originalTokens: null,
              filteredTokens: null,
              recoveryHandle: null,
            };
            part.changes = step.changes ?? [];
            part.durationMs = step.runMs * speed;
            emit('session.part', { sessionId, messageId: message.id, part });
            runningTool = undefined;
            if (step.touched?.length) {
              const task = store.taskRecords.get(sessionId);
              if (!task) throw new Error(`Task record missing for session ${sessionId}`);
              updateTask({ ...task, touchedFiles: [...task.touchedFiles, ...step.touched] });
            }
            continue;
          }
          if (step.kind === 'approval') {
            const id = newId('part') as PartId;
            const part: Extract<MessagePart, { type: 'approval_request' }> = {
              type: 'approval_request',
              id,
              kind: step.approvalKind ?? 'command',
              summary: step.summary,
              detail: step.detail,
              risk: step.risk,
              state: 'pending',
            };
            addPart(part);
            session.status = 'awaiting_approval';
            session.updatedAt = clock.now().toISOString();
            emit('session.updated', session);
            const decision = await waitApproval(store, sessionId, id, signal);
            if (!decision) return false;
            part.state = decision;
            session.status = 'running';
            session.updatedAt = clock.now().toISOString();
            emit('session.updated', session);
            if (!(await play(decision === 'denied' ? step.ifDenied : step.then))) return false;
            continue;
          }
          if (step.kind === 'handoff') {
            handoff(step.from, step.to, step.reason, step.explanation, step.briefingTokens);
            continue;
          }
          if (step.kind === 'delegation') {
            const id = newId('part') as PartId;
            const part: Extract<MessagePart, { type: 'approval_request' }> = {
              type: 'approval_request',
              id,
              kind: 'delegation',
              summary: `Delegate to ${step.lane}`,
              detail: step.brief,
              risk: 'low',
              state: 'pending',
            };
            addPart(part);
            session.status = 'awaiting_approval';
            emit('session.updated', session);
            const decision = await waitApproval(store, sessionId, id, signal);
            if (!decision) return false;
            part.state = decision;
            session.status = 'running';
            emit('session.updated', session);
            if (decision === 'denied') continue;
            const run = await store.startDelegation(sessionId, step.lane, step.brief);
            addPart({ type: 'delegation', id: newId('part') as PartId, runId: run.id });
            while (
              store.delegationRuns.find((item) => item.id === run.id)?.status !== 'completed'
            ) {
              if (!(await pause(clock, 100, speed, signal))) return false;
            }
            continue;
          }
          if (step.kind === 'checkpoint') {
            const checkpoint = {
              id: newId('checkpoint') as import('@ferry/shared').CheckpointId,
              sessionId,
              label: step.label,
              createdAt: clock.now().toISOString(),
              fileCount: store.taskRecords.get(sessionId)?.touchedFiles.length ?? 0,
            };
            store.checkpoints.push(checkpoint);
            addPart({
              type: 'checkpoint',
              id: newId('part') as PartId,
              checkpointId: checkpoint.id,
              label: step.label,
            });
            continue;
          }
          if (step.kind === 'capacity') {
            let remaining = step.steps;
            for (const provider of store.providers
              .filter((item) => item.dailyStepBudget !== undefined)
              .sort((a, b) => (a.stepsLeftToday ?? 0) - (b.stepsLeftToday ?? 0))) {
              const use = Math.min(remaining, provider.stepsLeftToday ?? 0);
              if (use > 0) {
                store.consumeSteps(provider.id, use);
                remaining -= use;
              }
              if (remaining <= 0) break;
            }
            continue;
          }
          addPart({
            type: 'error',
            id: newId('part') as PartId,
            message: step.message,
            kind: step.errorKind,
          });
          session.status = 'error';
          emit('session.updated', session);
          return false;
        }
        return true;
      };
      const consumeCurrent = () => {
        if (!session.modelRef) return;
        const model = findModel(session.modelRef);
        if (model) {
          const provider = store.providers.find((item) => item.id === model.providerId);
          if (provider?.dailyStepBudget !== undefined) store.consumeSteps(provider.id, 1);
        }
      };
      try {
        await play(scenario.steps);
      } catch (error) {
        if (!signal.aborted) throw error;
      }
      if (signal.aborted && runningTool) {
        runningTool.status = 'failed';
        runningTool.output = {
          text: 'Cancelled',
          filtered: true,
          originalTokens: null,
          filteredTokens: 1,
          recoveryHandle: null,
        };
        emit('session.part', { sessionId, messageId: message.id, part: runningTool });
      }
    },
  };
}

function waitApproval(
  store: MockStore,
  sessionId: SessionId,
  partId: PartId,
  signal: AbortSignal,
): Promise<'allowed_once' | 'allowed_always' | 'denied' | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const abort = () => {
      resolve(null);
    };
    signal.addEventListener('abort', abort, { once: true });
    void store.waitForApproval(sessionId, partId).then(
      (decision) => {
        signal.removeEventListener('abort', abort);
        resolve(decision);
      },
      () => {
        signal.removeEventListener('abort', abort);
        resolve(null);
      },
    );
  });
}
