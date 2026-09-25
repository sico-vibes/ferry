import { AgentLoop, SessionStore } from '@ferry/agent';
import type { AgentEvent } from '@ferry/agent';
import { WorkspaceJail, ShadowCheckpoints } from '@ferry/workspace';
import { loadProjectConfig } from '@ferry/config';
import type { AgentTool, ToolSource as AgentToolSource } from '@ferry/agent';
import type { ToolSource as ExtensionToolSource } from '@ferry/extensions';
import {
  MessageSchema,
  PartIdSchema,
  ProfileSchema,
  SessionDetailSchema,
  SessionIdSchema,
  SessionSchema,
  TaskRecordSchema,
  CheckpointIdSchema,
  newId,
} from '@ferry/shared';
import type { MessagePart, Profile, Session, SessionId } from '@ferry/shared';
import { BUILTIN_PROFILES } from '@ferry/router';
import { createSkillManager } from './skills.js';
import { createMcpManager } from './mcp.js';
import { McpServerConfigSchema } from '@ferry/extensions';
import { rpcDomainError, type CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { createSessionDependencies } from '../session-deps.js';
import { z } from 'zod';

const CreateSchema = z.object({
  workspaceId: z.string().min(1),
  profileId: z.string().min(1).optional(),
  title: z.string().optional(),
});
const SendSchema = z.object({ text: z.string().min(1) });
const RenameSchema = z.string().min(1).max(160);
const BooleanSchema = z.boolean();

export function register(host: CoreHost, services: FerryServices): void {
  const controllers = new Map<string, AbortController>();
  const approvals = new Map<
    string,
    (decision: 'allowed_once' | 'allowed_always' | 'denied') => void
  >();
  const store = new SessionStore({
    sessions: services.sessions,
    messages: services.messages,
    tasks: services.tasks,
  });
  const profileList = (): Profile[] => {
    const saved = services.settings.get('profiles');
    const custom = Array.isArray(saved) ? saved.map((item) => ProfileSchema.parse(item)) : [];
    return [...BUILTIN_PROFILES.map((item) => ProfileSchema.parse(item)), ...custom];
  };
  const requireSession = (rawId: unknown): Session => {
    const id = SessionIdSchema.parse(rawId);
    const session = services.sessions.get(id);
    if (!session) throw rpcDomainError(-32044, 'not_found', `Session not found: ${id}`);
    return SessionSchema.parse(session);
  };
  const updateSession = (session: Session) => {
    const updated = SessionSchema.parse({
      ...session,
      updatedAt: services.clock.now().toISOString(),
    });
    services.sessions.put(updated);
    host.emit('session.updated', updated);
    host.emit('session.status', updated);
    return updated;
  };
  const deleteSession = (id: SessionId) => {
    services.messages
      .list()
      .filter((message) => message.sessionId === id)
      .forEach((message) => services.messages.delete(message.id));
    services.tasks.delete(id);
    services.sessions.delete(id);
  };
  const listSessions = (rawQuery?: unknown) => {
    const query = z
      .object({ workspaceId: z.string().optional(), query: z.string().optional() })
      .parse(rawQuery ?? {});
    const needle = query.query?.toLocaleLowerCase();
    return services.sessions
      .list()
      .filter(
        (session) =>
          (!query.workspaceId || session.workspaceId === query.workspaceId) &&
          (!needle || `${session.title} ${session.preview}`.toLocaleLowerCase().includes(needle)),
      )
      .map((session) => SessionSchema.parse(session))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };

  // A process restart cannot resume a provider stream, but all prior messages and steps are durable.
  for (const session of services.sessions.list()) {
    if (session.status === 'running' || session.status === 'awaiting_approval')
      updateSession({ ...session, status: 'error' });
  }

  host.registerDomain('sessions', {
    list: listSessions,
    search: listSessions,
    get(rawId: unknown) {
      const id = SessionIdSchema.parse(rawId);
      const detail = store.load(id);
      if (!detail) throw rpcDomainError(-32044, 'not_found', `Session not found: ${id}`);
      return SessionDetailSchema.parse(detail);
    },
    create(rawInput: unknown) {
      const input = CreateSchema.parse(rawInput);
      if (!services.workspaces.get(input.workspaceId))
        throw rpcDomainError(-32044, 'not_found', `Workspace not found: ${input.workspaceId}`);
      const configured = services.settings.get('global');
      const activeProfile =
        typeof configured === 'object' &&
        configured !== null &&
        'activeProfileId' in configured &&
        typeof configured.activeProfileId === 'string'
          ? configured.activeProfileId
          : undefined;
      const validActive =
        activeProfile && profileList().some((item) => item.id === activeProfile)
          ? activeProfile
          : undefined;
      const selected = input.profileId ?? validActive ?? 'profile_builtin_best_available';
      const profile = profileList().find((item) => item.id === selected);
      if (!profile) throw rpcDomainError(-32044, 'not_found', `Profile not found: ${selected}`);
      const now = services.clock.now().toISOString();
      const session = SessionSchema.parse({
        id: newId('session'),
        workspaceId: input.workspaceId,
        title: input.title?.trim() ?? 'New Chat',
        preview: '',
        profileId: profile.id,
        modelRef: null,
        starred: false,
        pinned: false,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      });
      services.sessions.put(session);
      services.tasks.put(
        TaskRecordSchema.parse({
          sessionId: session.id,
          goal: session.title,
          plan: [],
          decisions: [],
          touchedFiles: [],
          nextStep: null,
        }),
      );
      host.emit('session.updated', session);
      host.emit('session.status', session);
      return session;
    },
    async send(rawId: unknown, rawInput: unknown) {
      const session = requireSession(rawId);
      const { text } = SendSchema.parse(rawInput);
      if (controllers.has(session.id))
        throw rpcDomainError(-32010, 'conflict', 'Session is already running');
      const workspace = services.workspaces.get(session.workspaceId);
      if (!workspace) throw rpcDomainError(-32044, 'not_found', 'Session workspace is unavailable');
      const profile = profileList().find((item) => item.id === session.profileId);
      if (!profile)
        throw rpcDomainError(-32044, 'not_found', `Profile not found: ${session.profileId}`);
      const jail = new WorkspaceJail(workspace.path);
      const shadow = new ShadowCheckpoints(jail, services.paths.home);
      const checkpointId = await shadow.snapshot(`Before Ferry session ${session.id}`);
      services.checkpoints.put({
        id: CheckpointIdSchema.parse(checkpointId),
        sessionId: session.id,
        label: 'Before agent edits',
        createdAt: services.clock.now().toISOString(),
        fileCount: 0,
      });
      const now = services.clock.now();
      const userMessage = store.appendMessage(
        session.id,
        'user',
        [{ type: 'text', id: PartIdSchema.parse(newId('part')), text }],
        session.modelRef,
        now,
      );
      host.emit('session.message', {
        sessionId: session.id,
        message: MessageSchema.parse(userMessage),
      });
      const current = services.sessions.get(session.id);
      if (!current) throw rpcDomainError(-32044, 'not_found', `Session not found: ${session.id}`);
      updateSession({
        ...current,
        ...(current.title === 'New Chat'
          ? { title: text.trim().split(/\s+/).slice(0, 6).join(' ').slice(0, 80) }
          : {}),
        status: 'running',
      });
      const controller = new AbortController();
      controllers.set(session.id, controller);
      const emitAgentEvent = (event: AgentEvent) => {
        if (event.type === 'session.delta')
          host.emit('session.delta', {
            sessionId: event.sessionId,
            messageId: event.messageId,
            partId: PartIdSchema.parse(event.partId),
            textDelta: event.text,
          });
        else if (event.type === 'session.part') {
          host.emit('session.part', event);
          if (event.part.type === 'approval_request') host.emit('approval.request', event);
        } else if (event.type === 'session.message')
          host.emit('session.message', { sessionId: session.id, message: event.message });
        else if (event.type === 'session.updated') {
          host.emit('session.updated', event.session);
          host.emit('session.status', event.session);
        } else if (event.type === 'task.updated') host.emit('task.updated', event.task);
        else if (event.type === 'quota.updated')
          host.emit('quota.updated', services.quota.capacitySummary());
        else if (event.type === 'optimizer.event') {
          const id = newId('optimizer');
          const optimizerEvent = {
            id,
            sessionId: session.id,
            kind: event.tool,
            beforeTokens: event.originalTokens,
            afterTokens: event.filteredTokens,
            timestamp: services.clock.now().toISOString(),
          };
          services.optimizerEvents.put(optimizerEvent);
        } else host.emit('toast', { kind: event.tone, title: event.message, body: null });
      };
      const runtime = await createSessionDependencies(services, emitAgentEvent);
      const config = await loadProjectConfig(workspace.path, services.env);
      const skillManager = createSkillManager(services, workspace.path);
      await skillManager.load();
      const mcpManager = createMcpManager(services, host, workspace.path);
      const mcpConfigs = z
        .array(McpServerConfigSchema)
        .safeParse(services.settings.get('mcp-servers') ?? []);
      if (mcpConfigs.success) {
        await mcpManager.configure(mcpConfigs.data);
        await mcpManager.connect().catch((error: unknown) => {
          services.logger.warn({ err: error }, 'MCP tool connection failed');
        });
      }
      const loop = new AgentLoop({
        store,
        workspace: workspace.path,
        dataDir: services.paths.home,
        profile,
        catalog: services.catalog,
        capacity: runtime.capacity,
        apiKeys: runtime.apiKeys,
        permissionMode: config.permissionMode,
        permissionRules: [
          ...config.permissionRules.map((rule) => ({
            effect: rule.mode,
            tool: '*',
            level: 'project' as const,
            pattern: rule.pattern,
          })),
          ...(Array.isArray(services.settings.get(`permission-rules:${session.workspaceId}`))
            ? (
                services.settings.get(`permission-rules:${session.workspaceId}`) as {
                  pattern: string;
                  mode: 'allow' | 'ask' | 'deny';
                }[]
              ).map((rule) => ({
                effect: rule.mode,
                tool: '*',
                level: 'user' as const,
                pattern: rule.pattern,
              }))
            : []),
        ],
        toolSources: [
          adaptExtensionTools(skillManager.toolSource()),
          adaptExtensionTools(mcpManager.toolSource()),
        ],
        generator: (req) => runtime.gateway.streamStep(req, req.signal),
        onUsage: (record) => {
          runtime.usage.record(record);
        },
        onHandoff: (reason) => {
          runtime.gateway.recordHandoff(session.id, reason);
        },
        resolveCandidates: (selectedProfile, stepKind) =>
          runtime.gateway.resolveCandidates(selectedProfile, stepKind),
        emit: emitAgentEvent,
        requestApproval: (part, signal) =>
          new Promise((resolve) => {
            const approvalKey = `${session.id}:${part.id}`;
            approvals.set(approvalKey, resolve);
            // The UI can answer as soon as the approval part is emitted, before this
            // callback registers its waiter. Reconcile the persisted decision to avoid
            // leaving the agent suspended after a fast Allow click.
            const persisted = services.messages
              .list()
              .flatMap((message) => (message.sessionId === session.id ? message.parts : []))
              .find((candidate) => candidate.id === part.id);
            if (persisted?.type === 'approval_request' && persisted.state !== 'pending') {
              approvals.delete(approvalKey);
              resolve(persisted.state);
            }
            signal.addEventListener(
              'abort',
              () => {
                approvals.delete(approvalKey);
                resolve('denied');
              },
              { once: true },
            );
          }),
        filterOutput: async (name, output) => {
          const { optimizeOutput } = await import('@ferry/optimizer');
          const result = optimizeOutput(name, output);
          const handle = result.output === output ? undefined : newId('recovery');
          if (handle)
            services.db.client
              .prepare('INSERT INTO optimizer_blobs (id,data_json,updated_at) VALUES (?,?,?)')
              .run(
                handle,
                JSON.stringify({ id: handle, sessionId: session.id, content: output }),
                services.clock.now().toISOString(),
              );
          return {
            text: result.output,
            filtered: result.output !== output,
            ...(handle ? { recoveryHandle: handle } : {}),
          };
        },
        readRecovery: (handle) => {
          const row = services.db.client
            .prepare('SELECT data_json FROM optimizer_blobs WHERE id=?')
            .get(handle) as { data_json: string } | undefined;
          if (!row) return Promise.resolve(undefined);
          return Promise.resolve((JSON.parse(row.data_json) as { content?: string }).content);
        },
      });
      void loop
        .run({ sessionId: session.id, signal: controller.signal })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            services.logger.error({ err: error, sessionId: session.id }, 'Agent session failed');
        })
        .finally(() => {
          void mcpManager.dispose();
          controllers.delete(session.id);
          const latest = services.sessions.get(session.id);
          if (latest?.status === 'running') updateSession({ ...latest, status: 'idle' });
        });
    },
    cancel(rawId: unknown) {
      const session = requireSession(rawId);
      controllers.get(session.id)?.abort();
      controllers.delete(session.id);
      updateSession({ ...session, status: 'idle' });
    },
    rename(rawId: unknown, rawTitle: unknown) {
      const session = requireSession(rawId);
      return updateSession({ ...session, title: RenameSchema.parse(rawTitle) });
    },
    setStarred(rawId: unknown, rawValue: unknown) {
      const session = requireSession(rawId);
      return updateSession({ ...session, starred: BooleanSchema.parse(rawValue) });
    },
    setPinned(rawId: unknown, rawValue: unknown) {
      const session = requireSession(rawId);
      return updateSession({ ...session, pinned: BooleanSchema.parse(rawValue) });
    },
    remove(rawId: unknown) {
      const session = requireSession(rawId);
      controllers.get(session.id)?.abort();
      deleteSession(session.id);
    },
  });

  host.registerDomain('approvals', {
    respond(rawSessionId: unknown, rawPartId: unknown, rawDecision: unknown) {
      const sessionId = SessionIdSchema.parse(rawSessionId);
      const partId = PartIdSchema.parse(rawPartId);
      const decision = z.enum(['allow_once', 'allow_always', 'deny']).parse(rawDecision);
      const message = services.messages
        .list()
        .find(
          (item) =>
            item.sessionId === sessionId &&
            item.parts.some((part) => part.id === partId && part.type === 'approval_request'),
        );
      if (!message) throw rpcDomainError(-32044, 'not_found', `Approval not found: ${partId}`);
      const target = message.parts.find((part) => part.id === partId);
      if (target?.type !== 'approval_request')
        throw rpcDomainError(-32044, 'not_found', `Approval not found: ${partId}`);
      const state: 'allowed_once' | 'allowed_always' | 'denied' =
        decision === 'allow_once'
          ? 'allowed_once'
          : decision === 'allow_always'
            ? 'allowed_always'
            : 'denied';
      const updatedPart: Extract<MessagePart, { type: 'approval_request' }> = {
        ...target,
        state,
      };
      if (decision === 'allow_always') {
        const session = requireSession(sessionId);
        const existing = z
          .array(z.object({ pattern: z.string(), mode: z.enum(['allow', 'ask', 'deny']) }))
          .catch([])
          .parse(services.settings.get(`permission-rules:${session.workspaceId}`) ?? []);
        services.settings.put(`permission-rules:${session.workspaceId}`, [
          ...existing.filter((rule) => rule.pattern !== target.detail),
          { pattern: target.detail, mode: 'allow' },
        ]);
      }
      const updated = store.replacePart(sessionId, updatedPart);
      if (updated)
        host.emit('session.part', { sessionId, messageId: message.id, part: updatedPart });
      approvals.get(`${sessionId}:${partId}`)?.(state);
      approvals.delete(`${sessionId}:${partId}`);
    },
  });
}

function adaptExtensionTools(source: ExtensionToolSource): AgentToolSource {
  return {
    tools: () =>
      source.listTools().map((definition): AgentTool => ({
        name: definition.name,
        title: definition.description,
        schema: z.record(z.string(), z.unknown()),
        execute: (args, context) => source.call(definition.name, args, context.signal),
      })),
  };
}
