import {
  CliConnectionSchema,
  SettingsSchema,
  redactKnownSecretText,
  type CliConnection,
  type CliConnectionKind,
  type CliConnectionSettings,
  type CliConnectionSettingsPatch,
  type CliEffort,
  type CliOptionPatch,
  type CliSpeed,
  type CliUsageSnapshot,
  type Settings,
} from '@ferry/shared';
import { discoverCliConnection, discoverCliUsage, type CliUsageRefresh } from '@ferry/delegate';
import { DEFAULT_SETTINGS } from '@ferry/config';
import type { FerryServices } from './services.js';
import { rpcDomainError } from './host.js';

const KINDS: readonly CliConnectionKind[] = ['codex-cli', 'claude-code-cli', 'opencode-cli'];
/** Install/model/version/account metadata TTL. */
export const MODEL_TTL_MS = 10 * 60_000;
/** Visible usage TTL. */
export const USAGE_TTL_MS = 60_000;
/** Maximum simultaneous discovery probes across every background and explicit call. */
export const DISCOVERY_CONCURRENCY = 2;
const STORE_KEY = 'cli-connections';

const installHints: Record<CliConnectionKind, string> = {
  'codex-cli': 'Install the Codex CLI, then run codex login to sign in.',
  'claude-code-cli': 'Install Claude Code, then run claude auth login to sign in.',
  'opencode-cli': 'Install OpenCode, then run opencode auth login for your chosen provider.',
};

const upstreamLabels: Record<CliConnectionKind, string> = {
  'codex-cli': 'ChatGPT',
  'claude-code-cli': 'Claude',
  'opencode-cli': 'OpenCode Zen',
};

type EmitEvent = (method: string, payload: unknown) => void;
type ScanFn = (kind: CliConnectionKind) => Promise<CliConnection>;
type UsageFn = (kind: CliConnectionKind, connection: CliConnection) => Promise<CliUsageRefresh>;

/**
 * Per-services host event target. The CLI broker/service are sometimes constructed *first* by a
 * call site that has no host emit yet (e.g. the Gateway controller registers before the
 * `cliConnections` domain). This stable holder lets a later explicit host registration replace that
 * placeholder emit so future RPC updates are never dropped, while a later NoOp call can never
 * overwrite a real target or leak a listener.
 */
const emitHolders = new WeakMap<FerryServices, { fn: EmitEvent }>();

/** Bind a placeholder target only when none exists yet; never replaces an existing target. */
export function bindCliEmit(services: FerryServices, emit: EmitEvent): void {
  if (!emitHolders.has(services)) emitHolders.set(services, { fn: emit });
}

/** Explicitly (re)bind the real host event target for a services instance. */
export function registerCliEmit(services: FerryServices, emit: EmitEvent): void {
  const holder = emitHolders.get(services);
  if (holder) holder.fn = emit;
  else emitHolders.set(services, { fn: emit });
}

/** Resolve the current host event target, defaulting to an inert no-op. */
export function cliEmitFor(services: FerryServices): EmitEvent {
  return emitHolders.get(services)?.fn ?? (() => undefined);
}

export interface CliConnectionServiceOptions {
  /** Full install/model/account scan. Defaults to the real installed-CLI discovery. */
  scan?: ScanFn;
  /** Usage-only refresh against a cached connection. Defaults to the real usage probe. */
  usage?: UsageFn;
  /** Injectable clock (epoch ms) for deterministic TTL tests. */
  now?: () => number;
}

interface KindRecord {
  connection: CliConnection | null;
  /** Epoch ms of the last successful install/model scan; 0 when never scanned this process. */
  modelCheckedAt: number;
  /** Epoch ms of the last usage check (full scan or usage-only refresh). */
  usageCheckedAt: number;
}

const servicesIndex = new WeakMap<FerryServices, CliConnectionService>();

/** Lazily construct the per-services cached CLI connection service. */
export function getCliConnectionService(
  services: FerryServices,
  emit: EmitEvent,
): CliConnectionService {
  let service = servicesIndex.get(services);
  if (!service) {
    bindCliEmit(services, emit);
    service = new CliConnectionService(services, emit, {
      ...(services.cliScan ? { scan: services.cliScan } : {}),
      ...(services.cliUsage ? { usage: services.cliUsage } : {}),
    });
    servicesIndex.set(services, service);
  }
  return service;
}

function placeholder(kind: CliConnectionKind): CliConnection {
  return {
    id: kind,
    kind,
    providerId: kind,
    upstreamLabel: upstreamLabels[kind],
    install: { installed: false, executable: null, version: null, installHint: installHints[kind] },
    account: { state: 'not_checked', key: null, label: null, plan: null },
    verify: { state: 'unverified', modelRef: null, checkedAt: null, message: null },
    surfaces: { native: false, gateway: false },
    models: [],
    usage: {
      connectionId: kind,
      accountKey: null,
      state: 'unavailable',
      source: 'cli',
      observedAt: null,
      staleAt: null,
      windows: [],
      note: 'Detection is pending.',
    },
    lastChecked: null,
    discoveryMessage: 'This installed CLI has not been checked yet. Refresh to detect it.',
  };
}

/** Bounded counting semaphore; `maxActive` records the peak for overlap assertions. */
class Semaphore {
  #available: number;
  readonly #queue: (() => void)[] = [];
  active = 0;
  maxActive = 0;
  constructor(limit: number) {
    this.#available = limit;
  }
  async acquire(): Promise<() => void> {
    if (this.#available > 0) this.#available -= 1;
    else await new Promise<void>((resolve) => this.#queue.push(resolve));
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.#queue.shift();
      if (next) next();
      else this.#available += 1;
    };
  }
}

/**
 * Core-owned cached installed-CLI connection state. Snapshots are served immediately from an
 * in-memory cache persisted through the existing settings JSON, while bounded fresh discovery runs
 * in the background. A single global semaphore caps simultaneous probes at two, and each kind is
 * serialized so a scan and a usage refresh for the same connection never overlap. Discovery never
 * enables eligibility and never marks generation verified.
 */
export class CliConnectionService {
  readonly #records = new Map<CliConnectionKind, KindRecord>();
  readonly #semaphore = new Semaphore(DISCOVERY_CONCURRENCY);
  readonly #scanInflight = new Map<CliConnectionKind, Promise<void>>();
  readonly #usageInflight = new Map<CliConnectionKind, Promise<void>>();
  #background: Promise<void> | undefined;
  readonly #scan: ScanFn;
  readonly #usage: UsageFn;
  readonly #now: () => number;
  readonly #emit: EmitEvent;

  constructor(
    private readonly services: FerryServices,
    emit: EmitEvent,
    options: CliConnectionServiceOptions = {},
  ) {
    this.#scan =
      options.scan ?? ((kind) => discoverCliConnection(kind, { environment: services.env }));
    this.#usage =
      options.usage ??
      ((kind, connection) => discoverCliUsage(connection, { environment: services.env }));
    this.#now = options.now ?? (() => Date.now());
    // Prefer the shared holder (a real host target registered later always wins) and fall back to the
    // constructor-supplied emit for direct construction in unit tests.
    this.#emit = (method, payload) => {
      const holder = emitHolders.get(services);
      (holder?.fn ?? emit)(method, payload);
    };
    this.#load();
  }

  #load(): void {
    const saved = this.services.settings.get(STORE_KEY);
    if (!Array.isArray(saved)) return;
    for (const value of saved) {
      const parsed = CliConnectionSchema.safeParse(value);
      if (parsed.success)
        this.#records.set(parsed.data.kind, {
          connection: parsed.data,
          // Cached snapshots show immediately; timestamps reset so the next list refreshes.
          modelCheckedAt: 0,
          usageCheckedAt: 0,
        });
    }
  }

  #persist(): void {
    this.services.settings.put(
      STORE_KEY,
      KINDS.map((kind) => this.#records.get(kind)?.connection).filter(
        (connection): connection is CliConnection => Boolean(connection),
      ),
    );
  }

  /**
   * Read the global settings block. A missing store uses the public `DEFAULT_SETTINGS` fallback
   * (non-destructive: nothing is written here) so a fresh data dir needs no bootstrap/ordering
   * prerequisite. A present-but-invalid record is reported as corrupt rather than silently replaced.
   */
  #readGlobalSettings(): { settings: Settings; missing: boolean } | null {
    const raw = this.services.settings.get('global');
    if (raw === undefined || raw === null)
      return { settings: SettingsSchema.parse(DEFAULT_SETTINGS), missing: true };
    const parsed = SettingsSchema.safeParse(raw);
    return parsed.success ? { settings: parsed.data, missing: false } : null;
  }

  #settingsRecord(): Record<string, CliConnectionSettings> {
    const read = this.#readGlobalSettings();
    return read ? read.settings.cliConnections : {};
  }

  #surfacesFor(kind: CliConnectionKind): { native: boolean; gateway: boolean } {
    const saved = this.#settingsRecord()[kind];
    return { native: saved?.native ?? false, gateway: saved?.gateway ?? false };
  }

  #snapshot(): CliConnection[] {
    return KINDS.map((kind) => ({
      ...(this.#records.get(kind)?.connection ?? placeholder(kind)),
      surfaces: this.#surfacesFor(kind),
    }));
  }

  /** Immediate cached snapshot; schedules a bounded background refresh when stale or empty. */
  list(): CliConnection[] {
    if (this.#hasStale()) this.#scheduleBackground();
    return this.#snapshot();
  }

  /** Immediate cached snapshot without scheduling any background discovery. */
  snapshot(): CliConnection[] {
    return this.#snapshot();
  }

  /**
   * Apply a verification receipt produced by the broker (successful or failed). Discovery, account,
   * usage and install state are untouched; only the verify block changes and is persisted.
   */
  applyVerification(kind: CliConnectionKind, verify: CliConnection['verify']): CliConnection {
    const record = this.#records.get(kind);
    const connection: CliConnection = {
      ...(record?.connection ?? placeholder(kind)),
      verify: { ...verify },
    };
    this.#records.set(kind, {
      connection,
      modelCheckedAt: record?.modelCheckedAt ?? 0,
      usageCheckedAt: record?.usageCheckedAt ?? 0,
    });
    this.#persist();
    this.#emitConnection(kind, connection);
    return connection;
  }

  /**
   * Bounded fresh full scan (install + models + account + usage) for the requested kinds, joining
   * any already-running scan for the same kind and waiting out an in-flight usage probe so the same
   * connection is never probed twice at once. Only the requested kinds' TTLs are refreshed.
   */
  async refresh(id?: CliConnectionKind): Promise<CliConnection[]> {
    const kinds = id ? [id] : [...KINDS];
    await Promise.all(kinds.map((kind) => this.#runScan(kind)));
    return this.#snapshot();
  }

  /** Persist surface opt-ins and per-model option defaults; discovery state is untouched. */
  update(id: CliConnectionKind, patch: CliConnectionSettingsPatch): CliConnection {
    const read = this.#readGlobalSettings();
    if (!read)
      throw rpcDomainError(
        -32010,
        'validation',
        'The stored settings are corrupted. Repair or reset Settings before changing CLI connections.',
      );
    const current = read.settings.cliConnections[id];
    const defaultOptions = patch.defaultOptions;
    const effort: CliEffort | null =
      defaultOptions && 'effort' in defaultOptions
        ? // An explicit `null` clears the stored override; an absent field preserves it.
          (defaultOptions.effort ?? null)
        : (current?.defaultOptions.effort ?? null);
    const speed: CliSpeed = defaultOptions?.speed ?? current?.defaultOptions.speed ?? 'standard';
    this.#assertOption(id, { effort, speed });
    const modelDefaults = patch.modelDefaults ?? current?.modelDefaults ?? {};
    for (const [modelRef, options] of Object.entries(modelDefaults)) {
      const effortValue = 'effort' in options ? (options.effort ?? null) : undefined;
      this.#assertOption(id, {
        ...(effortValue === undefined ? {} : { effort: effortValue }),
        ...(options.speed === undefined ? {} : { speed: options.speed }),
        modelRef,
      });
    }
    const credentialMode =
      patch.credentialMode ?? current?.credentialMode ?? ('installed' as const);
    const credentialProvider =
      'credentialProvider' in patch
        ? (patch.credentialProvider ?? null)
        : (current?.credentialProvider ?? null);
    const merged: CliConnectionSettings = {
      native: patch.surfaces?.native ?? current?.native ?? false,
      gateway: patch.surfaces?.gateway ?? current?.gateway ?? false,
      credentialMode,
      credentialProvider,
      defaultOptions: { effort, speed },
      modelDefaults,
    };
    const settings = SettingsSchema.parse({
      ...read.settings,
      cliConnections: { ...read.settings.cliConnections, [id]: merged },
    });
    this.services.settings.put('global', settings);
    // A credential selection change invalidates any existing verification immediately, so the
    // stale receipt and an updated event are published now rather than on a later broker read.
    const credentialChanged =
      (current?.credentialMode ?? 'installed') !== credentialMode ||
      (current?.credentialProvider ?? null) !== credentialProvider;
    if (credentialChanged) {
      const record = this.#records.get(id);
      const verified = record?.connection;
      if (verified?.verify.state === 'verified') {
        const verify: CliConnection['verify'] = {
          state: 'stale',
          modelRef: verified.verify.modelRef,
          checkedAt: verified.verify.checkedAt,
          message: 'The CLI credential selection changed; verify again.',
          receiptKey: null,
        };
        this.#records.set(id, {
          connection: { ...verified, verify },
          modelCheckedAt: record?.modelCheckedAt ?? 0,
          usageCheckedAt: record?.usageCheckedAt ?? 0,
        });
        this.#persist();
      }
    }
    const connection = this.#snapshot().find((entry) => entry.kind === id) ?? placeholder(id);
    this.#emit('settings.updated', settings);
    this.#emit('cliConnections.updated', connection);
    return connection;
  }

  /**
   * Apply a transport-observed live usage snapshot to the cached connection. The account
   * identity/label from discovery is preserved (a usage stream never authorizes a logout), only the
   * usage block changes, and the update is published through the same stable host target.
   */
  applyUsage(connectionId: CliConnectionKind, snapshot: CliUsageSnapshot): CliConnection {
    const record = this.#records.get(connectionId);
    const connection: CliConnection = {
      ...(record?.connection ?? placeholder(connectionId)),
      usage: { ...snapshot, connectionId },
    };
    this.#records.set(connectionId, {
      connection,
      modelCheckedAt: record?.modelCheckedAt ?? 0,
      usageCheckedAt: this.#now(),
    });
    this.#persist();
    this.#emitConnection(connectionId, connection);
    return connection;
  }

  /** Resolve in-flight background work; used by coordinators and deterministic tests. */
  async settle(): Promise<void> {
    while (this.#background) {
      const current = this.#background;
      await current;
      if (this.#background === current) break;
    }
    await Promise.all([...this.#scanInflight.values(), ...this.#usageInflight.values()]);
  }

  /** Peak simultaneous probes observed so far (diagnostics/tests). */
  peakConcurrency(): number {
    return this.#semaphore.maxActive;
  }

  #discoveredModels(kind: CliConnectionKind) {
    const connection = this.#records.get(kind)?.connection;
    if (!connection || connection.models.length === 0) return null;
    return connection.models;
  }

  #assertOption(kind: CliConnectionKind, option: CliOptionPatch & { modelRef?: string }): void {
    const models = this.#discoveredModels(kind);
    // No discovered models yet: accept and let phase 2 request-time validation be authoritative.
    if (models === null) return;
    const scoped = option.modelRef
      ? models.filter((model) => model.ref === option.modelRef)
      : models;
    if (option.modelRef && scoped.length === 0)
      throw rpcDomainError(-32010, 'validation', `Unknown model ${option.modelRef} for ${kind}.`);
    if (option.effort !== undefined && option.effort !== null) {
      const supported = new Set(scoped.flatMap((model) => model.efforts));
      if (!supported.has(option.effort))
        throw rpcDomainError(
          -32010,
          'validation',
          `${option.effort} is not a supported effort for ${option.modelRef ?? kind}.`,
        );
    }
    if (option.speed !== undefined) {
      const supported = new Set(scoped.flatMap((model) => model.speeds));
      if (!supported.has(option.speed))
        throw rpcDomainError(
          -32010,
          'validation',
          `${option.speed} is not a supported speed for ${option.modelRef ?? kind}.`,
        );
    }
  }

  #hasStale(): boolean {
    return KINDS.some((kind) => this.#needsScan(kind) || this.#needsUsage(kind));
  }

  #needsScan(kind: CliConnectionKind): boolean {
    const record = this.#records.get(kind);
    if (!record?.connection) return true;
    return this.#now() - record.modelCheckedAt > MODEL_TTL_MS;
  }

  #needsUsage(kind: CliConnectionKind): boolean {
    const record = this.#records.get(kind);
    if (!record?.connection) return false;
    // Unsupported/unknown usage is not polled every minute; explicit refresh re-checks it.
    if (record.connection.usage.state === 'unavailable') return false;
    return this.#now() - record.usageCheckedAt > USAGE_TTL_MS;
  }

  #scheduleBackground(): void {
    if (this.#background) return;
    const work = (async () => {
      await Promise.all(
        KINDS.filter((kind) => this.#needsScan(kind)).map((kind) => this.#runScan(kind)),
      );
      await Promise.all(
        KINDS.filter((kind) => this.#needsUsage(kind)).map((kind) => this.#runUsage(kind)),
      );
    })();
    const tracked = work
      .catch(() => undefined)
      .finally(() => {
        if (this.#background === tracked) this.#background = undefined;
      });
    this.#background = tracked;
  }

  #runScan(kind: CliConnectionKind): Promise<void> {
    const existing = this.#scanInflight.get(kind);
    if (existing) return existing;
    const promise = (async () => {
      // Serialize against an in-flight usage probe for the same connection (no double probing).
      const usage = this.#usageInflight.get(kind);
      if (usage) await usage;
      const release = await this.#semaphore.acquire();
      try {
        await this.#doScan(kind);
      } finally {
        release();
      }
    })();
    this.#scanInflight.set(kind, promise);
    return promise.finally(() => {
      if (this.#scanInflight.get(kind) === promise) this.#scanInflight.delete(kind);
    });
  }

  #runUsage(kind: CliConnectionKind): Promise<void> {
    // A full scan is a superset of a usage refresh; share it instead of probing twice.
    const scan = this.#scanInflight.get(kind);
    if (scan) return scan;
    const existing = this.#usageInflight.get(kind);
    if (existing) return existing;
    const promise = (async () => {
      const release = await this.#semaphore.acquire();
      try {
        await this.#doUsage(kind);
      } finally {
        release();
      }
    })();
    this.#usageInflight.set(kind, promise);
    return promise.finally(() => {
      if (this.#usageInflight.get(kind) === promise) this.#usageInflight.delete(kind);
    });
  }

  async #doScan(kind: CliConnectionKind): Promise<void> {
    const previous = this.#records.get(kind);
    let discovered: CliConnection;
    try {
      discovered = await this.#scan(kind);
    } catch (error) {
      const message = redactKnownSecretText(
        error instanceof Error ? error.message : 'CLI discovery failed',
      );
      const base = previous?.connection ?? placeholder(kind);
      discovered = {
        ...base,
        verify: {
          state: base.verify.state === 'verified' ? 'stale' : 'failed',
          modelRef: base.verify.modelRef,
          checkedAt: base.verify.checkedAt,
          message,
        },
        lastChecked: new Date(this.#now()).toISOString(),
        discoveryMessage: message,
      };
      this.#records.set(kind, {
        connection: discovered,
        // Back off until the next TTL window instead of retrying immediately.
        modelCheckedAt: this.#now(),
        usageCheckedAt: this.#now(),
      });
      this.#persist();
      this.#emitConnection(kind, discovered);
      return;
    }
    const next = this.#reconcileScan(previous?.connection ?? null, discovered);
    this.#records.set(kind, {
      connection: next,
      modelCheckedAt: this.#now(),
      usageCheckedAt: this.#now(),
    });
    this.#persist();
    this.#emitConnection(kind, next);
  }

  /**
   * Merge a fresh scan with the previous cached connection. Verification survives an unchanged
   * account/version/capability refresh, and is invalidated when auth, install, capabilities or the
   * verified model's availability change.
   */
  #reconcileScan(previous: CliConnection | null, discovered: CliConnection): CliConnection {
    if (!previous) return discovered;
    const accountChanged =
      previous.account.state !== discovered.account.state ||
      previous.account.key !== discovered.account.key;
    const installChanged =
      previous.install.installed !== discovered.install.installed ||
      previous.install.executable !== discovered.install.executable ||
      previous.install.version !== discovered.install.version;
    // Only account/auth or install/version changes invalidate every receipt. Per-model capability
    // changes (adding/changing an unrelated model) are handled per model by the broker's receipt
    // revalidation, so a successful receipt for an unchanged model survives an unrelated scan.
    const invalidated = accountChanged || installChanged;
    const usage =
      accountChanged || installChanged
        ? {
            ...discovered.usage,
            state:
              discovered.usage.state === 'available' ? ('stale' as const) : discovered.usage.state,
          }
        : discovered.usage;
    if (!invalidated && previous.verify.state === 'verified') {
      const discoveredRefs = new Set<string>(discovered.models.map((model) => model.ref));
      // Keep every accumulated receipt whose model is still discovered; only the receipts for models
      // that vanished are dropped. An unrelated model change never invalidates the survivors.
      if (previous.verify.modelReceipts) {
        const kept = Object.fromEntries(
          Object.entries(previous.verify.modelReceipts).filter(([ref]) => discoveredRefs.has(ref)),
        );
        if (Object.keys(kept).length > 0)
          return {
            ...discovered,
            usage,
            verify: { ...previous.verify, modelReceipts: kept },
          };
      } else if (
        previous.verify.modelRef === null ||
        discoveredRefs.has(previous.verify.modelRef)
      ) {
        return { ...discovered, usage, verify: previous.verify };
      }
    }
    return { ...discovered, usage };
  }

  async #doUsage(kind: CliConnectionKind): Promise<void> {
    const record = this.#records.get(kind);
    if (!record?.connection) return;
    const previous = record.connection;
    let result: CliUsageRefresh;
    try {
      result = await this.#usage(kind, previous);
    } catch (error) {
      const message = redactKnownSecretText(
        error instanceof Error ? error.message : 'CLI usage refresh failed',
      );
      result = {
        account: null,
        usage: {
          ...previous.usage,
          state: 'stale',
          staleAt: new Date(this.#now()).toISOString(),
          note: message,
        },
      };
    }
    let connection: CliConnection = { ...previous, usage: result.usage };
    if (result.account !== null) {
      // Authoritative account evidence: replace the whole account so a new key never inherits the
      // old label/plan, and invalidate verification when the identity actually changed.
      const changed =
        previous.account.state !== result.account.state ||
        previous.account.key !== result.account.key;
      connection = {
        ...connection,
        account: { ...result.account },
        ...(changed
          ? {
              verify: {
                state: 'unverified' as const,
                modelRef: null,
                checkedAt: null,
                message: null,
              },
            }
          : {}),
      };
    }
    // When `account` is null the probe could not vouch for identity (unavailable/error): keep the
    // previous account label/plan/key untouched rather than publishing a false logout.
    this.#records.set(kind, { ...record, connection, usageCheckedAt: this.#now() });
    this.#persist();
    this.#emitConnection(kind, connection);
  }

  #emitConnection(kind: CliConnectionKind, connection: CliConnection): void {
    this.#emit('cliConnections.updated', { ...connection, surfaces: this.#surfacesFor(kind) });
  }
}
