import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CliTransportError,
  deriveCliAccountKey,
  parseOpencodeAuthStore,
  type CliTransportErrorKind,
  type OpencodeAuthRecord,
} from '@ferry/delegate';
import { rememberSecret, type CliModelCapabilities } from '@ferry/shared';
import type { FerryServices } from './services.js';

/**
 * Core-owned OpenCode credential resolver.
 *
 * It turns the persisted OpenCode connection credential selection
 * (`settings.cliConnections['opencode-cli']`) plus the *actual selected upstream provider of the
 * model* into non-secret evidence that the broker/verification path can bind a receipt to. It never
 * picks one default auth entry for every provider: the upstream provider reported by the model is
 * required, so Zen, Go and any other OpenCode provider stay isolated.
 *
 * Secret handling:
 * - `apiKey` is memory-only. It is populated when Ferry itself supplies the credential: Ferry mode
 *   (the explicit saved credential) and the one approved cross-provider offer, an installed
 *   `opencode-go` credential offered to an `opencode` (Zen) model. Same-provider native credentials
 *   stay native-owned and are never returned. The caller must never persist or log it.
 * - Any key material Ferry reads (returned or merely fingerprinted) is registered with the public
 *   `rememberSecret` so downstream known-secret redaction covers it. Nothing here prints a key, the
 *   auth store, or a file path.
 * - A failure to read the secret store is wrapped in a redacted typed `CliTransportError`; the
 *   keyring reference and the underlying storage error are never surfaced.
 *
 * Cross-provider offers are deliberately narrow. The only supported case is a Go credential offered
 * to a Zen model, which enables a *real* Zen access check without ever claiming Zen entitlement. Any
 * other cross-provider request is rejected before any key is read, so an OpenAI/Go/etc. key can
 * never leak to an unrelated upstream.
 *
 * Limitations (reported honestly, never papered over):
 * - The shared `parseOpencodeAuthStore` surfaces `type` and, for some records, `key`. Only an
 *   explicit `type: 'api'` record with a string key is treated as an API credential. Records with
 *   `type: 'oauth'` (even one carrying a stray `key` field) and records with an unknown/absent type
 *   are treated as non-API: they prove no presence, never yield a secret and reject a cross-provider
 *   offer. Native OAuth refresh material is untouched. Such records resolve to `accountKey: null`.
 * - `accountKey` is an opaque fingerprint over the selected provider id and its API key. It never
 *   contains the key, but cannot represent OAuth/unknown accounts.
 *
 * Native credential precedence (verified against the installed OpenCode CLI, 1.18.35): for a given
 * provider the provider-state merge first records the `OPENCODE_API_KEY` environment source and then
 * overwrites it with the auth-store `type: 'api'` key, so an installed API key WINS over the env
 * variable; a config `provider.<id>.options.apiKey` override wins over both. `OPENCODE_API_KEY` is
 * declared by the OpenCode catalog for BOTH `opencode` (Zen) and `opencode-go`, so it applies to
 * exactly those two providers and never to an unrelated provider. This resolver mirrors that order:
 * auth-store `api` key, then `OPENCODE_API_KEY` (OpenCode providers only), then an `oauth`/unknown/
 * absent record. OAuth is never treated as an API key.
 */

/** The connection kind whose persisted credential selection this resolver reads. */
const CONNECTION_KIND = 'opencode-cli';
/** OpenCode's Zen provider id (native `opencode` auth entry and the supported `OPENCODE_API_KEY`). */
const ZEN_PROVIDER = 'opencode';
/** OpenCode's Go provider id; the only provider Ferry offers across to a Zen model. */
const GO_PROVIDER = 'opencode-go';
/** Providers whose OpenCode catalog entry declares `OPENCODE_API_KEY` (verified 1.18.35). */
const ENV_PROVIDERS: ReadonlySet<string> = new Set([ZEN_PROVIDER, GO_PROVIDER]);
/** The only auth-store record type treated as a usable API credential. */
const API_AUTH_TYPE = 'api';
/** Domain separator so the same key under different providers yields different fingerprints. */
const FINGERPRINT_SEPARATOR = '\u0000';

export type OpenCodeCredentialMode = 'installed' | 'anonymous' | 'ferry';

/** Resolved, non-secret credential evidence for one OpenCode CLI generation/verification request. */
export interface OpenCodeCredentialEvidence {
  mode: OpenCodeCredentialMode;
  /** The actual upstream provider of the selected model (e.g. `opencode`, `opencode-go`). */
  provider: string;
  /** Explicit provider entry offered by settings, or `null`. Never a copied secret. */
  credentialProvider: string | null;
  /**
   * Opaque, non-secret fingerprint of the selected provider and its credential. `null` when no
   * stable API-key identity exists (OAuth/unknown record or no credential); never another
   * provider's id.
   */
  accountKey: string | null;
  /**
   * Ephemeral, memory-only secret. Populated only when Ferry supplies the credential itself: Ferry
   * mode (the explicit saved Zen key) or the approved `opencode-go`-to-Zen native offer. Never
   * present for same-provider native credentials. The caller must never persist, log or echo it.
   */
  apiKey?: string;
}

/** Nonsecret metadata safe to surface for an OpenCode credential offer. */
export interface OpenCodeCredentialOffer {
  readonly mode: OpenCodeCredentialMode;
  readonly provider: string;
  readonly credentialProvider: string | null;
  readonly present: boolean;
  readonly fingerprint: string | null;
}

/**
 * Reduce evidence to nonsecret offer metadata (provider id, presence, opaque fingerprint). The
 * `apiKey` is never included, so this is safe for a future CLI service/manager to display or route
 * on without exposing auth-store contents or a user key.
 */
export function openCodeCredentialOffer(
  evidence: OpenCodeCredentialEvidence,
): OpenCodeCredentialOffer {
  return {
    mode: evidence.mode,
    provider: evidence.provider,
    credentialProvider: evidence.credentialProvider,
    present: evidence.apiKey !== undefined || evidence.accountKey !== null,
    fingerprint: evidence.accountKey,
  };
}

interface OpenCodeSettings {
  mode: OpenCodeCredentialMode;
  offer: string | null;
}

type NativeCredential =
  { state: 'api'; key: string } | { state: 'oauth' } | { state: 'unknown' } | { state: 'missing' };

interface UsableKeyEntry {
  enabled: boolean;
  status: string;
  cooldownUntil: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typedError(kind: CliTransportErrorKind, message: string): CliTransportError {
  return new CliTransportError(kind, message);
}

/** Read the OpenCode connection credential mode/provider defensively; malformed values default. */
function readOpenCodeSettings(services: FerryServices): OpenCodeSettings {
  const stored = services.settings.get('global');
  const connections =
    isRecord(stored) && isRecord(stored.cliConnections) ? stored.cliConnections : undefined;
  const record =
    connections && isRecord(connections[CONNECTION_KIND]) ? connections[CONNECTION_KIND] : {};
  const mode: OpenCodeCredentialMode =
    record.credentialMode === 'anonymous' || record.credentialMode === 'ferry'
      ? record.credentialMode
      : 'installed';
  const offer =
    typeof record.credentialProvider === 'string' && record.credentialProvider.trim()
      ? record.credentialProvider.trim()
      : null;
  return { mode, offer };
}

/**
 * Read the native auth store once. A missing or malformed store is treated as "no records" without
 * surfacing the parse error, so a broken file can never masquerade as a signed-in provider.
 */
async function readNativeRecords(services: FerryServices): Promise<OpencodeAuthRecord[]> {
  const configured =
    typeof services.env.XDG_DATA_HOME === 'string' ? services.env.XDG_DATA_HOME.trim() : '';
  const dataHome = configured || join(homedir(), '.local', 'share');
  try {
    const raw: unknown = JSON.parse(
      await readFile(join(dataHome, 'opencode', 'auth.json'), 'utf8'),
    );
    return parseOpencodeAuthStore(raw);
  } catch {
    return [];
  }
}

/**
 * Resolve the native credential for one provider using the installed CLI's precedence (verified
 * against OpenCode 1.18.35): an auth-store `type: 'api'` key overrides `OPENCODE_API_KEY`, which in
 * turn applies only to the providers whose catalog entry declares it (`opencode`/`opencode-go`).
 * `OPENCODE_API_KEY` is therefore never applied to an unrelated provider.
 *
 * Only an explicit `type: 'api'` record with a string key is a usable API credential. An OAuth
 * record (even one carrying a stray `key`) and an unknown/absent record type are never treated as
 * API material and never yield a secret.
 */
function nativeCredentialFor(
  records: readonly OpencodeAuthRecord[],
  providerId: string,
  environment: NodeJS.ProcessEnv,
): NativeCredential {
  const record = records.find((candidate) => candidate.providerId === providerId);
  if (record?.type === API_AUTH_TYPE && record.key) return { state: 'api', key: record.key };
  if (ENV_PROVIDERS.has(providerId)) {
    const fromEnv = environment.OPENCODE_API_KEY;
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return { state: 'api', key: fromEnv };
  }
  if (record?.type === 'oauth') return { state: 'oauth' };
  if (record) return { state: 'unknown' };
  return { state: 'missing' };
}

/** Opaque, non-secret fingerprint over the selected provider and its API key; never the key itself. */
function credentialFingerprint(providerId: string, key: string): string | null {
  return deriveCliAccountKey(CONNECTION_KIND, `${providerId}${FINGERPRINT_SEPARATOR}${key}`);
}

/**
 * Registered = enabled, not `invalid`/`disabled`, and not inside an active cooldown window. An
 * active `cooldownUntil` disqualifies regardless of the reported status, and an unparseable
 * timestamp fails conservatively instead of being treated as usable.
 */
function isUsableEntry(entry: UsableKeyEntry, now: number): boolean {
  if (!entry.enabled) return false;
  if (entry.status === 'invalid' || entry.status === 'disabled') return false;
  if (entry.cooldownUntil !== null) {
    const until = Date.parse(entry.cooldownUntil);
    if (!Number.isFinite(until) || until > now) return false;
  }
  return true;
}

/**
 * Ferry mode: read only the saved Zen provider ('opencode') key. Existing-but-unusable entries fail
 * instead of falling back to the legacy `providerKeys` reference; the legacy reference is used only
 * when there are no per-key entries at all. No other provider is read and no key is overwritten.
 */
async function readFerryZenKey(services: FerryServices): Promise<string> {
  const entries = services.providerKeyEntries.list(ZEN_PROVIDER);
  const now = services.clock.now().getTime();
  const usable = entries.find((entry) => isUsableEntry(entry, now));
  const reference = usable
    ? usable.keyringRef
    : entries.length === 0
      ? services.providerKeys.get(ZEN_PROVIDER)?.keyringRef
      : undefined;
  if (!reference)
    throw typedError(
      'authentication',
      entries.length > 0
        ? 'The saved Ferry Zen credential is disabled, invalid or cooling down. Ferry did not fall back to another provider or the legacy key.'
        : 'No saved Ferry Zen credential is available. No fallback was used.',
    );
  let key: string | undefined;
  try {
    key = await services.secrets.get(reference);
  } catch {
    // Never surface the keyring reference or the underlying storage error: both can name the
    // secret's location. A redacted typed failure keeps the no-fallback contract honest.
    throw typedError(
      'authentication',
      'The selected saved Ferry Zen credential could not be read from the secret store. No substitution was used.',
    );
  }
  if (typeof key !== 'string' || key.length === 0)
    throw typedError(
      'authentication',
      'The selected saved Ferry Zen credential could not be read. No substitution was used.',
    );
  return key;
}

function resolveAnonymous(
  actual: string,
  billing: CliModelCapabilities['billing'],
  offer: string | null,
): OpenCodeCredentialEvidence {
  if (offer !== null)
    throw typedError(
      'authentication',
      'Anonymous OpenCode access cannot use an explicit provider credential. No fallback was used.',
    );
  if (actual !== ZEN_PROVIDER)
    throw typedError(
      'unsupported_capability',
      `Anonymous OpenCode access is only available for the OpenCode Zen provider; "${actual}" is not eligible. No credential fallback was used.`,
    );
  if (billing !== 'free')
    throw typedError(
      'unsupported_capability',
      `Anonymous OpenCode access requires a free OpenCode Zen model; "${billing}" billing is not eligible. No credential fallback was used.`,
    );
  return { mode: 'anonymous', provider: ZEN_PROVIDER, credentialProvider: null, accountKey: null };
}

/** The one approved cross-provider offer: an installed Go credential supplied to a Zen model. */
function isApprovedCrossOffer(actual: string, offer: string | null): boolean {
  return actual === ZEN_PROVIDER && offer === GO_PROVIDER;
}

async function resolveInstalled(
  services: FerryServices,
  actual: string,
  offer: string | null,
): Promise<OpenCodeCredentialEvidence> {
  const crossProvider = offer !== null && offer !== actual;
  // Reject any unapproved cross-provider request before reading the auth store or any secret.
  if (crossProvider && !isApprovedCrossOffer(actual, offer))
    throw typedError(
      'unsupported_capability',
      `Offering the installed "${offer}" credential to the "${actual}" upstream is not supported. No credential was read and no fallback was used.`,
    );
  // The explicit offer (which equals the actual provider when selected natively) or the actual.
  const selectedProvider = offer ?? actual;
  const native = nativeCredentialFor(
    await readNativeRecords(services),
    selectedProvider,
    services.env,
  );
  if (native.state === 'api') {
    rememberSecret(native.key);
    const accountKey = credentialFingerprint(selectedProvider, native.key);
    if (crossProvider)
      // The caller may use this ephemeral secret for a real access check, but must not persist it.
      return {
        mode: 'installed',
        provider: actual,
        credentialProvider: offer,
        accountKey,
        apiKey: native.key,
      };
    // Same-provider credentials stay native-owned: no secret is returned to the caller.
    return { mode: 'installed', provider: actual, credentialProvider: offer, accountKey };
  }
  if (crossProvider)
    throw typedError(
      'authentication',
      native.state === 'oauth' || native.state === 'unknown'
        ? `The installed "${selectedProvider}" credential is not a usable API key, so it cannot be offered to the "${actual}" upstream. No fallback was used.`
        : `No installed OpenCode credential is available for the offered provider "${selectedProvider}". No fallback was used.`,
    );
  // A missing/OAuth/unknown same-provider credential is an honest none-state; a real access check
  // still decides, and no other provider's identity is substituted.
  return { mode: 'installed', provider: actual, credentialProvider: offer, accountKey: null };
}

async function resolveFerry(
  services: FerryServices,
  actual: string,
  offer: string | null,
): Promise<OpenCodeCredentialEvidence> {
  // Ferry mode is the saved Zen key only. Never search another vendor's or Go's key entries.
  if (actual !== ZEN_PROVIDER)
    throw typedError(
      'unsupported_capability',
      `Ferry mode uses the saved OpenCode Zen credential and does not support the "${actual}" upstream. No credential fallback was used.`,
    );
  if (offer !== null && offer !== ZEN_PROVIDER)
    throw typedError(
      'unsupported_capability',
      `Ferry mode only uses the saved OpenCode Zen credential; the offered "${offer}" provider is not supported. No key was read.`,
    );
  const key = await readFerryZenKey(services);
  rememberSecret(key);
  return {
    mode: 'ferry',
    provider: actual,
    credentialProvider: offer,
    accountKey: credentialFingerprint(ZEN_PROVIDER, key),
    apiKey: key,
  };
}

/**
 * Resolve the credential evidence for one OpenCode CLI request *before* dispatch/verification.
 * Unsupported requests reject with a redacted, typed `CliTransportError`; there is never a silent
 * credential or mode fallback.
 */
export async function resolveOpenCodeCredential(
  services: FerryServices,
  model: Pick<CliModelCapabilities, 'upstreamProvider' | 'billing'>,
): Promise<OpenCodeCredentialEvidence> {
  const { mode, offer } = readOpenCodeSettings(services);
  const actual = typeof model.upstreamProvider === 'string' ? model.upstreamProvider.trim() : '';
  if (!actual)
    throw typedError(
      'unsupported_capability',
      'The selected model does not report an OpenCode upstream provider; credential evidence cannot be resolved. No fallback was used.',
    );
  if (mode === 'anonymous') return resolveAnonymous(actual, model.billing, offer);
  if (mode === 'ferry') return await resolveFerry(services, actual, offer);
  return await resolveInstalled(services, actual, offer);
}
