import type { CliAccountKey, CliConnection, CliModelCapabilities, CliOption } from '@ferry/shared';
import { CliTransportError } from './errors.js';
import type { CliTransportInput } from './types.js';

export const FERRY_CLIENT_NAME = 'Ferry';
export const FERRY_CLIENT_VERSION = '0.9.0';

/** The one reasoning-effort token this beta refuses to run: it silently launches native subagents. */
const ULTRA_EFFORT = 'ultra';

export interface ResolvedOptions {
  effort: string | null;
  speed: 'standard' | 'fast';
}

/**
 * Reject anything the supplied discovered capabilities do not actually support, before any prompt is
 * sent. Core already filtered images/structured output; deferred models/options are rejected here.
 */
export function assertCodexCompatible(input: CliTransportInput): void {
  assertCommon(input, 'codex-cli');
}

export function assertClaudeCompatible(input: CliTransportInput): void {
  assertCommon(input, 'claude-code-cli');
}

function assertCommon(input: CliTransportInput, kind: 'codex-cli' | 'claude-code-cli'): void {
  const { connection, model } = input;
  if (connection.kind !== kind)
    throw new CliTransportError(
      'provider_error',
      `Connection ${connection.id} is not a ${kind} connection`,
    );
  if (model.connectionId !== connection.id || model.providerId !== connection.id)
    throw new CliTransportError(
      'unsupported_capability',
      `Model ${model.ref} does not belong to connection ${connection.id}`,
    );
  if (!model.modalities.includes('text'))
    throw new CliTransportError(
      'unsupported_capability',
      `Model ${model.upstreamId} does not support text input`,
    );
  if (connection.account.state === 'signed_out')
    throw new CliTransportError('authentication', `${kind} is not signed in`, {
      accountKey: connection.account.key,
    });
  if (input.tools.length > 0 && !model.toolCalling)
    throw new CliTransportError(
      'unsupported_capability',
      `Model ${model.upstreamId} does not support caller tools`,
    );
}

/** Resolve and validate the requested effort/speed against the discovered model capabilities. */
export function resolveOptions(
  input: CliTransportInput,
  model: CliModelCapabilities,
  options: CliOption,
): ResolvedOptions {
  // Never inherit the CLI's native/global configured effort: when the caller leaves effort unset,
  // pin the discovered model default explicitly (and reject an unsupported/ultra default).
  const explicit = options.effort ?? null;
  const advertisedDefault = model.defaultEffort ?? null;
  const effort = explicit ?? advertisedDefault;
  if (explicit === null && advertisedDefault !== null) {
    if (advertisedDefault === ULTRA_EFFORT)
      throw new CliTransportError(
        'unsupported_capability',
        `The advertised default reasoning effort for ${model.upstreamId} is "ultra", which delegates to native subagents Ferry cannot isolate`,
      );
    if (!model.efforts.includes(advertisedDefault))
      throw new CliTransportError(
        'unsupported_capability',
        `The advertised default reasoning effort "${advertisedDefault}" for ${model.upstreamId} is not in its supported efforts`,
      );
  }
  if (effort !== null) {
    if (effort === ULTRA_EFFORT)
      throw new CliTransportError(
        'unsupported_capability',
        'Ultra reasoning delegates to native subagents, whose isolation Ferry cannot guarantee',
      );
    if (!model.efforts.includes(effort))
      throw new CliTransportError(
        'unsupported_capability',
        `Reasoning effort "${effort}" is not advertised for ${model.upstreamId}`,
      );
  }
  if (options.speed === 'fast' && !model.speeds.includes('fast'))
    throw new CliTransportError(
      'unsupported_capability',
      `Fast speed is not advertised for ${model.upstreamId}`,
    );
  return { effort, speed: options.speed };
}

/** True when the supplied connection authoritatively names a different account than required. */
export function accountKeyOf(connection: CliConnection): CliAccountKey | null {
  return connection.account.key;
}

/** Normalize a plan/subscription label for comparison; `null`/empty/`unknown` mean "not known". */
export function normalizePlan(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length === 0 || normalized === 'unknown' ? null : normalized;
}

/** Compare two known plan labels, tolerating display wrappers like "Claude Pro" vs "pro". */
export function plansMatch(a: string, b: string): boolean {
  return a === b || a.includes(b) || b.includes(a);
}
