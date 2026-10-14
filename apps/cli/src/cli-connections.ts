import { isCliModelVerified, resolveCliOption } from '@ferry/shared';
import type {
  CliAuthState,
  CliBilling,
  CliConnection,
  CliConnectionKind,
  CliConnectionSettings,
  CliModelCapabilities,
  CliOption,
  CliSpeed,
  CliVerification,
  Profile,
} from '@ferry/shared';
import type { PickerOption } from './components/picker.js';

/**
 * Installed-CLI presentation helpers shared by the Ink panels and the non-interactive commands.
 *
 * Everything here reads the public `@ferry/shared` CLI connection snapshot, including the optional
 * native caps (`unsupportedEfforts`, `contextWindow`, `maxOutput`) that the public schema already
 * validates. Absent optional fields degrade to empty hints instead of being inferred.
 */

export const CLI_KINDS: readonly CliConnectionKind[] = [
  'codex-cli',
  'claude-code-cli',
  'opencode-cli',
];

export const CLI_BRAND_NAMES: Record<CliConnectionKind, string> = {
  'codex-cli': 'Codex CLI',
  'claude-code-cli': 'Claude Code CLI',
  'opencode-cli': 'OpenCode CLI',
};

export function cliBrandName(kind: CliConnectionKind): string {
  return CLI_BRAND_NAMES[kind];
}

export function isCliConnectionKind(value: string): value is CliConnectionKind {
  return (CLI_KINDS as readonly string[]).includes(value);
}

/** Filter modes offered by the `/model` picker. `included` must never be presented as `free`. */
export type CliModelFilterMode = 'all' | 'free' | 'included';

export const CLI_MODEL_FILTER_MODES: readonly CliModelFilterMode[] = ['free', 'included', 'all'];

export function cliModelFilterLabel(mode: CliModelFilterMode): string {
  return mode === 'free'
    ? 'Free'
    : mode === 'included'
      ? 'Included subscriptions'
      : 'All connected';
}

export function billingLabel(billing: CliBilling): string {
  switch (billing) {
    case 'free':
      return 'Free';
    case 'included_subscription':
      return 'Included subscription';
    case 'metered':
      return 'Metered';
    case 'unknown':
      return 'Billing unknown';
  }
}

export function authLabel(state: CliAuthState): string {
  switch (state) {
    case 'signed_in':
      return 'Signed in';
    case 'signed_out':
      return 'Signed out';
    case 'unknown':
      return 'Auth unknown';
    case 'not_checked':
      return 'Auth not checked';
  }
}

/** Only the *current* account: never reads native histories and never copies credentials. */
export function accountLabel(connection: CliConnection): string {
  const { account } = connection;
  if (!account.label)
    return `${authLabel(account.state)}${account.plan ? ` · ${account.plan}` : ''}`;
  return account.plan ? `${account.label} · ${account.plan}` : account.label;
}

const CLI_MODEL_PREFIX = 'cli-model:';

export function encodeCliModelValue(kind: CliConnectionKind, ref: string): string {
  return `${CLI_MODEL_PREFIX}${kind}:${ref}`;
}

export function decodeCliModelValue(
  value: string,
): { kind: CliConnectionKind; ref: string } | null {
  if (!value.startsWith(CLI_MODEL_PREFIX)) return null;
  const rest = value.slice(CLI_MODEL_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator < 1) return null;
  const kind = rest.slice(0, separator);
  const ref = rest.slice(separator + 1);
  return isCliConnectionKind(kind) && ref ? { kind, ref } : null;
}

export function findConnection(
  connections: readonly CliConnection[],
  kind: CliConnectionKind,
): CliConnection | undefined {
  return connections.find((connection) => connection.kind === kind);
}

export function findCliModel(
  connection: CliConnection | undefined,
  ref: string,
): CliModelCapabilities | undefined {
  return connection?.models.find((model) => model.ref === ref);
}

/* ------------------------------------------------------------------ optional native caps */

export interface NativeCapMetadata {
  /** Raw effort tokens the bridge reports as unsupported, mapped to a nonsecret reason. */
  unsupportedEfforts: Record<string, string>;
  contextWindow: number | null;
  maxOutput: number | null;
}

/**
 * Reads the optional native capability hints from the validated public schema. An older Core client
 * that predates the caps yields empty hints rather than a thrown error.
 */
export function nativeCapMetadata(model: CliModelCapabilities): NativeCapMetadata {
  return {
    unsupportedEfforts: model.unsupportedEfforts ?? {},
    contextWindow: model.contextWindow ?? null,
    maxOutput: model.maxOutput ?? null,
  };
}

export interface CliEffortChoice {
  token: string;
  unavailable: boolean;
  reason: string | null;
}

/**
 * Advertised effort tokens preserved verbatim. Tokens present in the optional bridge metadata are
 * kept visible but marked unavailable with the reported reason.
 */
export function cliEffortChoices(model: CliModelCapabilities): CliEffortChoice[] {
  const { unsupportedEfforts } = nativeCapMetadata(model);
  return model.efforts.map((token) => {
    const reported = Object.hasOwn(unsupportedEfforts, token)
      ? unsupportedEfforts[token]
      : undefined;
    const unavailable = reported !== undefined;
    return {
      token,
      unavailable,
      reason: unavailable ? (reported ? reported : 'Not supported by this model') : null,
    };
  });
}

export function cliEffortOptionRows(model: CliModelCapabilities): PickerOption[] {
  // No advertised effort tokens means effort does not apply to this model; hide the control.
  if (model.efforts.length === 0) return [];
  const { unsupportedEfforts } = nativeCapMetadata(model);
  const defaultReason =
    model.defaultEffort !== null ? unsupportedEfforts[model.defaultEffort] : undefined;
  const rows: PickerOption[] = [];
  if (defaultReason !== undefined)
    rows.push({
      value: '',
      label: 'Default effort',
      description: `unavailable · ${defaultReason || 'not supported'}`,
      disabled: true,
      reason: defaultReason || 'The CLI default effort is not supported by this bridge',
    });
  else rows.push({ value: '', label: 'Default effort', description: 'Use the CLI default' });
  for (const choice of cliEffortChoices(model))
    rows.push({
      value: choice.token,
      label: choice.token,
      ...(choice.unavailable
        ? { description: `unavailable · ${choice.reason ?? 'not supported'}` }
        : choice.token === model.defaultEffort
          ? { description: 'default' }
          : {}),
      disabled: choice.unavailable,
      reason: choice.reason,
    });
  return rows;
}

/** `fast` is only offered when the CLI genuinely advertises it. */
export function cliSpeedOptionRows(model: CliModelCapabilities): PickerOption[] {
  return [
    { value: 'standard', label: 'Standard', description: 'Default' },
    ...(model.speeds.includes('fast')
      ? [{ value: 'fast', label: 'Fast', description: 'CLI fast mode; needs explicit permission' }]
      : []),
  ];
}

/* ------------------------------------------------------------------ selectability */

export interface CliModelSelectability {
  selectable: boolean;
  reason: string | null;
}

/** Anonymous OpenCode free generation is legitimate access that needs no sign-in. */
function isAnonymousFreeAccess(connection: CliConnection, model: CliModelCapabilities): boolean {
  return connection.kind === 'opencode-cli' && model.billing === 'free';
}

/**
 * A native CLI model is selectable only when the user has explicitly opted into Native, the current
 * account can actually generate for it, and a real generation proved this exact model. Discovery
 * alone, a signed-out account, and a verification that named no model are never proof.
 */
export function cliModelSelectability(
  connection: CliConnection,
  model: CliModelCapabilities,
): CliModelSelectability {
  if (!connection.install.installed)
    return { selectable: false, reason: `Not installed. ${connection.install.installHint}` };
  if (!connection.surfaces.native)
    return {
      selectable: false,
      reason: `Enable Native for ${cliBrandName(connection.kind)} in /connect to select this model`,
    };
  if (connection.account.state === 'signed_out' && !isAnonymousFreeAccess(connection, model))
    return {
      selectable: false,
      reason: `Sign in to ${cliBrandName(connection.kind)} in /connect before selecting this model`,
    };
  if (connection.verify.state === 'verified') {
    if (isCliModelVerified(connection, model.ref)) return { selectable: true, reason: null };
    return {
      selectable: false,
      reason: `Verify ${model.ref} in /connect to select it; discovery alone does not prove access`,
    };
  }
  if (connection.verify.state === 'failed')
    return {
      selectable: false,
      reason: `Verification failed${connection.verify.message ? `: ${connection.verify.message}` : ''}`,
    };
  if (connection.verify.state === 'stale')
    return {
      selectable: false,
      reason: `Verification is stale. Verify ${cliBrandName(connection.kind)} again in /connect`,
    };
  return {
    selectable: false,
    reason: `Verify ${cliBrandName(connection.kind)} in /connect to enable this model`,
  };
}

/* ------------------------------------------------------------------ options precedence */

/** Layered option sources, highest precedence first. */
export interface CliOptionLayers {
  /** Per-conversation override persisted for this model ref. */
  conversation?: Partial<CliOption> | undefined;
  /** Profile `cliDefaults` entry for this model ref. */
  profile?: Partial<CliOption> | undefined;
  /** Connection `defaultOptions` merged with its `modelDefaults` entry for this ref. */
  connection?: Partial<CliOption> | undefined;
}

/**
 * Use the same field-by-field precedence as Core. An explicit default selects the reported CLI
 * effort and stops inheritance; unsupported explicit options remain visible for dispatch validation.
 */
export function resolveCliOptions(
  model: CliModelCapabilities,
  layers: CliOptionLayers = {},
): CliOption {
  return resolveCliOption({ model, ...layers });
}

/**
 * Merge a connection's stored `defaultOptions` with its per-model override for one ref. A missing
 * per-model field inherits the connection default; an explicit null remains a default selection.
 */
export function connectionOptionLayer(
  saved: CliConnectionSettings | undefined,
  ref: CliModelCapabilities['ref'],
): Partial<CliOption> | undefined {
  if (!saved) return undefined;
  const entry = saved.modelDefaults[ref];
  const merged = { ...saved.defaultOptions, ...entry };
  return {
    ...(merged.effort !== undefined ? { effort: merged.effort } : {}),
    ...(merged.speed !== undefined ? { speed: merged.speed } : {}),
  };
}

export interface CliModelStatus {
  ref: string;
  billing: CliBilling;
  effort: string | null;
  speed: CliSpeed;
}

/** Resolve the persisted CLI status for a model ref from the discovered inventory and settings. */
export function resolveCliModelStatus(
  ref: string | null,
  connections: readonly CliConnection[],
  settings: Readonly<Record<string, CliConnectionSettings>>,
  profile: Profile | undefined,
  conversation: Partial<CliOption> | undefined,
): CliModelStatus | null {
  if (!ref) return null;
  const kind = ref.split('/')[0];
  if (!kind || !isCliConnectionKind(kind)) return null;
  const connection = findConnection(connections, kind);
  const model = findCliModel(connection, ref);
  if (!connection || !model) return null;
  const refKey = ref as CliModelCapabilities['ref'];
  const connectionLayer = connectionOptionLayer(settings[kind], refKey);
  const resolved = resolveCliOptions(model, {
    conversation,
    profile: profile?.cliDefaults?.[refKey],
    connection: connectionLayer,
  });
  return { ref, billing: model.billing, effort: resolved.effort, speed: resolved.speed };
}

/**
 * Merge a partial option patch into the pre-session draft. A patch for the same model merges so
 * changing speed never drops an earlier effort (and an explicit `effort: null` reset is preserved
 * while an absent field preserves the earlier value); a patch for a different model replaces it.
 */
export function mergeCliOptionDraft(
  draft: { modelRef: string; options: Partial<CliOption> } | null,
  ref: string,
  patch: Partial<CliOption>,
): { modelRef: string; options: Partial<CliOption> } {
  return draft?.modelRef === ref
    ? { modelRef: ref, options: { ...draft.options, ...patch } }
    : { modelRef: ref, options: { ...patch } };
}

/**
 * The model to verify by default: the already-verified model when re-checking, else the first
 * free or included-subscription model. Never guesses a metered model, which would spend real money.
 */
export function safeVerificationModel(connection: CliConnection): CliModelCapabilities | undefined {
  const models = connection.models.filter((model) => !model.hidden);
  const verified = models.find((model) => model.ref === connection.verify.modelRef);
  if (verified) return verified;
  return models.find(
    (model) => model.billing === 'free' || model.billing === 'included_subscription',
  );
}

/* ------------------------------------------------------------------ picker options */

export function connectionStateLabel(connection: CliConnection): string {
  const facts: string[] = [];
  facts.push(connection.install.installed ? 'installed' : 'not installed');
  if (connection.install.version) facts.push(connection.install.version);
  facts.push(
    connection.verify.state === 'verified'
      ? 'verified'
      : connection.verify.state === 'failed'
        ? 'verify failed'
        : connection.verify.state === 'stale'
          ? 'verify stale'
          : 'unverified',
  );
  facts.push(`native ${connection.surfaces.native ? 'on' : 'off'}`);
  facts.push(`gateway ${connection.surfaces.gateway ? 'on' : 'off'}`);
  return facts.join(' · ');
}

/** Installed CLIs category for /connect. */
export function cliConnectionPickerOptions(connections: readonly CliConnection[]): PickerOption[] {
  return connections.map((connection) => ({
    value: `cli:${connection.kind}`,
    label: cliBrandName(connection.kind),
    description: connectionStateLabel(connection),
    group: 'Installed CLIs',
  }));
}

/**
 * CLI models for /model, grouped per CLI. Every discovered model stays visible; unselectable ones
 * carry a reason and the `/connect` setup path instead of disappearing.
 */
export function cliModelPickerOptions(connections: readonly CliConnection[]): PickerOption[] {
  const rows: PickerOption[] = [];
  for (const connection of connections) {
    if (!connection.install.installed) continue;
    const group = cliBrandName(connection.kind);
    for (const model of connection.models) {
      if (model.hidden) continue;
      const { selectable, reason } = cliModelSelectability(connection, model);
      const upstream = model.upstreamProvider ?? connection.upstreamLabel;
      rows.push({
        value: encodeCliModelValue(connection.kind, model.ref),
        label: model.name,
        group,
        description: `${upstream ? `${upstream} · ` : ''}${billingLabel(model.billing)}${
          selectable ? '' : ` · ${reason ?? 'not selectable'}`
        }`,
        ...(model.billing === 'free' ? { free: true } : {}),
        ...(model.billing === 'included_subscription' ? { included: true } : {}),
        selectable,
        reason,
      });
    }
  }
  return rows;
}

export function cliModelMatchesFilter(billing: CliBilling, mode: CliModelFilterMode): boolean {
  if (mode === 'all') return true;
  if (mode === 'free') return billing === 'free';
  return billing === 'included_subscription';
}

/* ------------------------------------------------------------------ facts and limits */

export type FactState = 'ok' | 'warn' | 'bad' | 'muted';

export interface ConnectionFact {
  label: string;
  value: string;
  state: FactState;
}

function verificationFact(verify: CliVerification): ConnectionFact {
  const state: FactState =
    verify.state === 'verified'
      ? 'ok'
      : verify.state === 'failed'
        ? 'bad'
        : verify.state === 'stale'
          ? 'warn'
          : 'muted';
  const detail =
    verify.state === 'verified'
      ? `Verified${verify.modelRef ? ` · ${verify.modelRef}` : ''}`
      : verify.state === 'failed'
        ? `Failed${verify.message ? ` · ${verify.message}` : ''}`
        : verify.state === 'stale'
          ? `Stale${verify.message ? ` · ${verify.message}` : ''}`
          : 'Not verified';
  return { label: 'Generation proof', value: detail, state };
}

export function connectionLimits(connection: CliConnection): string {
  const { usage } = connection;
  if (usage.state === 'unavailable') return `Unavailable${usage.note ? ` · ${usage.note}` : ''}`;
  if (!usage.windows.length) return usage.state === 'stale' ? 'Stale' : 'No usage windows';
  const prefix = usage.state === 'stale' ? 'Stale · ' : '';
  return (
    prefix +
    usage.windows
      .map((window) => {
        const percent =
          window.utilization !== null
            ? `${String(Math.round(window.utilization * 100))}%`
            : window.used !== null && window.limit !== null
              ? `${String(window.used)}/${String(window.limit)}`
              : window.remaining !== null
                ? `${String(window.remaining)} left`
                : 'no data';
        return `${window.label} ${percent}`;
      })
      .join(' · ')
  );
}

/** Separated installed / account / discovery / proof / limits / opt-in facts. */
export function connectionFacts(connection: CliConnection): ConnectionFact[] {
  const { install, account, verify, usage } = connection;
  return [
    {
      label: 'Installed',
      value: install.installed
        ? `Yes${install.version ? ` · ${install.version}` : ''}${install.executable ? ` · ${install.executable}` : ''}`
        : 'No',
      state: install.installed ? 'ok' : 'muted',
    },
    {
      label: 'Version',
      value: install.version ?? 'Unknown',
      state: install.version ? 'muted' : 'warn',
    },
    {
      label: 'Current account',
      value: account.label ?? accountLabel(connection),
      state: account.state === 'signed_in' ? 'ok' : account.state === 'unknown' ? 'warn' : 'muted',
    },
    {
      label: 'Auth',
      value: authLabel(account.state),
      state: account.state === 'signed_out' ? 'bad' : 'muted',
    },
    {
      label: 'Model discovery',
      value:
        connection.models.length > 0
          ? `${String(connection.models.length)} model${connection.models.length === 1 ? '' : 's'} discovered`
          : (connection.discoveryMessage ?? 'No models discovered yet. Refresh.'),
      state: connection.models.length > 0 ? 'ok' : 'warn',
    },
    verificationFact(verify),
    {
      label: 'Limits',
      value: connectionLimits(connection),
      state: usage.state === 'available' ? 'ok' : usage.state === 'stale' ? 'warn' : 'muted',
    },
    {
      label: 'Opt-ins',
      value: `Native ${connection.surfaces.native ? 'on' : 'off'} · Gateway ${connection.surfaces.gateway ? 'on' : 'off'}`,
      state: connection.surfaces.native || connection.surfaces.gateway ? 'ok' : 'muted',
    },
  ];
}

/** Useful, actionable error text, or null when the connection has nothing wrong to report. */
export function connectionError(connection: CliConnection): string | null {
  if (!connection.install.installed) return connection.install.installHint;
  if (connection.verify.state === 'failed' && connection.verify.message)
    return connection.verify.message;
  if (connection.discoveryMessage && connection.models.length === 0)
    return connection.discoveryMessage;
  return null;
}

/** Explicit sign-in instructions; never reads native histories or copies credentials. */
export function signInHint(connection: CliConnection): string {
  switch (connection.kind) {
    case 'codex-cli':
      return 'Run `codex login` in a terminal, then choose Detect to re-check the current account.';
    case 'claude-code-cli':
      return 'Run `claude auth login` in a terminal, then choose Detect to re-check the current account.';
    case 'opencode-cli':
      return 'Run `opencode auth login` and pick your provider, then choose Detect. Free anonymous Zen access needs no sign-in.';
  }
}

export function connectionSummaryLine(connection: CliConnection): string {
  const error = connectionError(connection);
  const parts = [connectionStateLabel(connection)];
  if (error) parts.push(error);
  return parts.join(' · ');
}
