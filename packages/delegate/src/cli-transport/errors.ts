import { redactText } from './redact.js';

/**
 * Normalized transport failure kinds. Core owns quota circuit-breaking, fallback, billing and the
 * connection queue; an adapter never retries on its own and never silently switches model/provider.
 */
export type CliTransportErrorKind =
  | 'exhausted_capacity'
  | 'temporary_rate_limit'
  | 'authentication'
  | 'timeout'
  | 'unavailable_model'
  | 'unsupported_capability'
  | 'cancelled'
  | 'provider_error';

export interface CliTransportErrorDetails {
  /** HTTP-equivalent status code when the protocol exposes one. */
  statusCode?: number;
  /** Opaque, non-secret account identity from the supplied connection. */
  accountKey?: string | null;
  /** Quota bucket that the native CLI named, when reported. */
  bucketId?: string | null;
  /** ISO timestamp of the next known reset, when the CLI reports one. */
  resetAt?: string | null;
  /** Bounded retry hint in milliseconds, only when the CLI reports one. */
  retryAfterMs?: number | null;
}

const DEFAULT_STATUS: Record<CliTransportErrorKind, number> = {
  exhausted_capacity: 429,
  temporary_rate_limit: 429,
  authentication: 401,
  timeout: 504,
  unavailable_model: 404,
  unsupported_capability: 501,
  cancelled: 499,
  provider_error: 502,
};

/**
 * Structured, redacted transport error. Messages are safe to surface: secrets and key material are
 * stripped before they reach `message`.
 */
export class CliTransportError extends Error {
  readonly kind: CliTransportErrorKind;
  readonly statusCode: number;
  readonly accountKey: string | null;
  readonly bucketId: string | null;
  readonly resetAt: string | null;
  readonly retryAfterMs: number | null;

  constructor(
    kind: CliTransportErrorKind,
    message: string,
    details: CliTransportErrorDetails = {},
  ) {
    super(redactText(message));
    this.name = 'CliTransportError';
    this.kind = kind;
    this.statusCode = details.statusCode ?? DEFAULT_STATUS[kind];
    this.accountKey = details.accountKey ?? null;
    this.bucketId = details.bucketId ?? null;
    this.resetAt = details.resetAt ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}

export function isCliTransportError(value: unknown): value is CliTransportError {
  return value instanceof CliTransportError;
}

/** Wrap an arbitrary thrown value, preserving an existing transport error unchanged. */
export function asCliTransportError(
  value: unknown,
  fallbackKind: CliTransportErrorKind = 'provider_error',
): CliTransportError {
  if (isCliTransportError(value)) return value;
  const message = value instanceof Error ? value.message : String(value);
  return new CliTransportError(fallbackKind, message);
}
