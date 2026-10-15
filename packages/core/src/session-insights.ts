import { createHash } from 'node:crypto';
import { SessionModelUsageRepository, type SessionModelUsageRow } from '@ferry/storage';
import {
  ApprovalsPendingSchema,
  CliAccountKeySchema,
  ModelRefSchema,
  redactKnownSecretText,
  SessionModelUsageSchema,
  SessionSchema,
  type ApprovalsPending,
  type Message,
  type MessagePart,
  type ModelRef,
  type Session,
  type SessionId,
  type SessionModelUsage,
} from '@ferry/shared';
import { rpcDomainError } from './host.js';
import type { FerryServices } from './services.js';

const NOT_FOUND_CODE = -32044;
/** Explicit namespace for a legacy bare model id with no provider or connection evidence. */
const UNKNOWN_NAMESPACE = 'unknown';
/** Longest legacy key kept legible under `unknown/`; longer or unsafe keys are fingerprinted. */
const MAX_LEGIBLE_LEGACY_KEY = 128;
/** Safe, non-secret shape for a legible legacy model token. */
const LEGIBLE_LEGACY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]*$/;

function requireSession(services: FerryServices, sessionId: SessionId): void {
  if (!services.sessions.get(sessionId))
    throw rpcDomainError(NOT_FOUND_CODE, 'not_found', `Session not found: ${sessionId}`);
}

/** A schema-valid `unknown/<token>` ref that never carries credentials and stays distinct per key. */
function unknownModelRef(raw: string): ModelRef {
  if (raw.length > 0 && raw.length <= MAX_LEGIBLE_LEGACY_KEY && LEGIBLE_LEGACY_KEY.test(raw)) {
    const legible = ModelRefSchema.safeParse(`${UNKNOWN_NAMESPACE}/${raw}`);
    if (legible.success) return legible.data;
  }
  // Malformed, oversized or unsafe keys collapse to a stable non-reversible fingerprint so two
  // different opaque keys stay distinct without echoing raw material.
  const fingerprint = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return ModelRefSchema.parse(`${UNKNOWN_NAMESPACE}/${fingerprint}`);
}

interface CanonicalRef {
  modelRef: ModelRef;
  /** True when neither provider nor connection evidenced the namespace. */
  unknownProvenance: boolean;
}

/**
 * Canonicalizes a durable usage row's model key into a schema-valid `ModelRef`.
 *
 * Fully-qualified refs are retained verbatim. A legacy bare id is namespaced with its reported
 * provider, then connection, so it never collides with an equivalent qualified row. When neither is
 * known the id is placed under an explicit `unknown/` namespace instead of guessing a provider from
 * the model name. Malformed or unsafe legacy keys become a stable `unknown/` fingerprint, so a row
 * is never silently dropped and totals stay consistent.
 */
function canonicalModelRef(row: SessionModelUsageRow): CanonicalRef {
  const direct = ModelRefSchema.safeParse(row.modelRef);
  if (direct.success) return { modelRef: direct.data, unknownProvenance: false };
  const namespace = row.providerId ?? row.connectionId;
  if (namespace !== null && namespace.length > 0) {
    const namespaced = ModelRefSchema.safeParse(`${namespace}/${row.modelRef}`);
    if (namespaced.success) return { modelRef: namespaced.data, unknownProvenance: false };
  }
  return { modelRef: unknownModelRef(row.modelRef), unknownProvenance: true };
}

function sumNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return left + right;
}

function laterTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return right > left ? right : left;
}

function validAccountKey(value: string | null): string | null {
  return value !== null && CliAccountKeySchema.safeParse(value).success ? value : null;
}

/**
 * Two provenance values are compatible only when they are exactly equal. Unknown (`null`) is its own
 * bucket and is never folded into a known value, so differently evidenced rows stay separate.
 */
function compatible(left: string | null, right: string | null): boolean {
  return left === right;
}

interface MergedModelUsage {
  modelRef: ModelRef;
  providerId: string | null;
  connectionId: string | null;
  accountKey: string | null;
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  lastUsedAt: string | null;
  unreportedRequests: number;
  unknownProvenance: boolean;
}

/**
 * Folds alias rows onto one canonical ref, summing nullable dimensions without inventing zeros.
 *
 * Storage now keeps an exact `(model, provider, connection, account)` bucket, so rows only merge when
 * their canonical ref and whole provenance are identical (including two legacy aliases that share
 * the same provenance). Differently evidenced rows — including an unknown-provenance row next to a
 * known one — are kept as separate entries and never collapsed onto an arbitrary first value.
 */
function mergeUsageRows(rows: readonly SessionModelUsageRow[]): MergedModelUsage[] {
  const byRef = new Map<string, SessionModelUsageRow[]>();
  for (const row of rows) {
    const { modelRef } = canonicalModelRef(row);
    const group = byRef.get(modelRef);
    if (group) group.push(row);
    else byRef.set(modelRef, [row]);
  }
  const merged: MergedModelUsage[] = [];
  for (const group of byRef.values()) {
    const clusters: MergedModelUsage[] = [];
    for (const row of group) {
      const canonical = canonicalModelRef(row);
      const accountKey = validAccountKey(row.accountKey);
      const target = clusters.find(
        (cluster) =>
          compatible(cluster.providerId, row.providerId) &&
          compatible(cluster.connectionId, row.connectionId) &&
          compatible(cluster.accountKey, accountKey),
      );
      if (!target) {
        clusters.push({
          modelRef: canonical.modelRef,
          providerId: row.providerId,
          connectionId: row.connectionId,
          accountKey,
          requests: row.requests,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cachedTokens: row.cachedTokens,
          reasoningTokens: row.reasoningTokens,
          lastUsedAt: row.lastUsedAt,
          unreportedRequests: row.unreportedRequests,
          unknownProvenance: canonical.unknownProvenance,
        });
        continue;
      }
      target.providerId ??= row.providerId;
      target.connectionId ??= row.connectionId;
      target.accountKey ??= accountKey;
      target.requests += row.requests;
      target.inputTokens = sumNullable(target.inputTokens, row.inputTokens);
      target.outputTokens = sumNullable(target.outputTokens, row.outputTokens);
      target.cachedTokens = sumNullable(target.cachedTokens, row.cachedTokens);
      target.reasoningTokens = sumNullable(target.reasoningTokens, row.reasoningTokens);
      target.lastUsedAt = laterTimestamp(target.lastUsedAt, row.lastUsedAt);
      target.unreportedRequests += row.unreportedRequests;
      target.unknownProvenance ||= canonical.unknownProvenance;
    }
    merged.push(...clusters);
  }
  return merged.sort((a, b) => {
    const refOrder = a.modelRef.localeCompare(b.modelRef);
    if (refOrder !== 0) return refOrder;
    const providerOrder = (a.providerId ?? '').localeCompare(b.providerId ?? '');
    if (providerOrder !== 0) return providerOrder;
    const connectionOrder = (a.connectionId ?? '').localeCompare(b.connectionId ?? '');
    if (connectionOrder !== 0) return connectionOrder;
    return (a.accountKey ?? '').localeCompare(b.accountKey ?? '');
  });
}

/**
 * Reads one session's durable per-model usage aggregate. Missing token dimensions stay `null`
 * ("Not reported"); a reported zero stays `0`. Legacy bare model ids are merged onto the matching
 * qualified ref, but differently evidenced provider/connection/account rows stay distinct. Unknown
 * or malformed account keys are redacted to `null` rather than surfaced.
 *
 * Coverage comes from the repository: `coverage.since` is the real earliest retained usage-ledger
 * event timestamp (or null without ledger evidence), never a per-model `lastUsedAt` and never
 * fabricated. `coverage.missing` is true when the retained evidence cannot prove full-lifetime
 * coverage (historical/backfilled or legacy-uncovered rows), when primary dimensions are incomplete,
 * or when a model's provenance could not be attributed. A missing session throws `not_found` without
 * leaking another conversation's usage.
 */
export function sessionModelUsage(
  services: FerryServices,
  sessionId: SessionId,
): SessionModelUsage {
  requireSession(services, sessionId);
  const summary = new SessionModelUsageRepository(services.db.client).getBySession(sessionId);
  const mergedRows = mergeUsageRows(summary.rows);
  const models = mergedRows.map((row) => ({
    modelRef: row.modelRef,
    providerId: row.providerId,
    connectionId: row.connectionId,
    accountKey: row.accountKey,
    requests: row.requests,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedTokens: row.cachedTokens,
    reasoningTokens: row.reasoningTokens,
    lastUsedAt: row.lastUsedAt,
    unreportedRequests: row.unreportedRequests,
  }));
  const unknownProvenance = mergedRows.some((row) => row.unknownProvenance);
  return SessionModelUsageSchema.parse({
    sessionId,
    totals: {
      requests: summary.totals.requests,
      inputTokens: summary.totals.inputTokens,
      outputTokens: summary.totals.outputTokens,
      cachedTokens: summary.totals.cachedTokens,
      reasoningTokens: summary.totals.reasoningTokens,
    },
    models,
    incomplete: summary.incomplete,
    coverage: {
      since: summary.coverage.since,
      missing: summary.coverage.unknown || summary.incomplete || unknownProvenance,
    },
  });
}

/**
 * Reads only messages for the given sessions through the repository's indexed, bounded lookup
 * (`MessageRepository.listForSessions`) so idle sessions' transcripts are never materialized. The
 * repository skips an individual corrupt legacy row; a real query/infrastructure failure is surfaced
 * here as a redacted domain error instead of being swallowed into an empty approvals list.
 */
function readMessagesForSessions(
  services: FerryServices,
  sessionIds: readonly string[],
): Message[] {
  try {
    return services.messages.listForSessions(sessionIds);
  } catch (error) {
    throw rpcDomainError(
      -32004,
      'unavailable',
      `Could not read pending approvals: ${redactKnownSecretText(
        error instanceof Error ? error.message : 'storage error',
      )}`,
    );
  }
}

/**
 * One actionable snapshot of every session currently awaiting approval. Only pending approval parts
 * in sessions still in the `awaiting_approval` state are returned; resolved (allowed/denied) parts
 * and removed/other sessions are excluded. Candidate sessions are found from the session list and
 * their messages are read in bounded filtered queries, never a per-conversation detail fan-out.
 * Approval permissions and run/resume execution are untouched.
 */
export function pendingApprovalSummary(services: FerryServices): ApprovalsPending {
  const awaiting = services.sessions
    .list()
    .filter((session) => session.status === 'awaiting_approval');
  const updatedAt = services.clock.now().toISOString();
  if (awaiting.length === 0) return ApprovalsPendingSchema.parse({ entries: [], updatedAt });
  const sessionsById = new Map<string, Session>();
  for (const session of awaiting) sessionsById.set(session.id, session);
  const entries: ApprovalsPending['entries'] = [];
  for (const message of readMessagesForSessions(
    services,
    awaiting.map((session) => session.id),
  )) {
    const session = sessionsById.get(message.sessionId);
    if (!session) continue;
    for (const part of message.parts) {
      if (part.type !== 'approval_request' || part.state !== 'pending') continue;
      entries.push({
        sessionId: session.id,
        title: session.title,
        partId: part.id,
        kind: part.kind,
        summary: part.summary,
        detail: part.detail,
        risk: part.risk,
      });
    }
  }
  entries.sort((left, right) => {
    const leftUpdated = sessionsById.get(left.sessionId)?.updatedAt ?? '';
    const rightUpdated = sessionsById.get(right.sessionId)?.updatedAt ?? '';
    if (leftUpdated !== rightUpdated) return rightUpdated.localeCompare(leftUpdated);
    if (left.sessionId !== right.sessionId) return left.sessionId.localeCompare(right.sessionId);
    return left.partId.localeCompare(right.partId);
  });
  return ApprovalsPendingSchema.parse({ entries, updatedAt });
}

/** A persisted message part that carries a genuine model reply (text, reasoning or tool output). */
function isReplyPart(part: MessagePart): boolean {
  if (part.type === 'text' || part.type === 'reasoning') return part.text.trim().length > 0;
  if (part.type === 'tool_call') return part.output !== null;
  return false;
}

/** The producing model recorded on a reply part, when the adapter reported one. */
function partProducingModel(part: MessagePart): ModelRef | null {
  return part.type === 'text' || part.type === 'reasoning' || part.type === 'tool_call'
    ? (part.producedBy ?? null)
    : null;
}

/**
 * The honest, non-logical model recorded on a message. A logical Gateway key ref
 * (`gateway/<keyId>`) routes a request but is never itself the LLM that produced the reply, so it is
 * reported as unknown (`null`) rather than claimed as the responder.
 */
function honestMessageModel(message: Message): ModelRef | null {
  const ref = message.modelRef;
  if (!ref || ref.startsWith('gateway/')) return null;
  return ref;
}

/** Chronological order (createdAt, then id) so "latest" is well-defined for id-ordered storage. */
function orderedMessages(messages: readonly Message[]): Message[] {
  return [...messages].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

interface EligibleReply {
  /** Index of the qualifying message in the ordered message list. */
  index: number;
  /** The model that produced it, or `null` when the reply was recorded without one. */
  model: ModelRef | null;
}

/**
 * The latest assistant message that actually carries a reply (text, reasoning or tool output). A
 * user/system/empty-placeholder/error-only message never replaces an earlier reply.
 *
 * Only the LATEST eligible part decides attribution: its actual `producedBy` wins, so a fallback
 * producer that wrote the trailing text outranks an earlier reasoning/tool producer. When that
 * latest part has no producer the result is honest about unknown provenance — it uses the message's
 * non-logical `modelRef` or `null` and never borrows an older part's producer or claims a logical
 * Gateway key was the LLM.
 */
function latestEligibleReply(messages: readonly Message[]): EligibleReply | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    const replyParts = message.parts.filter(isReplyPart);
    if (replyParts.length === 0) continue;
    const latestPart = replyParts.at(-1);
    const producedBy = latestPart ? partProducingModel(latestPart) : null;
    return { index, model: producedBy ?? honestMessageModel(message) };
  }
  return null;
}

/** A run that is still in progress, so its trailing reply may not be finalized yet. */
function isActivelyRunning(session: Session): boolean {
  return (
    session.inFlight === true ||
    session.status === 'running' ||
    session.status === 'awaiting_approval'
  );
}

/**
 * The model that produced the session's most recent genuine assistant reply, or `null` when there is
 * no reply or the latest reply recorded no model. A part's actual `producedBy` takes precedence over
 * the message's initial/logical `modelRef`. Messages are ordered chronologically first, so the
 * id-ordered storage list is handled correctly.
 */
export function lastRespondingModel(messages: readonly Message[]): ModelRef | null {
  return latestEligibleReply(orderedMessages(messages))?.model ?? null;
}

/**
 * Returns the session summary with `lastReplyModelRef` set from its own retained messages. Session
 * id, title, project and profile are untouched. The actual producer recorded on a reply part wins
 * over the message's initial model. While the run is actively working the trailing reply may still
 * be streaming, so the existing value is preserved until a finalized reply is eligible; only then is
 * it (re)written, including an honest `null` when the reply recorded no model. This never consults
 * `pinnedModelRef`, a Gateway logical key or a router prediction.
 */
export function sessionSummaryWithLastReply(
  session: Session,
  messages: readonly Message[],
): Session {
  const ordered = orderedMessages(messages);
  const reply = latestEligibleReply(ordered);
  if (!reply) return SessionSchema.parse(session);
  const trailing = reply.index === ordered.length - 1;
  if (trailing && isActivelyRunning(session)) return SessionSchema.parse(session);
  return SessionSchema.parse({ ...session, lastReplyModelRef: reply.model });
}

/**
 * Batch form of {@link sessionSummaryWithLastReply} for list/backfill callers: maps each session to
 * its summary using the supplied per-session messages. Sessions without messages keep their summary.
 */
export function sessionSummariesWithLastReply(
  sessions: readonly Session[],
  messagesBySession: ReadonlyMap<string, readonly Message[]>,
): Session[] {
  return sessions.map((session) =>
    sessionSummaryWithLastReply(session, messagesBySession.get(session.id) ?? []),
  );
}

/**
 * Idempotent lazy backfill for summaries that predate `lastReplyModelRef`. Only sessions whose stored
 * value has never been computed (`undefined`) are considered, so a caller re-listing after the first
 * pass does no message reads at all. A session with no eligible reply is recorded as an honest
 * `null`, marking it resolved so it is never re-scanned on later lists. An already-recorded value
 * (including `null`) and a session actively streaming a trailing reply are left untouched.
 *
 * Callers pass only the indexed per-session messages for the sessions that still need a value, so no
 * unrelated conversation's transcript is ever materialized.
 */
export function sessionSummariesWithLastReplyBackfilled(
  sessions: readonly Session[],
  messagesBySession: ReadonlyMap<string, readonly Message[]>,
): Session[] {
  return sessions.map((session) => {
    if (session.lastReplyModelRef !== undefined) return session;
    const summary = sessionSummaryWithLastReply(session, messagesBySession.get(session.id) ?? []);
    return summary.lastReplyModelRef === undefined
      ? SessionSchema.parse({ ...summary, lastReplyModelRef: null })
      : summary;
  });
}
