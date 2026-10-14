import { z } from 'zod';
import { ModelRefSchema, SessionIdSchema, type ModelRef } from './ids.js';

/**
 * Installed CLI connection contracts.
 *
 * The connection `id` is the stable CLI kind itself (never derived from the account), so legacy
 * routes and pickers keep a stable key while the current account may change underneath it. The
 * account is represented separately by an opaque, non-secret `accountKey`.
 */
export const CliConnectionKindSchema = z.enum(['codex-cli', 'claude-code-cli', 'opencode-cli']);
export type CliConnectionKind = z.infer<typeof CliConnectionKindSchema>;

/** Provider ids for installed CLIs are identical to their connection kinds. */
export const CliProviderIdSchema = CliConnectionKindSchema;
export type CliProviderId = z.infer<typeof CliProviderIdSchema>;

export const CliAuthStateSchema = z.enum(['signed_in', 'signed_out', 'unknown', 'not_checked']);
export type CliAuthState = z.infer<typeof CliAuthStateSchema>;

export const CliVerifyStateSchema = z.enum(['unverified', 'verified', 'failed', 'stale']);
export type CliVerifyState = z.infer<typeof CliVerifyStateSchema>;

export const CliUsageStateSchema = z.enum(['available', 'unavailable', 'stale']);
export type CliUsageState = z.infer<typeof CliUsageStateSchema>;

export const CliBillingSchema = z.enum(['free', 'included_subscription', 'metered', 'unknown']);
export type CliBilling = z.infer<typeof CliBillingSchema>;

/** `standard` is the only default; `fast` is only advertised when the CLI genuinely reports it. */
export const CliSpeedSchema = z.enum(['standard', 'fast']);
export type CliSpeed = z.infer<typeof CliSpeedSchema>;

/**
 * A CLI-reported reasoning-effort token. Values are preserved verbatim from the installed CLI
 * (e.g. `low`, `high`, `xhigh`, `max`, `ultra`, `none`, and future names) instead of being filtered
 * through the API `EffortSchema`, which is deliberately narrower. Validity is a short lowercase
 * option token; whether a token is supported by a given model is checked at request time.
 */
export const CliEffortSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
export type CliEffort = z.infer<typeof CliEffortSchema>;

/** Effective input modality for the beta: text only. Images/structured output are rejected upstream. */
export const CliModalitySchema = z.literal('text');
export type CliModality = z.infer<typeof CliModalitySchema>;

export const CliCredentialSourceSchema = z.enum(['opencode', 'opencode_go', 'ferry', 'anonymous']);
export type CliCredentialSource = z.infer<typeof CliCredentialSourceSchema>;

export const CliUsageMetricSchema = z.enum(['percent', 'requests', 'tokens', 'usd']);
export type CliUsageMetric = z.infer<typeof CliUsageMetricSchema>;

/**
 * Opaque, non-secret identity of the current CLI account (`<kind>:<hex fingerprint>`). Never
 * contains credentials, tokens, or raw key material.
 */
export const CliAccountKeySchema = z.string().regex(/^[a-z0-9-]+:[a-f0-9]{12,64}$/);
export type CliAccountKey = z.infer<typeof CliAccountKeySchema>;

export const CliInstallSchema = z.object({
  installed: z.boolean(),
  executable: z.string().nullable(),
  version: z.string().nullable(),
  installHint: z.string(),
});
export type CliInstall = z.infer<typeof CliInstallSchema>;

export const CliAccountSchema = z.object({
  state: CliAuthStateSchema,
  key: CliAccountKeySchema.nullable(),
  /** Display-only email/org/plan label. Never credentials or tokens. */
  label: z.string().nullable(),
  plan: z.string().nullable(),
});
export type CliAccount = z.infer<typeof CliAccountSchema>;

/**
 * One successful per-model verification receipt. The fingerprint is bound to the account, installed
 * version, credential selection and that model's effective capabilities, so a later verification of
 * another model never invalidates it. Never contains credentials or key material.
 */
export const CliModelReceiptSchema = z.object({
  checkedAt: z.iso.datetime(),
  receiptKey: z.string().min(1).max(128).nullable(),
});
export type CliModelReceipt = z.infer<typeof CliModelReceiptSchema>;

export const CliVerificationSchema = z.object({
  state: CliVerifyStateSchema,
  /**
   * Connection summary: the most recently proven model ref, kept for the picker/summary even though
   * access truth for a specific model lives in `modelReceipts`.
   */
  modelRef: ModelRefSchema.nullable(),
  checkedAt: z.iso.datetime().nullable(),
  message: z.string().nullable(),
  /**
   * Nonsecret fingerprint of the account/version/capabilities/credential selection the summary
   * receipt was proven against. A persisted receipt whose fingerprint is missing or no longer
   * matches is stale. Never contains credentials or key material.
   */
  receiptKey: z.string().min(1).max(128).nullable().optional(),
  /**
   * Accumulated SUCCESSFUL per-model receipts. Verifying a new model adds to this map without
   * forgetting older models; a failed check of a new model leaves existing receipts intact.
   * Optional for backwards compatibility with receipts written before per-model evidence existed.
   */
  modelReceipts: z.record(ModelRefSchema, CliModelReceiptSchema).optional(),
});
export type CliVerification = z.infer<typeof CliVerificationSchema>;

/** True when `model` has its own successful verification receipt for this connection. */
export function isCliModelVerified(
  connection: Pick<CliConnection, 'verify'>,
  modelRef: ModelRef,
): boolean {
  if (connection.verify.state !== 'verified') return false;
  if (connection.verify.modelReceipts)
    return connection.verify.modelReceipts[modelRef] !== undefined;
  // Legacy receipt (pre-per-model evidence): only the summary model ref counts.
  return connection.verify.modelRef === modelRef;
}

export const CliSurfacesSchema = z.object({
  native: z.boolean().default(false),
  gateway: z.boolean().default(false),
});
export type CliSurfaces = z.infer<typeof CliSurfacesSchema>;

/** Explicit CLI invocation options. `effort: null` means "use the discovered CLI default". */
export const CliOptionSchema = z.object({
  effort: CliEffortSchema.nullable().default(null),
  speed: CliSpeedSchema.default('standard'),
});
export type CliOption = z.infer<typeof CliOptionSchema>;

/**
 * Patch form of CLI options. Deliberately carries no `.default()` values, so parsing keeps the
 * difference between an absent field (preserve the stored override) and an explicit `null`
 * (clear the override). Zod's `.partial()` would otherwise re-inject `null`/`standard` defaults.
 */
export const CliOptionPatchSchema = z.object({
  effort: CliEffortSchema.nullable().optional(),
  speed: CliSpeedSchema.optional(),
});
export type CliOptionPatch = z.infer<typeof CliOptionPatchSchema>;

/** Patch form of surfaces; same absent-vs-false distinction as `CliOptionPatchSchema`. */
export const CliSurfacesPatchSchema = z.object({
  native: z.boolean().optional(),
  gateway: z.boolean().optional(),
});
export type CliSurfacesPatch = z.infer<typeof CliSurfacesPatchSchema>;

export const CliModelCapabilitiesSchema = z.object({
  ref: ModelRefSchema,
  connectionId: z.string().min(1),
  providerId: CliProviderIdSchema,
  /** Exact model id reported by the installed CLI. */
  upstreamId: z.string().min(1),
  /** Upstream provider/grouping reported by the CLI, when it distinguishes one. */
  upstreamProvider: z.string().nullable(),
  name: z.string(),
  /** Raw reasoning-effort tokens reported verbatim by the CLI, including ones this beta cannot run. */
  efforts: z.array(CliEffortSchema),
  defaultEffort: CliEffortSchema.nullable(),
  /**
   * Advertised-but-unrunnable controls: effort token to a nonsecret explanation the UI can show
   * while keeping the raw token in `efforts`. Empty when the bridge runs every advertised token.
   */
  unsupportedEfforts: z.record(CliEffortSchema, z.string().min(1).max(240)).optional(),
  speeds: z.array(CliSpeedSchema),
  defaultSpeed: CliSpeedSchema.default('standard'),
  modalities: z.array(CliModalitySchema),
  toolCalling: z.boolean(),
  /** Context/output capacity only when the CLI actually reported it; `null`/absent means unknown. */
  contextWindow: z.number().int().positive().nullable().optional(),
  maxOutput: z.number().int().positive().nullable().optional(),
  billing: CliBillingSchema,
  hidden: z.boolean().default(false),
});
export type CliModelCapabilities = z.infer<typeof CliModelCapabilitiesSchema>;

/* ------------------------------------------------------------------ effective option resolution */

/**
 * One optional CLI option layer. An absent key (or `undefined`) inherits from the next lower layer;
 * an explicit `effort: null` selects the CLI-reported default and stops fall-through. `speed` is a
 * capability gate, never defaulted to `fast`.
 */
export interface CliOptionLayer {
  effort?: CliEffort | null | undefined;
  speed?: CliSpeed | undefined;
}

export interface CliOptionResolverInput {
  /** Capability evidence for the target model. Only efforts the CLI actually reports are used. */
  model: Pick<CliModelCapabilities, 'efforts' | 'defaultEffort' | 'speeds' | 'unsupportedEfforts'>;
  /** Explicit conversation/session override; highest priority. */
  conversation?: CliOptionLayer | undefined;
  /** Profile `cliDefaults[ref]`. */
  profile?: CliOptionLayer | undefined;
  /** Connection per-model default (`cliConnections[kind].modelDefaults[ref]`). */
  connectionModel?: CliOptionLayer | undefined;
  /** Connection default options (`cliConnections[kind].defaultOptions`). */
  connection?: CliOptionLayer | undefined;
}

function isUsableReportedEffort(
  model: CliOptionResolverInput['model'],
  token: string | null,
): token is CliEffort {
  return (
    typeof token === 'string' &&
    model.efforts.includes(token) &&
    model.unsupportedEfforts?.[token] === undefined
  );
}

/**
 * The single shared, pure CLI option resolver used by Core dispatch, the Ferry CLI and the GUI.
 *
 * Precedence for each field, highest first: conversation, profile, connection per-model default,
 * connection default, then the reported CLI default. `Object.hasOwn` distinguishes an explicit
 * `null`/value (which wins and stops fall-through) from an absent field (which inherits). An explicit
 * `effort: null` selects the reported CLI default; when no layer reports an effort, the model's
 * reported default is used, or `null` when that default is disabled/unsupported — an implicit
 * default is never silently substituted. `fast` is never defaulted on: an absent speed resolves to
 * `standard`, while an explicit speed is returned verbatim (an unsupported explicit `fast` is
 * rejected by the caller, never silently normalized).
 */
export function resolveCliOption(input: CliOptionResolverInput): CliOption {
  const reported: CliEffort | null = isUsableReportedEffort(input.model, input.model.defaultEffort)
    ? input.model.defaultEffort
    : null;
  const ordered: (CliOptionLayer | undefined)[] = [
    input.conversation,
    input.profile,
    input.connectionModel,
    input.connection,
  ];
  let effort: CliEffort | null = reported;
  for (const layer of ordered) {
    if (!layer || !Object.hasOwn(layer, 'effort')) continue;
    const value = layer.effort;
    if (value === undefined) continue;
    // An explicit `null` selects the reported default and stops fall-through.
    effort = value ?? reported;
    break;
  }
  let speed: CliSpeed = 'standard';
  for (const layer of ordered) {
    if (!layer || !Object.hasOwn(layer, 'speed')) continue;
    const value = layer.speed;
    if (value === undefined) continue;
    // An explicit speed is returned verbatim. An unsupported explicit `fast` is NOT silently
    // normalized to `standard`; the caller rejects it before generation (only advertised choices
    // are supported). An absent speed still defaults to `standard`.
    speed = value;
    break;
  }
  return { effort, speed };
}

export const CliUsageWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  metric: CliUsageMetricSchema,
  windowKind: z.string(),
  used: z.number().nullable(),
  limit: z.number().nullable(),
  remaining: z.number().nullable(),
  /** Fractional utilization; may exceed 1 when the CLI reports overage. */
  utilization: z.number().min(0).nullable(),
  resetAt: z.iso.datetime().nullable(),
});
export type CliUsageWindow = z.infer<typeof CliUsageWindowSchema>;

export const CliUsageSnapshotSchema = z.object({
  connectionId: z.string().min(1),
  accountKey: CliAccountKeySchema.nullable(),
  state: CliUsageStateSchema,
  /** Ferry-generated/observed source description. Never imported conversation data. */
  source: z.string(),
  observedAt: z.iso.datetime().nullable(),
  staleAt: z.iso.datetime().nullable(),
  windows: z.array(CliUsageWindowSchema),
  note: z.string().nullable(),
});
export type CliUsageSnapshot = z.infer<typeof CliUsageSnapshotSchema>;

export const CliConnectionSchema = z.object({
  id: CliConnectionKindSchema,
  kind: CliConnectionKindSchema,
  providerId: CliProviderIdSchema,
  /** Friendly upstream label, e.g. "ChatGPT", "Claude", "OpenCode Zen". */
  upstreamLabel: z.string().nullable(),
  install: CliInstallSchema,
  account: CliAccountSchema,
  verify: CliVerificationSchema,
  surfaces: CliSurfacesSchema,
  models: z.array(CliModelCapabilitiesSchema),
  usage: CliUsageSnapshotSchema,
  lastChecked: z.iso.datetime().nullable(),
  discoveryMessage: z.string().nullable(),
});
export type CliConnection = z.infer<typeof CliConnectionSchema>;

export const CliConnectionListSchema = z.array(CliConnectionSchema);

/**
 * Credential source for one installed CLI connection. OpenCode can use its own installed sign-in,
 * an anonymous session, or a Ferry-stored key; the other CLIs always use their installed sign-in.
 */
export const CliCredentialModeSchema = z.enum(['installed', 'anonymous', 'ferry']);
export type CliCredentialMode = z.infer<typeof CliCredentialModeSchema>;

/** Persisted opt-in/default settings per installed CLI connection (settings JSON). */
export const CliConnectionSettingsSchema = z.object({
  native: z.boolean().default(false),
  gateway: z.boolean().default(false),
  credentialMode: CliCredentialModeSchema.default('installed'),
  /** Explicit provider entry offered to OpenCode (e.g. `opencode-go`); never a copied secret. */
  credentialProvider: z.string().min(1).max(64).nullable().default(null),
  defaultOptions: CliOptionSchema.default({ effort: null, speed: 'standard' }),
  // Defaults-free per-model overrides: an omitted/undefined field stays absent so the shared resolver
  // inherits it from the next layer, while an explicit `effort: null` still stops at the CLI default.
  // `CliOptionSchema.partial()` would re-materialize `effort: null` / `speed: 'standard'` defaults.
  modelDefaults: z.record(ModelRefSchema, CliOptionPatchSchema).default({}),
});
export type CliConnectionSettings = z.infer<typeof CliConnectionSettingsSchema>;

export const CliConnectionSettingsPatchSchema = z.object({
  surfaces: CliSurfacesPatchSchema.optional(),
  credentialMode: CliCredentialModeSchema.optional(),
  credentialProvider: z.string().min(1).max(64).nullable().optional(),
  defaultOptions: CliOptionPatchSchema.optional(),
  modelDefaults: z.record(ModelRefSchema, CliOptionPatchSchema).optional(),
});
export type CliConnectionSettingsPatch = z.infer<typeof CliConnectionSettingsPatchSchema>;

/**
 * Per-session/model usage aggregate. Missing token dimensions are `null`; a reported zero stays `0`.
 */
export const SessionModelUsageSchema = z.object({
  sessionId: SessionIdSchema,
  totals: z.object({
    requests: z.number().int().nonnegative(),
    // Nullable per dimension: an unreported dimension is not zero. A reported zero stays `0`.
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    cachedTokens: z.number().int().nonnegative().nullable(),
    reasoningTokens: z.number().int().nonnegative().nullable(),
  }),
  models: z.array(
    z.object({
      modelRef: ModelRefSchema,
      providerId: z.string().nullable(),
      connectionId: z.string().nullable(),
      accountKey: CliAccountKeySchema.nullable(),
      requests: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative().nullable(),
      outputTokens: z.number().int().nonnegative().nullable(),
      cachedTokens: z.number().int().nonnegative().nullable(),
      reasoningTokens: z.number().int().nonnegative().nullable(),
      lastUsedAt: z.iso.datetime().nullable(),
      /** Requests whose usage the CLI did not report (shown as "Not reported"). */
      unreportedRequests: z.number().int().nonnegative(),
    }),
  ),
  incomplete: z.boolean(),
  coverage: z.object({
    since: z.iso.datetime().nullable(),
    missing: z.boolean(),
  }),
});
export type SessionModelUsage = z.infer<typeof SessionModelUsageSchema>;

export const CliConnectionVerifyResultSchema = z.object({
  ok: z.boolean(),
  modelRef: ModelRefSchema.nullable(),
  message: z.string(),
});
export type CliConnectionVerifyResult = z.infer<typeof CliConnectionVerifyResultSchema>;
