import { AgentLoop, SessionStore } from '@ferry/agent';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentEvent } from '@ferry/agent';
import { WorkspaceJail, ShadowCheckpoints } from '@ferry/workspace';
import { ProjectConfigSchema } from '@ferry/config';
import type { AgentTool, ToolSource as AgentToolSource } from '@ferry/agent';
import type { ToolSource as ExtensionToolSource } from '@ferry/extensions';
import {
  MessageSchema,
  PartIdSchema,
  ProfileSchema,
  RoutingSettingsSchema,
  SessionDetailSchema,
  SessionIdSchema,
  SessionSchema,
  TaskRecordSchema,
  CheckpointIdSchema,
  newId,
  ReadOutputInputSchema,
  readOutputPage,
  isProtectedWorkspacePath,
} from '@ferry/shared';
import type { MessagePart, ModelInfo, Profile, Provider, Session, SessionId } from '@ferry/shared';
import {
  BUILTIN_PROFILES,
  chainForProfile,
  isStrictFallbackNameEligible,
  resolveFallbackChain,
  scoreModels,
  ResilienceEntrySchema,
  canSpend,
  estimateSpend,
  isFreeForRouting,
  type SpendState,
} from '@ferry/router';
import { createSkillManager } from './skills.js';
import { createMcpManager } from './mcp.js';
import { McpServerConfigSchema } from '@ferry/extensions';
import { rpcDomainError, type CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { hasUsableProviderKey } from '../services.js';
import { preserveCatalogBillingMetadata } from '../model-billing-metadata.js';
import { createSessionDependencies } from '../session-deps.js';
import { oauthModelCatalog } from '@ferry/oauth';
import { z } from 'zod';
import { canonicalPathKey } from '@ferry/shared/node-paths';

const CreateSchema = z.object({
  workspaceId: z.string().min(1),
  profileId: z.string().min(1).optional(),
  title: z.string().optional(),
});
const SendSchema = z.object({
  text: z.string().min(1),
  maxSteps: z.number().int().positive().optional(),
  verbose: z.boolean().optional(),
  routingMode: z.enum(['auto_for_step']).optional(),
  resume: z.boolean().optional(),
});
const RenameSchema = z.string().min(1).max(160);
const BooleanSchema = z.boolean();
const noModelMessage = 'No available model — add a provider key or check Explore → Providers';
const defaultStepTimeoutMs = 120_000;
const PaidCapsSchema = z.object({
  sessionUsd: z.number().nonnegative().nullable().default(null),
  dailyUsd: z.number().nonnegative().nullable().default(null),
  monthlyUsd: z.number().nonnegative().nullable().default(null),
});
function isPaidAccordingToRouter(
  model: Pick<ModelInfo, 'ref' | 'free' | 'priceInPerM' | 'priceOutPerM'>,
  provider: Provider | undefined,
  trialOptInProviders: readonly string[],
): boolean {
  return provider ? !isFreeForRouting(provider, model, trialOptInProviders) : true;
}

function unknownPriceModel(
  modelRef: ModelInfo['ref'],
): Pick<ModelInfo, 'ref' | 'free' | 'priceInPerM' | 'priceOutPerM'> {
  return { ref: modelRef, free: false, priceInPerM: null, priceOutPerM: null };
}

function tightestCap(profileCap: number | null, globalCap: number | null): number | null {
  return profileCap === null
    ? globalCap
    : globalCap === null
      ? profileCap
      : Math.min(profileCap, globalCap);
}

function stepTimeoutFromEnvironment(value: string | undefined): number {
  const timeout = Number(value);
  return Number.isSafeInteger(timeout) && timeout > 0 ? timeout : defaultStepTimeoutMs;
}

export function register(host: CoreHost, services: FerryServices): void {
  const controllers = new Map<string, AbortController>();
  const runPromises = new Map<string, Promise<void>>();
  const paidReservations = new Map<
    string,
    {
      sessionId: string;
      profileId: string;
      modelRef: string;
      amountUsd: number;
      day: string;
      month: string;
    }
  >();
  let shuttingDown = false;
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
    const overrides = services.settings.get('profile-overrides');
    const builtinOverrides = Array.isArray(overrides)
      ? overrides.map((item) => ProfileSchema.parse(item))
      : [];
    return [
      ...BUILTIN_PROFILES.map((base) => {
        const override = builtinOverrides.find((item) => item.id === base.id);
        return ProfileSchema.parse(override ? { ...base, ...override, builtin: true } : base);
      }),
      ...custom,
    ];
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

  host.onShutdown(async () => {
    shuttingDown = true;
    const interruptedSessionIds = [...controllers.keys()];
    for (const sessionId of controllers.keys()) {
      for (const message of services.messages
        .list()
        .filter((item) => item.sessionId === sessionId)) {
        for (const part of message.parts) {
          if (part.type !== 'approval_request' || part.state !== 'pending') continue;
          const denied = { ...part, state: 'denied' as const };
          store.replacePart(sessionId, denied);
          host.emit('session.part', { sessionId, messageId: message.id, part: denied });
        }
      }
    }
    for (const controller of controllers.values()) controller.abort();
    for (const resolve of approvals.values()) {
      resolve('denied');
    }
    approvals.clear();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...runPromises.values()]),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 5_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    for (const sessionId of interruptedSessionIds) {
      const latest = services.sessions.get(sessionId);
      if (latest && (latest.status !== 'interrupted' || latest.inFlight))
        updateSession({ ...latest, status: 'interrupted', inFlight: false });
    }
  });
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

  // The provider stream is process-local. A durable run marker survives status writes made by
  // provider error handling while the process is already crashing.
  for (const session of services.sessions.list()) {
    if (session.inFlight || session.status === 'running' || session.status === 'awaiting_approval')
      updateSession({ ...session, status: 'interrupted', inFlight: false });
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
    async readOutput(rawInput: unknown) {
      const input = ReadOutputInputSchema.parse(rawInput);
      const session = requireSession(input.sessionId);
      const workspace = services.workspaces.get(session.workspaceId);
      if (!workspace) throw rpcDomainError(-32044, 'not_found', 'Session workspace is unavailable');
      const jail = new WorkspaceJail(workspace.path);
      try {
        await jail.initialize();
      } catch {
        throw rpcDomainError(-32044, 'not_found', 'Session workspace is unavailable');
      }
      const row = services.db.client
        .prepare('SELECT data_json FROM optimizer_blobs WHERE id=?')
        .get(input.handle) as { data_json: string } | undefined;
      if (!row) throw rpcDomainError(-32044, 'not_found', 'Output handle not found');
      let blob: {
        sessionId?: string;
        workspaceId?: string;
        content?: unknown;
        sourcePath?: unknown;
        command?: unknown;
      };
      try {
        blob = JSON.parse(row.data_json) as typeof blob;
      } catch {
        throw rpcDomainError(-32044, 'not_found', 'Output handle not found');
      }
      if (
        blob.sessionId !== session.id ||
        (blob.workspaceId !== undefined && blob.workspaceId !== session.workspaceId) ||
        typeof blob.content !== 'string'
      )
        throw rpcDomainError(-32044, 'not_found', 'Output handle not found');
      if (typeof blob.sourcePath === 'string') {
        if (isProtectedWorkspacePath(blob.sourcePath))
          throw rpcDomainError(-32044, 'not_found', 'Output handle not found');
        try {
          await jail.resolve(blob.sourcePath);
        } catch {
          throw rpcDomainError(-32044, 'not_found', 'Output handle not found');
        }
      }
      if (
        typeof blob.command === 'string' &&
        blob.command
          .split(/[\s"'`|&;<>()[\]]+/)
          .some((path) => path && isProtectedWorkspacePath(path))
      )
        throw rpcDomainError(-32044, 'not_found', 'Output handle not found');
      return readOutputPage(blob.content, input);
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
      const defaultProfile =
        profileList().find((item) => item.builtin && item.name === 'Auto-Free') ??
        profileList().find((item) => item.builtin);
      if (!defaultProfile) throw new Error('No built-in profiles are configured');
      const selected = input.profileId ?? validActive ?? defaultProfile.id;
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
        pinnedModelRef: null,
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
      const { text, maxSteps, verbose, routingMode, resume } = SendSchema.parse(rawInput);
      if (controllers.has(session.id) || shuttingDown)
        throw rpcDomainError(-32010, 'conflict', 'Session is already running');
      const workspace = services.workspaces.get(session.workspaceId);
      if (!workspace) throw rpcDomainError(-32044, 'not_found', 'Session workspace is unavailable');
      const profile = profileList().find((item) => item.id === session.profileId);
      if (!profile)
        throw rpcDomainError(-32044, 'not_found', `Profile not found: ${session.profileId}`);
      const controller = new AbortController();
      controllers.set(session.id, controller);
      let resolveRun!: () => void;
      const run = new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
      runPromises.set(session.id, run);
      try {
        if (!resume) {
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
        }
        const preflight = createSessionDependencies(services, () => undefined);
        const configuredProviders = services.catalog.providers.filter(
          ({ provider, key_required }) => {
            const saved = services.providers.get(provider);
            const hasKey = hasUsableProviderKey(services, provider);
            return (saved?.enabled ?? hasKey) && (hasKey || key_required === false);
          },
        );
        const configuredOauth = oauthModelCatalog.filter((model) => {
          const saved = services.providers.get(model.providerId);
          return saved?.enabled && saved.keyStatus === 'valid';
        });
        const availableModels = preserveCatalogBillingMetadata(
          [
            ...(services.env.NODE_ENV === 'test'
              ? [
                  ...services.catalog.models,
                  ...configuredProviders.flatMap(({ provider: id }) => services.models.list(id)),
                ]
              : configuredProviders.flatMap(({ provider: id }) => services.models.list(id))),
            ...configuredOauth,
          ],
          services.catalog.models,
          (id) => services.providers.get(id),
          (id) => services.catalog.providers.find((item) => item.provider === id)?.free_plan,
        );
        const preflightCapacity = preflight.capacity();
        const verifiedModelRefs = preflightCapacity.providers.flatMap((provider) =>
          provider.modelsVerifiedAt && provider.availableModels
            ? provider.availableModels.map((model) => model.ref)
            : [],
        );
        const settingsValue = services.settings.get('global');
        const routingValue =
          typeof settingsValue === 'object' && settingsValue !== null && 'routing' in settingsValue
            ? settingsValue.routing
            : undefined;
        const routing = RoutingSettingsSchema.parse(routingValue ?? {});
        const reliability =
          z
            .array(
              z.object({
                modelRef: z.string(),
                outcome: z.enum(['success', 'failure']),
                at: z.number(),
              }),
            )
            .safeParse(services.settings.get('routing-reliability')).data ?? [];
        const stickyState =
          z
            .record(
              z.string(),
              z.object({
                modelRef: z.string(),
                providerId: z.string().optional(),
                providerKeyId: z.string().optional(),
                expiresAt: z.number(),
              }),
            )
            .safeParse(services.settings.get('routing-sticky-sessions')).data ?? {};
        const routingInput = {
          models: availableModels,
          capacity: preflightCapacity,
          profile,
          step: 'plan',
          estimate: { inputTokens: 1, outputTokens: 2048, expectedSteps: 1, requiresTools: true },
          verifiedModelRefs,
          routing,
          reliability,
          random: services.random,
        } as const;
        const chain = chainForProfile(profile);
        const chainResult = resolveFallbackChain({
          chain,
          models: availableModels,
          capacity: preflightCapacity,
          profile,
          inputTokens: 1,
          step: 'plan',
          verifiedModelRefs,
          avoidTrainingProviders: routing.avoidTrainingProviders,
          trialOptInProviders: routing.trialOptInProviders,
          now: services.clock.now().getTime(),
        });
        const chainRefs = new Set(chainResult.models.map((model) => model.ref));
        const routingCandidates = scoreModels({
          ...routingInput,
          models: availableModels.filter(
            (model) =>
              !chainRefs.has(model.ref) &&
              (!chain.length || isStrictFallbackNameEligible(model, verifiedModelRefs)),
          ),
        });
        const hasAvailableModel = chainResult.models.length > 0 || routingCandidates.length > 0;
        if (verbose) {
          const explainCandidates = scoreModels(routingInput);
          const selectedRef = chainResult.hit?.modelRef ?? explainCandidates[0]?.ref;
          if (selectedRef)
            host.emit('routing.explain', {
              sessionId: session.id,
              selected: selectedRef,
              candidates: explainCandidates.map(({ ref, score, explanation, scoreBreakdown }) => ({
                ref,
                score,
                explanation,
                scoreBreakdown,
              })),
              chain: chainResult.diagnostics,
              chainHit: chainResult.hit,
              influences: {
                sticky:
                  routing.stickySessions &&
                  (stickyState[session.id]?.expiresAt ?? 0) > services.clock.now().getTime()
                    ? `sticky: kept ${String(stickyState[session.id]?.modelRef)}`
                    : null,
                smartReliability: routing.smartReliability
                  ? 'smart reliability: Thompson-sampled recent outcomes'
                  : null,
                quotaReservations: routing.quotaReservations
                  ? 'quota reservations: enabled for provider requests'
                  : null,
                cooldownReasons: routing.cooldownReasons
                  ? 'cooldown reasons: provenance-aware probes enabled'
                  : null,
                gentleQuotaRamp: routing.gentleQuotaRamp
                  ? 'gentle quota ramp: live quota headroom applied'
                  : null,
                toolRejectionMemory: routing.toolRejectionMemory
                  ? 'tool-rejection memory: recent tool failures affect ordering'
                  : null,
                carefulModelRetirement: routing.carefulModelRetirement
                  ? 'careful model retirement: corroborated lifecycle signals applied'
                  : null,
              },
            });
        }
        if (!hasAvailableModel && services.env.NODE_ENV !== 'test') {
          const errorMessage = store.appendMessage(
            session.id,
            'assistant',
            [
              {
                type: 'error',
                id: PartIdSchema.parse(newId('part')),
                message: noModelMessage,
                kind: 'provider',
              },
            ],
            null,
            services.clock.now(),
          );
          host.emit('session.message', {
            sessionId: session.id,
            message: MessageSchema.parse(errorMessage),
          });
          const latest = services.sessions.get(session.id);
          if (latest)
            updateSession({
              ...latest,
              title:
                latest.title === 'New Chat'
                  ? text.trim().split(/\s+/).slice(0, 6).join(' ').slice(0, 80)
                  : latest.title,
              status: 'error',
            });
          controllers.delete(session.id);
          runPromises.delete(session.id);
          resolveRun();
          return;
        }
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
        const current = services.sessions.get(session.id);
        if (!current) throw rpcDomainError(-32044, 'not_found', `Session not found: ${session.id}`);
        updateSession({
          ...current,
          ...(current.title === 'New Chat'
            ? { title: text.trim().split(/\s+/).slice(0, 6).join(' ').slice(0, 80) }
            : {}),
          status: 'running',
          inFlight: true,
        });
        const emitAgentEvent = (event: AgentEvent) => {
          if (event.type === 'session.delta')
            host.emit('session.delta', {
              sessionId: event.sessionId,
              messageId: event.messageId,
              partId: PartIdSchema.parse(event.partId),
              textDelta: event.text,
            });
          else if (event.type === 'agent.event') host.emit('agent.event', event);
          else if (event.type === 'session.part') {
            host.emit('session.part', event);
            if (event.part.type === 'approval_request' && event.part.state === 'pending')
              host.emit('approval.request', event);
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
              kind: event.kind,
              beforeTokens: event.beforeTokens,
              afterTokens: event.afterTokens,
              timestamp: services.clock.now().toISOString(),
            };
            services.optimizerEvents.put(optimizerEvent);
          } else host.emit('toast', { kind: event.tone, title: event.message, body: null });
        };
        const runtime = createSessionDependencies(services, emitAgentEvent);
        const sessionCatalogModels = [
          ...(services.env.NODE_ENV === 'test'
            ? services.catalog.models
            : configuredProviders.flatMap(({ provider: id }) => services.models.list(id))),
          ...configuredOauth,
        ];
        const sessionCatalog = {
          ...services.catalog,
          models: preserveCatalogBillingMetadata(
            sessionCatalogModels,
            services.catalog.models,
            (id) => services.providers.get(id),
            (id) => services.catalog.providers.find((item) => item.provider === id)?.free_plan,
          ),
        };
        const rawProjectConfig = await readFile(join(workspace.path, '.ferry', 'config.json'))
          .then((bytes) => {
            const source: unknown = JSON.parse(bytes.toString('utf8'));
            return { bytes, source, parsed: ProjectConfigSchema.safeParse(source) };
          })
          .catch(() => null);
        const projectConfigHash = rawProjectConfig
          ? createHash('sha256').update(rawProjectConfig.bytes).digest('hex')
          : null;
        const projectConfigApproved =
          projectConfigHash !== null &&
          services.settings.get(`project-config-approved:${canonicalPathKey(workspace.path)}`) ===
            projectConfigHash;
        const globalSettings = services.settings.get('global');
        const savedToolCallRepair =
          z
            .boolean()
            .safeParse(
              typeof globalSettings === 'object' && globalSettings !== null
                ? (globalSettings as { toolCallRepair?: unknown }).toolCallRepair
                : undefined,
            ).data ?? true;
        const savedPermissionMode = z
          .enum(['ask', 'auto_edit', 'full_auto'])
          .safeParse(
            typeof globalSettings === 'object' && globalSettings !== null
              ? (globalSettings as { permissionMode?: unknown }).permissionMode
              : undefined,
          );
        const userPermissionMode = savedPermissionMode.success ? savedPermissionMode.data : 'ask';
        const projectPermissionMode =
          projectConfigApproved &&
          rawProjectConfig?.parsed.success &&
          hasOwnProperty(rawProjectConfig.source, 'permissionMode')
            ? rawProjectConfig.parsed.data.permissionMode
            : undefined;
        const effectivePermissionMode = projectPermissionMode
          ? stricterPermissionMode(userPermissionMode, projectPermissionMode)
          : userPermissionMode;
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
          catalog: sessionCatalog,
          pinnedModelRef: routingMode === 'auto_for_step' ? null : session.pinnedModelRef,
          stepTimeoutMs: stepTimeoutFromEnvironment(services.env.FERRY_STEP_TIMEOUT_MS),
          capacity: runtime.capacity,
          apiKeys: runtime.apiKeys,
          repairToolCalls: savedToolCallRepair,
          permissionMode: effectivePermissionMode,
          ...(maxSteps === undefined ? {} : { maxSteps }),
          resilienceState: (() => {
            const parsed = z
              .array(ResilienceEntrySchema)
              .safeParse(services.settings.get('routing-resilience')).data;
            return (
              parsed?.map(({ cooldownActive, permanentNonFree, ...entry }) => ({
                ...entry,
                ...(cooldownActive === undefined ? {} : { cooldownActive }),
                ...(permanentNonFree === undefined ? {} : { permanentNonFree }),
              })) ?? []
            );
          })(),
          onResilienceState: (entries) => {
            services.settings.put('routing-resilience', entries);
          },
          routingSettings: () => {
            const stored = services.settings.get('global');
            const routing =
              typeof stored === 'object' && stored !== null && 'routing' in stored
                ? stored.routing
                : undefined;
            return RoutingSettingsSchema.parse(routing ?? {});
          },
          reliabilityState:
            z
              .array(
                z.object({
                  modelRef: z.string(),
                  outcome: z.enum(['success', 'failure']),
                  at: z.number(),
                }),
              )
              .safeParse(services.settings.get('routing-reliability')).data ?? [],
          onReliabilityState: (entries) => {
            services.settings.put('routing-reliability', entries);
          },
          routingNow: () => services.clock.now().getTime(),
          stickyState:
            z
              .record(
                z.string(),
                z.object({
                  modelRef: z.string(),
                  providerId: z.string().optional(),
                  providerKeyId: z.string().optional(),
                  expiresAt: z.number(),
                }),
              )
              .safeParse(services.settings.get('routing-sticky-sessions')).data ?? {},
          onStickyState: (state) => {
            services.settings.put('routing-sticky-sessions', state);
          },
          providerAffinityKey: (providerId, sessionId) =>
            runtime.gateway.providerAffinityKey(providerId, sessionId),
          toolRejectionState:
            z
              .array(z.object({ modelRef: z.string(), requestId: z.string(), at: z.number() }))
              .safeParse(services.settings.get('routing-tool-rejections')).data ?? [],
          onToolRejectionState: (entries) => {
            services.settings.put('routing-tool-rejections', entries);
          },
          retirementFailureState:
            z
              .array(z.object({ modelRef: z.string(), requestId: z.string(), at: z.number() }))
              .safeParse(services.settings.get('routing-retirement-failures')).data ?? [],
          onRetirementFailureState: (entries) => {
            services.settings.put('routing-retirement-failures', entries);
          },
          retiredModelRefs:
            z.array(z.string()).safeParse(services.settings.get('routing-retired-models')).data ??
            [],
          onRetiredModelRefs: (entries) => {
            services.settings.put('routing-retired-models', entries);
          },
          acquireQuotaLease: (model, tokens) =>
            services.quota.acquireLease(model.providerId, model.ref, tokens) ?? null,
          probeHeuristicCooldowns: () => runtime.gateway.probeHeuristicCooldowns(),
          permissionRules: [
            ...(projectConfigApproved &&
            rawProjectConfig?.parsed.success &&
            hasOwnProperty(rawProjectConfig.source, 'permissionRules')
              ? rawProjectConfig.parsed.data.permissionRules.map((rule) => ({
                  effect: rule.mode,
                  tool: '*',
                  level: 'project' as const,
                  pattern: rule.pattern,
                }))
              : []),
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
          authorizePaidCall: async (candidate, estimate, signal) => {
            const providerRecord = preflightCapacity.providers.find(
              (item) => item.id === candidate.providerId,
            );
            const subscriptionLane =
              providerRecord?.tag === 'subscription_oauth' ||
              providerRecord?.tag === 'subscription_cli';
            const trialLane = providerRecord?.tag === 'trial' || providerRecord?.tag === 'credits';
            const routerSaysPaid = isPaidAccordingToRouter(
              candidate,
              providerRecord,
              routing.trialOptInProviders,
            );
            const laneNeedsConfirmation =
              routerSaysPaid &&
              ((subscriptionLane && profile.paidConfirmation.confirmSubscriptions) ||
                (trialLane && profile.paidConfirmation.confirmTrials));
            const monetaryPaid =
              routerSaysPaid &&
              ((!subscriptionLane && !trialLane) || providerRecord.billingEnabled === true);
            if (!routerSaysPaid && !laneNeedsConfirmation) return { allowed: true };
            const usage = services.quota.queryUsage();
            const byRef = new Map<string, (typeof availableModels)[number]>(
              availableModels.map((model) => [model.ref, model]),
            );
            const paidRows = usage.filter((row) => {
              const model = byRef.get(row.modelRef);
              const provider = preflightCapacity.providers.find(
                (item) => item.id === row.providerId,
              );
              const usageModel = model ?? unknownPriceModel(row.modelRef as ModelInfo['ref']);
              const confirmationOnlyLane =
                provider?.billingEnabled !== true &&
                (provider?.tag === 'subscription_oauth' ||
                  provider?.tag === 'subscription_cli' ||
                  provider?.tag === 'trial' ||
                  provider?.tag === 'credits');
              return (
                !confirmationOnlyLane &&
                isPaidAccordingToRouter(usageModel, provider, routing.trialOptInProviders)
              );
            });
            const confirmationOnlyRows = usage.filter((row) => {
              if (row.sessionId !== session.id) return false;
              const provider = preflightCapacity.providers.find(
                (item) => item.id === row.providerId,
              );
              const model =
                byRef.get(row.modelRef) ?? unknownPriceModel(row.modelRef as ModelInfo['ref']);
              if (
                !isPaidAccordingToRouter(model, provider, routing.trialOptInProviders) ||
                provider?.billingEnabled === true
              )
                return false;
              return (
                (profile.paidConfirmation.confirmSubscriptions &&
                  (provider?.tag === 'subscription_oauth' ||
                    provider?.tag === 'subscription_cli')) ||
                (profile.paidConfirmation.confirmTrials &&
                  (provider?.tag === 'trial' || provider?.tag === 'credits'))
              );
            });
            const amount = (rows: typeof usage) =>
              rows.reduce((sum, row) => {
                if (row.costUsd !== undefined) return sum + row.costUsd;
                const model = byRef.get(row.modelRef);
                if (!model) return sum + 0.01;
                return (
                  sum +
                  estimateSpend(
                    {
                      inputTokens: row.inputTokens ?? 0,
                      outputTokens: row.outputTokens ?? 0,
                      cachedTokens: row.cachedTokens ?? 0,
                    },
                    model,
                    services.providers.get(model.providerId),
                  ).amountUsd
                );
              }, 0);
            const now = services.clock.now();
            const today = now.toISOString().slice(0, 10);
            const thisMonth = today.slice(0, 7);
            const profileSessionIds = new Set<string>(
              services.sessions
                .list()
                .filter((item) => item.profileId === profile.id)
                .map((item) => item.id),
            );
            const profileRows = paidRows.filter((row) =>
              row.sessionId ? profileSessionIds.has(row.sessionId) : false,
            );
            const sessionRows = paidRows.filter((row) => row.sessionId === session.id);
            const reservations = [...paidReservations.values()];
            const sessionReservations = reservations.filter(
              (item) => item.sessionId === session.id,
            );
            const profileReservations = reservations.filter(
              (item) => item.profileId === profile.id,
            );
            const state: SpendState = {
              sessionUsd:
                amount(sessionRows) +
                sessionReservations.reduce((sum, item) => sum + item.amountUsd, 0),
              dayUsd:
                amount(paidRows.filter((row) => row.occurredAt.slice(0, 10) === today)) +
                reservations
                  .filter((item) => item.day === today)
                  .reduce((sum, item) => sum + item.amountUsd, 0),
              monthUsd:
                amount(paidRows.filter((row) => row.occurredAt.slice(0, 7) === thisMonth)) +
                reservations
                  .filter((item) => item.month === thisMonth)
                  .reduce((sum, item) => sum + item.amountUsd, 0),
              paidCallsThisSession:
                sessionRows.length + confirmationOnlyRows.length + sessionReservations.length,
            };
            const globalPaidCaps =
              typeof services.settings.get('global') === 'object' &&
              services.settings.get('global') !== null &&
              'paidCaps' in (services.settings.get('global') as object)
                ? (services.settings.get('global') as { paidCaps?: unknown }).paidCaps
                : undefined;
            const storedCaps = PaidCapsSchema.safeParse(globalPaidCaps);
            const globalCaps = storedCaps.success
              ? storedCaps.data
              : { sessionUsd: null, dailyUsd: null, monthlyUsd: null };
            const estimateSpendResult = monetaryPaid
              ? estimateSpend(
                  estimate,
                  candidate,
                  preflightCapacity.providers.find((item) => item.id === candidate.providerId),
                )
              : { amountUsd: 0, estimated: false };
            const amountUsd = estimateSpendResult.amountUsd;
            const profileState: SpendState = {
              ...state,
              dayUsd:
                amount(profileRows.filter((row) => row.occurredAt.slice(0, 10) === today)) +
                profileReservations
                  .filter((item) => item.day === today)
                  .reduce((sum, item) => sum + item.amountUsd, 0),
              monthUsd:
                amount(profileRows.filter((row) => row.occurredAt.slice(0, 7) === thisMonth)) +
                profileReservations
                  .filter((item) => item.month === thisMonth)
                  .reduce((sum, item) => sum + item.amountUsd, 0),
            };
            const globalOnlyProfile = {
              ...profile,
              caps: { sessionUsd: null, dailyUsd: null, monthlyUsd: null },
            };
            const sessionCap = tightestCap(profile.caps.sessionUsd ?? null, globalCaps.sessionUsd);
            const dailyCap = tightestCap(profile.caps.dailyUsd, globalCaps.dailyUsd);
            const monthlyCap = tightestCap(profile.caps.monthlyUsd, globalCaps.monthlyUsd);
            const reachedCap = [
              { used: state.sessionUsd, cap: sessionCap, period: 'this session' },
              { used: profileState.dayUsd, cap: dailyCap, period: 'today' },
              { used: profileState.monthUsd, cap: monthlyCap, period: 'this month' },
            ].find(({ used, cap }) => cap !== null && used + amountUsd > cap);
            if (
              monetaryPaid &&
              (!canSpend(
                profile,
                profileState,
                { sessionUsd: null, dayUsd: null, monthUsd: null },
                amountUsd,
              ) ||
                !canSpend(
                  globalOnlyProfile,
                  state,
                  {
                    sessionUsd: globalCaps.sessionUsd,
                    dayUsd: globalCaps.dailyUsd,
                    monthUsd: globalCaps.monthlyUsd,
                  },
                  amountUsd,
                ))
            ) {
              const limit = reachedCap?.cap ?? 0;
              const used = reachedCap?.used ?? state.sessionUsd;
              const period = reachedCap?.period ?? 'today';
              return {
                allowed: false,
                message: `Paid cap reached: $${used.toFixed(2)} of $${limit.toFixed(2)} ${period}. Wait for free capacity, raise the cap in Settings, or stop.`,
              };
            }
            const reservationId = monetaryPaid || laneNeedsConfirmation ? newId('usage') : null;
            if (reservationId)
              paidReservations.set(reservationId, {
                sessionId: session.id,
                profileId: profile.id,
                modelRef: candidate.ref,
                amountUsd,
                day: today,
                month: thisMonth,
              });
            const firstPaidCallNeedsConfirmation =
              monetaryPaid &&
              profile.paidAllowed &&
              !profile.paidConfirmation.preauthorize &&
              state.paidCallsThisSession === 0;
            if (
              firstPaidCallNeedsConfirmation ||
              (laneNeedsConfirmation &&
                !profile.paidConfirmation.preauthorize &&
                state.paidCallsThisSession === 0)
            ) {
              const selectedProvider = preflightCapacity.providers.find(
                (item) => item.id === candidate.providerId,
              );
              // This card is only shown for paid calls, so a "free models" provider label is always misleading here.
              const paidProviderLabel = selectedProvider?.name.replace(/\s+free models?$/i, '');
              const providerName =
                paidProviderLabel === undefined || paidProviderLabel === ''
                  ? candidate.providerId
                  : paidProviderLabel;
              const assistant = [...services.messages.list()]
                .reverse()
                .find((item) => item.sessionId === session.id && item.role === 'assistant');
              if (!assistant) {
                if (reservationId) paidReservations.delete(reservationId);
                return { allowed: false, message: 'Could not show paid approval.' };
              }
              const part: Extract<MessagePart, { type: 'approval_request' }> = {
                type: 'approval_request',
                id: PartIdSchema.parse(newId('part')),
                kind: 'paid_model',
                summary: `Use ${candidate.name} from ${providerName} for an estimated $${amountUsd.toFixed(4)}?`,
                detail: estimateSpendResult.estimated
                  ? 'Estimated with Ferry’s conservative unknown-price allowance.'
                  : `Estimated cost for ${estimate.inputTokens.toLocaleString()} input and ${estimate.outputTokens.toLocaleString()} output tokens.`,
                risk: 'medium',
                state: 'pending',
              };
              const key = `${session.id}:${part.id}`;
              const pendingDecision = new Promise<'allowed_once' | 'allowed_always' | 'denied'>(
                (resolve) => {
                  if (signal.aborted) {
                    resolve('denied');
                    return;
                  }
                  approvals.set(key, resolve);
                  signal.addEventListener(
                    'abort',
                    () => {
                      approvals.delete(key);
                      resolve('denied');
                    },
                    { once: true },
                  );
                },
              );
              store.appendPart(session.id, assistant.id, part);
              host.emit('session.part', { sessionId: session.id, messageId: assistant.id, part });
              const current = services.sessions.get(session.id);
              if (current) updateSession({ ...current, status: 'awaiting_approval' });
              const decision = await pendingDecision;
              const currentAfterApproval = services.sessions.get(session.id);
              if (currentAfterApproval?.status === 'awaiting_approval')
                updateSession({ ...currentAfterApproval, status: 'running' });
              if (decision === 'denied') {
                if (reservationId) paidReservations.delete(reservationId);
                return { allowed: false, message: 'Paid call declined. No paid request was sent.' };
              }
            }
            return {
              allowed: true,
              ...(reservationId
                ? {
                    usageId: reservationId,
                    release: () => paidReservations.delete(reservationId),
                  }
                : {}),
            };
          },
          onUsage: (record) => {
            const model = availableModels.find((item) => item.ref === record.modelRef);
            const usageProvider = preflightCapacity.providers.find(
              (item) => item.id === record.providerId,
            );
            const confirmationOnlyLane =
              usageProvider?.billingEnabled !== true &&
              (usageProvider?.tag === 'subscription_oauth' ||
                usageProvider?.tag === 'subscription_cli' ||
                usageProvider?.tag === 'trial' ||
                usageProvider?.tag === 'credits');
            const usageModel = model ?? unknownPriceModel(record.modelRef as ModelInfo['ref']);
            const routerSaysPaid = isPaidAccordingToRouter(
              usageModel,
              usageProvider,
              routing.trialOptInProviders,
            );
            const monetaryPaid =
              routerSaysPaid && (!confirmationOnlyLane || usageProvider.billingEnabled === true);
            const reservation = paidReservations.get(record.id);
            const calculated =
              !monetaryPaid || confirmationOnlyLane
                ? { amountUsd: 0, estimated: false }
                : model
                  ? estimateSpend(
                      {
                        inputTokens: record.inputTokens ?? 0,
                        outputTokens: record.outputTokens ?? 0,
                        cachedTokens: record.cachedTokens ?? 0,
                      },
                      model,
                      usageProvider,
                    )
                  : { amountUsd: 0.01, estimated: true };
            const priced =
              monetaryPaid && calculated.amountUsd <= 0 && reservation && reservation.amountUsd > 0
                ? { amountUsd: reservation.amountUsd, estimated: true }
                : calculated;
            runtime.usage.record({
              ...record,
              costUsd: priced.amountUsd,
              ...(priced.estimated
                ? {
                    headers: {
                      costEstimate:
                        calculated.estimated && calculated.amountUsd > 0
                          ? 'conservative-unknown-price'
                          : 'approved-preflight-estimate',
                    },
                  }
                : {}),
            });
          },
          onHandoff: (reason) => {
            runtime.gateway.recordHandoff(session.id, reason);
          },
          resolveCandidates: (selectedProfile, stepKind, inputTokens) =>
            runtime.gateway.resolveCandidates(selectedProfile, stepKind, inputTokens),
          emit: emitAgentEvent,
          requestApproval: (part, signal) =>
            new Promise((resolve) => {
              const approvalKey = `${session.id}:${part.id}`;
              if (signal.aborted) {
                resolve('denied');
                return;
              }
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
          filterOutput: async (name, output, command, sourcePath) => {
            const { optimizeOutput } = await import('@ferry/optimizer');
            const result = optimizeOutput(command ?? name, output);
            if (sourcePath && isProtectedWorkspacePath(sourcePath))
              return { text: result.output, filtered: result.output !== output };
            const handle = result.output === output ? undefined : newId('recovery');
            if (handle)
              services.db.client
                .prepare('INSERT INTO optimizer_blobs (id,data_json,updated_at) VALUES (?,?,?)')
                .run(
                  handle,
                  JSON.stringify({
                    id: handle,
                    sessionId: session.id,
                    workspaceId: session.workspaceId,
                    ...(sourcePath ? { sourcePath } : {}),
                    ...(command ? { command } : {}),
                    content: output,
                  }),
                  services.clock.now().toISOString(),
                );
            return {
              text: result.output,
              filtered: result.output !== output,
              ...(handle ? { recoveryHandle: handle } : {}),
            };
          },
          readRecovery: async (handle) => {
            const row = services.db.client
              .prepare('SELECT data_json FROM optimizer_blobs WHERE id=?')
              .get(handle) as { data_json: string } | undefined;
            if (!row) return undefined;
            try {
              const blob = JSON.parse(row.data_json) as {
                sessionId?: string;
                workspaceId?: string;
                sourcePath?: string;
                command?: string;
                content?: string;
              };
              if (
                blob.sessionId !== session.id ||
                (blob.workspaceId !== undefined && blob.workspaceId !== session.workspaceId) ||
                isProtectedWorkspacePath(blob.sourcePath ?? '') ||
                blob.command?.split(/[\s"'`|&;<>()[\]]+/).some(isProtectedWorkspacePath)
              )
                return undefined;
              if (blob.sourcePath !== undefined) {
                try {
                  await new WorkspaceJail(workspace.path).resolve(blob.sourcePath);
                } catch {
                  return undefined;
                }
              }
              return blob.content;
            } catch {
              return undefined;
            }
          },
        });
        void loop
          .run({ sessionId: session.id, signal: controller.signal, resume: resume === true })
          .catch((error: unknown) => {
            if (!controller.signal.aborted)
              services.logger.error(
                { error: compactAgentError(error), sessionId: session.id },
                'Agent session failed',
              );
          })
          .finally(async () => {
            await mcpManager.dispose().catch((error: unknown) => {
              services.logger.warn({ err: error, sessionId: session.id }, 'MCP disposal failed');
            });
            controllers.delete(session.id);
            runPromises.delete(session.id);
            if (!shuttingDown) {
              const latest = services.sessions.get(session.id);
              if (latest?.inFlight)
                updateSession({
                  ...latest,
                  status: latest.status === 'running' ? 'idle' : latest.status,
                  inFlight: false,
                });
              else if (latest?.status === 'running') updateSession({ ...latest, status: 'idle' });
              else if (latest?.status === 'idle') {
                host.emit('session.updated', latest);
                host.emit('session.status', latest);
              }
            }
            resolveRun();
          });
      } catch (error) {
        controllers.delete(session.id);
        runPromises.delete(session.id);
        const latest = services.sessions.get(session.id);
        if (latest?.inFlight) updateSession({ ...latest, status: 'error', inFlight: false });
        resolveRun();
        throw error;
      }
    },
    async resume(rawId: unknown, rawOptions?: unknown) {
      const session = requireSession(rawId);
      if (session.status !== 'interrupted')
        throw rpcDomainError(-32010, 'conflict', 'Only an interrupted session can be resumed');
      const options = z
        .object({ retryInterruptedTool: z.boolean().optional() })
        .parse(rawOptions ?? {});
      const detail = store.load(session.id);
      if (!detail) throw rpcDomainError(-32044, 'not_found', `Session not found: ${session.id}`);
      const interruptedTools = detail.messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === 'tool_call' && part.status === 'running');
      if (interruptedTools.length && !options.retryInterruptedTool) {
        const toolNames = interruptedTools
          .map((part) => (part.type === 'tool_call' ? part.title : ''))
          .join(', ');
        throw rpcDomainError(
          -32010,
          'conflict',
          `Interrupted while ${toolNames} was running. Confirm before retrying this tool.`,
        );
      }
      for (const part of interruptedTools) {
        if (part.type !== 'tool_call') continue;
        const failed = {
          ...part,
          status: 'failed' as const,
          output: {
            text: 'The core stopped before a result was saved. The user confirmed this tool may be retried.',
            filtered: false,
            originalTokens: null,
            filteredTokens: null,
            recoveryHandle: null,
          },
        };
        const updated = store.replacePart(session.id, failed);
        if (updated)
          host.emit('session.part', { sessionId: session.id, messageId: updated.id, part: failed });
      }
      const lastUser = [...detail.messages].reverse().find((message) => message.role === 'user');
      const prompt = lastUser?.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(' ')
        .trim();
      if (!prompt)
        throw rpcDomainError(
          -32010,
          'conflict',
          'This session has no durable user prompt to resume',
        );
      await host.dispatch({
        jsonrpc: '2.0',
        id: 'resume',
        method: 'sessions.send',
        params: [session.id, { text: prompt, resume: true }],
      });
    },
    async cancel(rawId: unknown) {
      const session = requireSession(rawId);
      const run = runPromises.get(session.id);
      if (!run) {
        updateSession({ ...session, status: 'idle' });
        return;
      }
      controllers.get(session.id)?.abort();
      await run;
      if (!shuttingDown) {
        const latest = services.sessions.get(session.id);
        if (latest) updateSession({ ...latest, status: 'idle' });
      }
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
      if (target.kind === 'paid_model' && decision === 'allow_always')
        throw rpcDomainError(-32010, 'conflict', 'Paid calls can only be approved once.');
      if (target.state !== 'pending')
        throw rpcDomainError(-32010, 'conflict', `Approval is already resolved: ${partId}`);
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

function stricterPermissionMode(
  user: 'ask' | 'auto_edit' | 'full_auto',
  project: 'ask' | 'auto_edit' | 'full_auto',
): 'ask' | 'auto_edit' | 'full_auto' {
  const rank = { ask: 0, auto_edit: 1, full_auto: 2 } as const;
  return rank[user] <= rank[project] ? user : project;
}

function hasOwnProperty(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, key);
}

function compactAgentError(error: unknown): string {
  if (!error || typeof error !== 'object')
    return typeof error === 'string' ? error.slice(0, 240) : 'Agent run failed';
  const candidate = error as {
    message?: unknown;
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  const status = Number(
    candidate.statusCode ?? candidate.status ?? candidate.response?.status ?? 0,
  );
  const message =
    typeof candidate.message === 'string'
      ? candidate.message.replace(/[\r\n]+/g, ' ').slice(0, 240)
      : 'Agent run failed';
  return status > 0 ? `HTTP ${String(status)} — ${message}` : message;
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
