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
  type DelegationRun,
  type RunId,
  type Workspace,
  type GateResult,
} from '@ferry/shared';
import { WorkspaceJail, ShadowCheckpoints, runCommand } from '@ferry/workspace';
import { loadProjectConfig } from '@ferry/config';
import { CheckpointIdSchema } from '@ferry/shared';
import { canonicalPathKey } from '@ferry/shared/node-paths';
import { rpcDomainError, type CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { z } from 'zod';

const StartSchema = z.object({
  sessionId: z.string().min(1),
  lane: z.string().min(1),
  brief: z.string().min(1),
});
const DecisionSchema = z.enum(['accepted', 'rejected', 'rework']);

async function configuredGateCommands(
  workspace: Workspace,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const projectCommands = (await loadProjectConfig(workspace.path, env)).gateCommands;
  return workspace.settings.gateCommands.length ? workspace.settings.gateCommands : projectCommands;
}

async function executeGateCommands(
  jail: WorkspaceJail,
  commands: readonly string[],
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const command of commands) {
    const result = await runCommand(jail, { command, cwd: '.', pty: false, timeoutMs: 120_000 });
    results.push({
      command,
      ok: result.exitCode === 0 && !result.timedOut,
      outputTail: `${result.stdout}\n${result.stderr}`.trim().slice(-4000),
    });
  }
  return results;
}

export function register(host: CoreHost, services: FerryServices): void {
  const handles = new Map<string, DelegationHandle>();
  const workspaceForSession = (raw: unknown) => {
    const sessionId = SessionIdSchema.parse(raw);
    const session = services.sessions.get(sessionId);
    if (!session) throw rpcDomainError(-32044, 'not_found', `Session not found: ${sessionId}`);
    const workspace = services.workspaces.get(session.workspaceId);
    if (!workspace) throw rpcDomainError(-32044, 'not_found', 'Session workspace is unavailable');
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
      const beforeId = await shadow.snapshot(`Before delegation ${input.lane}`);
      const projectGateCommands = (await loadProjectConfig(workspace.path, services.env))
        .gateCommands;
      const gateCommands = workspace.settings.gateCommands.length
        ? workspace.settings.gateCommands
        : projectGateCommands;
      const now = services.clock.now().toISOString();
      const runId = newId('run') as RunId;
      const initial = DelegationRunSchema.parse({
        id: runId,
        sessionId,
        lane: lane.name,
        implementer: lane.implementer,
        brief: input.brief,
        status: 'running',
        startedAt: now,
        finishedAt: null,
        progress: [],
        finalMessage: null,
        touchedFiles: [],
        gateResults: [],
        usage: null,
        decision: null,
      });
      const checkpoint = {
        id: beforeId,
        sessionId,
        label: `Before delegation ${input.lane}`,
        createdAt: now,
        fileCount: 0,
      };
      services.checkpoints.put({ ...checkpoint, id: CheckpointIdSchema.parse(checkpoint.id) });
      publish(initial);
      const handle = startDelegation({
        runId,
        sessionId,
        lane,
        brief: input.brief,
        cwd: workspace.path,
        checkpointDiff: async () => {
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
            completed.status === 'completed' ? await executeGateCommands(jail, gateCommands) : [];
          const updated = DelegationRunSchema.parse({
            ...completed,
            gateResults,
            ...(gateResults.some((result) => !result.ok) ? { status: 'failed' } : {}),
          });
          publish(updated);
        })
        .catch((error: unknown) => {
          services.logger.error({ err: error, runId }, 'Delegation completion failed');
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
      const gateCommands = await configuredGateCommands(workspace, services.env);
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
            const resumed = await handle.resume(brief);
            const gateResults = await executeGateCommands(jail, gateCommands);
            return DelegationRunSchema.parse({
              ...resumed,
              gateResults,
              ...(gateResults.some((result) => !result.ok) ? { status: 'failed' } : {}),
            });
          },
        },
      );
      return publish(updated);
    },
  });
}
