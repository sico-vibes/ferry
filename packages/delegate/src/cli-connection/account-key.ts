import { createHash } from 'node:crypto';
import type { CliConnectionKind } from '@ferry/shared';

/** SHA-256 hex fingerprint (24 chars) of non-secret material. Never reversible to the input. */
export function cliAccountFingerprint(material: string): string {
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 24);
}

/**
 * Derive the opaque, non-secret account key from a returned account identity (email/org/account id)
 * or, when the CLI's auth record has no identity, a memory-only fingerprint of a high-entropy key.
 * Returns `null` when no identity can be established (e.g. anonymous access).
 */
export function deriveCliAccountKey(
  kind: CliConnectionKind,
  identity: string | null | undefined,
): string | null {
  const trimmed = identity?.trim();
  if (!trimmed) return null;
  return `${kind}:${cliAccountFingerprint(trimmed)}`;
}
