import { sessionWorkspace } from '../session-workspace.js';
import {
  decide,
  detectAcpAgents,
  readLanes,
  startDelegation,
  type DelegationHandle,
} from '@ferry/delegate';
import {
  DelegationRunSchema,
  AcpAgentDetectionSchema,
  RunIdSchema,
  SessionIdSchema,
  newId,
  newTraceId,
  newSpanId,
  isProtectedWorkspacePath,
  type DelegationRun,
  type RunId,
  type Workspace,
  type GateResult,
  type TraceContext,
} from '@ferry/shared';
import {
  WorkspaceJail,
  ShadowCheckpoints,
  isRiskyWorkspaceRoot,
  runCommand,
} from '@ferry/workspace';
import { loadProjectConfig } from '@ferry/config';
import { CheckpointIdSchema } from '@ferry/shared';
import { canonicalPathKey } from '@ferry/shared/node-paths';
import { rpcDomainError, type CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const StartSchema = z.object({
  sessionId: z.string().min(1),
  lane: z.string().min(1),
  brief: z.string().min(1),
});
const DecisionSchema = z.enum(['accepted', 'rejected', 'rework']);

export function register(host: CoreHost, services: FerryServices): void {
  const handles = new Map<string, DelegationHandle>();
  const traceByRun = new Map<string, TraceContext>();
  const finishedTraceStatuses = new Map<string, Set<string>>();
  const logTraceEvent = (
    runId: string,
    event: string,
    level: 'info' | 'warn' | 'error',
    data: Record<string, unknown>,
  ) => {
    const trace = traceByRun.get(runId);
    if (!trace) return;
    services.telemetry.log({
      id: newId('evt'),
      ts: services.clock.now().toISOString(),
      level,
      source: 'delegate',
      event,
      session_id: trace.sessionId,
      trace_id: trace.traceId,
      span_id: trace.spanId,
      parent_span_id: trace.parentSpanId,
      device_id: trace.deviceId,
      app_version: trace.appVersion,
      data: { delegation_id: runId, ...data },
    });
  };
  const logFinished = (run: DelegationRun) => {
    if (run.status === 'running') return;
    const seen = finishedTraceStatuses.get(run.id) ?? new Set<string>();
    if (seen.has(run.status)) return;
    seen.add(run.status);
    finishedTraceStatuses.set(run.id, seen);
    logTraceEvent(run.id, 'delegation.finished', run.status === 'failed' ? 'error' : 'info', {
      status: run.status,
      response: run.finalMessage ?? '',
      decision: run.decision,
    });
  };
  const workspaceForSession = (raw: unknown) => {
    const sessionId = SessionIdSchema.parse(raw);
    const session = services.sessions.get(sessionId);
    if (!session) throw rpcDomainError(-32044, 'not_found', `Session not found: ${sessionId}`);
    const workspace = sessionWorkspace(services, session);
    return { sessionId, session, workspace };
  };
  const laneRead = async (workspacePath: string) => {
    const approvalKey = `delegate-approved:${canonicalPathKey(workspacePath)}`;
    const approved = services.settings.get(approvalKey);
    const legacyApproved = services.settings.get(`delegate-approved:${workspacePath}`);
    if (typeof approved !== 'string' && typeof legacyApproved === 'string')
      services.settings.put(approvalKey, legacyApproved);
    return readLanes({
      workspacePath,
      environment: services.env,
      approvedProjectHash:
        typeof approved === 'string'
          ? approved
          : typeof legacyApproved === 'string'
            ? legacyApproved
            : null,
    });
  };
  const projectConfigHash = async (workspacePath: string): Promise<string | null> => {
    try {
      const bytes = await readFile(join(workspacePath, '.ferry', 'config.json'));
      return createHash('sha256').update(bytes).digest('hex');
    } catch {
      return null;
    }
  };
  const projectConfigApprovalKey = (workspacePath: string) =>
    `project-config-approved:${canonicalPathKey(workspacePath)}`;
  const configuredGatePlan = async (workspace: Workspace) => {
    if (workspace.settings.gateCommands.length)
      return { commands: [...workspace.settings.gateCommands], projectConfigHash: null };
    const currentHash = await projectConfigHash(workspace.path);
    const approvedHash = services.settings.get(projectConfigApprovalKey(workspace.path));
    if (!currentHash || typeof approvedHash !== 'string' || currentHash !== approvedHash)
      return { commands: [], projectConfigHash: null };
    const commands = (await loadProjectConfig(workspace.path, {})).gateCommands;
    if ((await projectConfigHash(workspace.path)) !== approvedHash)
      return { commands: [], projectConfigHash: null };
    return { commands, projectConfigHash: commands.length ? approvedHash : null };
  };
  const executeGatePlan = async (
    jail: WorkspaceJail,
    workspace: Workspace,
    plan: Awaited<ReturnType<typeof configuredGatePlan>>,
  ) => {
    const results: GateResult[] = [];
    for (const command of plan.commands) {
      if (
        plan.projectConfigHash &&
        (await projectConfigHash(workspace.path)) !== plan.projectConfigHash
      )
        break;
      const result = await runCommand(jail, { command, cwd: '.', pty: false, timeoutMs: 120_000 });
      results.push({
        command,
        ok: result.exitCode === 0 && !result.timedOut,
        outputTail: `${result.stdout}\n${result.stderr}`.trim().slice(-4000),
      });
    }
    return results;
  };
  const briefWithGates = (brief: string, commands: readonly string[]) =>
    commands.length
      ? `${brief}\n\n## Gates\n${commands.map((command) => `- ${command}`).join('\n')}`
      : brief;
  const publish = (run: DelegationRun) => {
    const parsed = DelegationRunSchema.parse(run);
    services.delegations.put(parsed);
    host.emit('delegation.updated', parsed);
    return parsed;
  };
  host.registerDomain('delegation', {
    async detectAgents() {
      return (await detectAcpAgents()).map((agent) => AcpAgentDetectionSchema.parse(agent));
    },
    async lanes() {
      const workspace = services.workspaces.list()[0];
      if (!workspace) return [];
      return (await laneRead(workspace.path)).lanes;
    },
    async approveProjectLanes() {
      const workspace = services.workspaces.list()[0];
      if (!workspace) return [];
      const result = await readLanes({ workspacePath: workspace.path, environment: services.env });
      if (result.projectHash)
        services.settings.put(
          `delegate-approved:${canonicalPathKey(workspace.path)}`,
          result.projectHash,
        );
      return (await laneRead(workspace.path)).lanes;
    },
    async approveProjectConfig() {
      const workspace = services.workspaces.list()[0];
      if (!workspace) return { approved: false, hash: null };
      const hash = await projectConfigHash(workspace.path);
      if (!hash) return { approved: false, hash: null };
      services.settings.put(projectConfigApprovalKey(workspace.path), hash);
      return { approved: true, hash };
    },
    runs(rawSessionId: unknown) {
      const id = SessionIdSchema.parse(rawSessionId);
      if (!services.sessions.get(id))
        throw rpcDomainError(-32044, 'not_found', `Session not found: ${id}`);
      return services.delegations
        .list()
        .filter((run) => run.sessionId === id)
        .map((run) => DelegationRunSchema.parse(run));
    },
    async start(rawInput: unknown) {
      const input = StartSchema.parse(rawInput);
      const { sessionId, workspace } = workspaceForSession(input.sessionId);
      if (!workspace.trusted)
        throw rpcDomainError(
          -32046,
          'workspace_untrusted',
          'Trust this workspace before using tools',
        );
      const parentTrace = services.activeTraceContexts.get(sessionId);
      const read = await laneRead(workspace.path);
      const lane = read.lanes.find((candidate) => candidate.name === input.lane);
      if (!lane) throw rpcDomainError(-32044, 'not_found', `Lane not found: ${input.lane}`);
      if (!lane.trusted)
        throw rpcDomainError(-32045, 'permission_denied', 'Project delegation lanes need approval');
      if (lane.implementer === 'opencode' && !lane.model?.trim())
        throw rpcDomainError(
          -32010,
          'validation',
          'Choose a model for OpenCode in Settings \u2192 Delegation, or set a default model in your OpenCode config.',
        );
      const jail = new WorkspaceJail(workspace.path);
      const shadow = new ShadowCheckpoints(jail, services.paths.home);
      const beforeId = isRiskyWorkspaceRoot(workspace.path)
        ? null
        : await shadow.snapshot(`Before delegation ${input.lane}`);
      if (!beforeId)
        services.logger.warn(
          { workspaceId: workspace.id, path: workspace.path },
          'Skipping delegation checkpoint for a risky workspace root',
        );
      const gatePlan = await configuredGatePlan(workspace);
      const delegationBrief = briefWithGates(input.brief, gatePlan.commands);

      const now = services.clock.now().toISOString();
      const runId = newId('run') as RunId;
      const initial = DelegationRunSchema.parse({
        id: runId,
        sessionId,
        lane: lane.name,
        implementer: lane.implementer,
        brief: delegationBrief,
        status: 'running',
        startedAt: now,
        finishedAt: null,
        progress: [],
        events: [],
        finalMessage: null,
        touchedFiles: [],
        gateResults: [],
        usage: null,
        decision: null,
      });
      traceByRun.set(runId, {
        traceId: parentTrace?.traceId ?? newTraceId(),
        spanId: newSpanId(),
        ...(parentTrace?.spanId ? { parentSpanId: parentTrace.spanId } : {}),
        sessionId,
        deviceId: services.deviceId,
        appVersion: services.env.FERRY_RELEASE_VERSION ?? '0.9.0',
      });
      if (beforeId) {
        const checkpoint = {
          id: beforeId,
          sessionId,
          label: `Before delegation ${input.lane}`,
          createdAt: now,
          fileCount: 0,
        };
        services.checkpoints.put({ ...checkpoint, id: CheckpointIdSchema.parse(checkpoint.id) });
        logTraceEvent(runId, 'checkpoint.created', 'info', {
          checkpoint_id: checkpoint.id,
          label: checkpoint.label,
        });
      }
      publish(initial);
      logTraceEvent(runId, 'delegation.started', 'info', {
        lane: lane.name,
        implementer: lane.implementer,
        prompt: delegationBrief,
      });
      const handle = startDelegation({
        runId,
        sessionId,
        lane,
        brief: delegationBrief,
        cwd: workspace.path,
        onRecoveryOutput: (event, output) => {
          const use = (services.delegations.get(runId)?.events ?? []).find(
            (item) => item.type === 'tool_use' && item.callId === event.callId,
          );
          const args =
            use?.type === 'tool_use' && use.input && typeof use.input === 'object'
              ? (use.input as Record<string, unknown>)
              : {};
          const sourcePath =
            typeof args.path === 'string'
              ? args.path
              : typeof args.file_path === 'string'
                ? args.file_path
                : undefined;
          const command = typeof args.command === 'string' ? args.command : undefined;
          if (
            isProtectedWorkspacePath(sourcePath ?? '') ||
            command?.split(/[\s"'`|&;<>()[\]]+/).some(isProtectedWorkspacePath)
          )
            return null;
          const handle = newId('recovery');
          services.db.client
            .prepare('INSERT INTO optimizer_blobs (id,data_json,updated_at) VALUES (?,?,?)')
            .run(
              handle,
              JSON.stringify({
                id: handle,
                sessionId,
                workspaceId: workspace.id,
                ...(sourcePath ? { sourcePath } : {}),
                ...(command ? { command } : {}),
                content: output,
              }),
              services.clock.now().toISOString(),
            );
          return handle;
        },
        checkpointDiff: async () => {
          if (!beforeId) return [];
          const diff = await shadow.diff(beforeId);
          return (diff.match(/^diff --git a\/(.+?) b\//gm) ?? []).map((line) => ({
            path: line.replace(/^diff --git a\/(.+?) b\/.*/, '$1'),
            status: 'modified' as const,
            additions: 0,
            deletions: 0,
            before: null,
            after: null,
          }));
        },
        onUpdate: (run) => {
          publish(run);
        },
      });
      handles.set(initial.id, handle);
      void handle.run
        .then(async (completed) => {
          const gateResults =
            completed.status === 'completed'
              ? await executeGatePlan(jail, workspace, gatePlan)
              : [];
          const updated = DelegationRunSchema.parse({
            ...completed,
            gateResults,
            ...(gateResults.some((result) => !result.ok) ? { status: 'failed' } : {}),
          });
          publish(updated);
          logFinished(updated);
        })
        .catch((error: unknown) => {
          services.logger.error({ err: error, runId }, 'Delegation completion failed');
          logTraceEvent(runId, 'delegation.finished', 'error', {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return initial;
    },
    cancel(rawId: unknown) {
      const id = RunIdSchema.parse(rawId);
      const handle = handles.get(id);
      if (!handle) throw rpcDomainError(-32044, 'not_found', `Delegation run not found: ${id}`);
      handle.cancel();
    },
    async decide(rawId: unknown, rawDecision: unknown, rawReworkBrief?: unknown) {
      const id = RunIdSchema.parse(rawId);
      const decision = DecisionSchema.parse(rawDecision);
      const run = services.delegations.get(id);
      if (!run) throw rpcDomainError(-32044, 'not_found', `Delegation run not found: ${id}`);
      const handle = handles.get(id);
      const workspace = workspaceForSession(run.sessionId).workspace;
      const shadow = new ShadowCheckpoints(new WorkspaceJail(workspace.path), services.paths.home);
      const jail = new WorkspaceJail(workspace.path);
      const gatePlan = await configuredGatePlan(workspace);
      const updated = await decide(
        run,
        decision,
        rawReworkBrief === undefined ? undefined : z.string().min(1).parse(rawReworkBrief),
        {
          restoreCheckpoint: async () => {
            const checkpoint = services.checkpoints
              .list()
              .filter(
                (item) =>
                  item.sessionId === run.sessionId &&
                  item.label === `Before delegation ${run.lane}`,
              )
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
            if (checkpoint) await shadow.restore(checkpoint.id);
          },
          resumeSession: async (brief) => {
            if (!handle) throw new Error('Delegation process cannot be resumed after restart');
            const resumed = await handle.resume(briefWithGates(brief, gatePlan.commands));
            const gateResults = await executeGatePlan(jail, workspace, gatePlan);
            return DelegationRunSchema.parse({
              ...resumed,
              gateResults,
              ...(gateResults.some((result) => !result.ok) ? { status: 'failed' } : {}),
            });
          },
        },
      );
      const published = publish(updated);
      logFinished(published);
      return published;
    },
  });
}
