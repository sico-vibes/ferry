import { redactKnownSecretText } from '@ferry/shared';
import { type OutboxRepository, type OutboxEntry } from '@ferry/storage';
import { FERRY_CLOUD_SCHEMA } from './config.js';
import type { FerrySupabaseClient } from './client.js';
import { redactCloudPayload } from './redaction.js';
import { createHydrationCounts, type HydrationCounts } from './hydrate.js';

/** Drains durable outbox rows, retrying network and server errors with bounded backoff. */
export class CloudSyncWorker {
  #timer: ReturnType<typeof setInterval> | undefined;
  #signedIn = false;
  #running = false;
  #hydrating = false;
  #abortController: AbortController | undefined;
  lastError: string | null = null;
  lastFlush: string | null = null;
  hydrationCounts: HydrationCounts = createHydrationCounts();
  constructor(
    private readonly client: FerrySupabaseClient,
    private readonly outbox: OutboxRepository,
    private readonly schema = FERRY_CLOUD_SCHEMA,
    private readonly applyHydratedRows?: (
      table: string,
      rows: Record<string, unknown>[],
    ) => Promise<HydrationCounts | undefined> | HydrationCounts | undefined,
    private readonly options: CloudSyncWorkerOptions = {},
  ) {}
  setSignedIn(value: boolean): void {
    this.#signedIn = value;
    if (value) void this.flush({ timeoutMs: 20_000 });
    else this.#abortController?.abort();
  }
  start(intervalMs = 2_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.flush({ timeoutMs: intervalMs });
    }, intervalMs);
    this.#timer.unref();
  }
  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
  status(): { pending: number; lastError: string | null; lastFlush: string | null } {
    return {
      pending: this.outbox.counts().pending,
      lastError: this.lastError,
      lastFlush: this.lastFlush,
    };
  }
  async flush(options: { timeoutMs: number }): Promise<void> {
    const now = this.options.now ?? Date.now;
    const end = now() + options.timeoutMs;
    if (!this.#signedIn) return;
    while (this.#running && now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (this.#running || now() >= end) return;
    this.#running = true;
    const controller = new AbortController();
    this.#abortController = controller;
    const timeout = setTimeout(
      () => {
        controller.abort();
      },
      Math.max(1, options.timeoutMs),
    );
    timeout.unref();
    try {
      while (now() < end) {
        const rows = orderOutboxRows(this.outbox.claimDue(100, new Date(now()).toISOString()));
        if (!rows.length) break;
        await this.sendRows(rows, controller.signal);
      }
      this.lastFlush = new Date().toISOString();
    } finally {
      clearTimeout(timeout);
      this.#abortController = undefined;
      this.#running = false;
    }
  }
  private async sendRows(rows: OutboxEntry[], signal: AbortSignal): Promise<void> {
    const now = this.options.now ?? Date.now;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row) continue;
      const group = [row];
      if (row.op === 'upsert') {
        for (let next = index + 1; next < rows.length; next += 1) {
          const candidate = rows[next];
          if (candidate?.op !== 'upsert' || candidate.target !== row.target) break;
          group.push(candidate);
        }
      }
      index += group.length - 1;
      try {
        const payloads = group.map(
          (entry) => JSON.parse(entry.payloadJson) as Record<string, unknown>,
        );
        const payload = payloads[0] ?? {};
        const conflict =
          row.target === 'settings_kv'
            ? 'user_id,key'
            : row.target === 'profiles'
              ? 'user_id'
              : row.target === 'task_records'
                ? 'user_id,session_id'
                : row.target === 'sync_records'
                  ? 'user_id,kind,id'
                  : 'user_id,id';
        const request =
          row.op === 'delete'
            ? applyDelete(this.client, this.schema, row.target, payload)
            : row.op === 'insert'
              ? this.client.schema(this.schema).from(row.target).insert(payload)
              : row.target === 'provider_keys'
                ? this.client
                    .schema(this.schema)
                    .from(row.target)
                    .update(
                      Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'id')),
                    )
                    .eq('id', String(payload.id))
                : this.client
                    .schema(this.schema)
                    .from(row.target)
                    .upsert(group.length === 1 ? payload : payloads, { onConflict: conflict });
        const result = await withAbortSignal(request, signal);
        if (result.error)
          throw Object.assign(new Error(result.error.message), {
            code: result.error.code,
            httpStatus: getHttpStatus(result.error),
          });
        for (const entry of group)
          this.outbox.markDone(entry.id, entry.generation, new Date(now()).toISOString());
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Cloud sync failed';
        const safeError = redactCloudPayload(redactKnownSecretText(message));
        this.lastError = typeof safeError === 'string' ? safeError : 'Cloud sync failed';
        const code =
          (error as { status?: string; code?: string }).code ??
          (error as { status?: string }).status ??
          '';
        const status = Number(
          (error as { httpStatus?: number; status?: number }).httpStatus ??
            (error as { status?: number }).status,
        );
        const foreignKey = code === '23503';
        const transient =
          foreignKey ||
          status === 401 ||
          status === 408 ||
          status === 429 ||
          (status >= 500 && status <= 599) ||
          /network|fetch failed|jwt expired|token expired|abort/i.test(message) ||
          /^E(?:CONN|HOST|AI_|PIPE|TIMEDOUT)/i.test(code);
        const permanentCap = foreignKey
          ? (this.options.foreignKeyAttemptCap ?? 25)
          : (this.options.permanentAttemptCap ?? 4);
        const permanentClass =
          /^(?:42501|23\d\d\d|22\d\d\d|PGRST)/.test(code) ||
          (status >= 400 && status < 500 && ![401, 408, 429].includes(status)) ||
          /permission|constraint|violat|schema cache/i.test(message);
        for (const entry of group) {
          if (
            (foreignKey && entry.attempts + 1 >= (this.options.foreignKeyAttemptCap ?? 25)) ||
            (permanentClass && !foreignKey && !transient && entry.attempts + 1 >= permanentCap)
          ) {
            this.outbox.markPermanent(
              entry.id,
              entry.generation,
              message,
              new Date(now()).toISOString(),
            );
            continue;
          }
          const delay =
            (this.options.backoffMs?.(entry.attempts) ??
              Math.min(300_000, 1000 * 2 ** Math.min(entry.attempts, 8))) *
            (this.options.jitter?.() ?? 0.75 + (this.options.random ?? Math.random)() * 0.5);
          this.outbox.markRetry(
            entry.id,
            entry.generation,
            message,
            new Date(now() + delay).toISOString(),
            new Date(now()).toISOString(),
          );
        }
      }
    }
  }
  async hydrate(): Promise<void> {
    if (!this.#signedIn || this.#hydrating) return;
    this.#hydrating = true;
    this.hydrationCounts = createHydrationCounts();
    try {
      for (const table of ['workspaces', 'sessions', 'messages', 'task_records', 'settings_kv']) {
        const { data, error } = await this.client.schema(this.schema).from(table).select('*');
        if (!error && Array.isArray(data) && this.applyHydratedRows) {
          const counts = await this.applyHydratedRows(table, data as Record<string, unknown>[]);
          if (counts) {
            this.hydrationCounts.inserted += counts.inserted;
            this.hydrationCounts.updatedSessions += counts.updatedSessions;
            this.hydrationCounts.skippedExisting += counts.skippedExisting;
            this.hydrationCounts.skippedCaptureOff += counts.skippedCaptureOff;
            this.hydrationCounts.skippedInvalid += counts.skippedInvalid;
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Cloud hydration failed';
      const safe = redactCloudPayload(redactKnownSecretText(message));
      this.lastError = typeof safe === 'string' ? safe : 'Cloud hydration failed';
    } finally {
      this.#hydrating = false;
    }
  }
}

/** Clock, jitter and retry-policy injection for deterministic worker tests. */
export interface CloudSyncWorkerOptions {
  now?: () => number;
  random?: () => number;
  jitter?: () => number;
  backoffMs?: (attempts: number) => number;
  permanentAttemptCap?: number;
  foreignKeyAttemptCap?: number;
}

function orderOutboxRows(rows: OutboxEntry[]): OutboxEntry[] {
  const rank = (target: string): number => {
    if (target === 'workspaces' || target === 'devices') return 0;
    if (target === 'sessions') return 1;
    if (target === 'messages') return 2;
    if (target === 'task_records' || target === 'turns') return 3;
    if (target === 'model_switches' || target === 'sync_records' || target === 'logs') return 4;
    return 5;
  };
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row.target) - rank(b.row.target) || a.index - b.index)
    .map(({ row }) => row);
}

function withAbortSignal<T>(query: T, signal: AbortSignal): T {
  if (typeof query !== 'object' || query === null || !('abortSignal' in query)) return query;
  const abortSignal = (query as { abortSignal?: (value: AbortSignal) => unknown }).abortSignal;
  return typeof abortSignal === 'function' ? (abortSignal.call(query, signal) as T) : query;
}

function applyDelete(
  client: FerrySupabaseClient,
  schema: string,
  table: string,
  payload: Record<string, unknown>,
) {
  let query = client.schema(schema).from(table).delete();
  const key =
    typeof payload.key === 'string'
      ? 'key'
      : typeof payload.session_id === 'string'
        ? 'session_id'
        : 'id';
  query = query.eq(key, String(payload[key]));
  if (typeof payload.kind === 'string') query = query.eq('kind', payload.kind);
  return query;
}

function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
  const status: unknown = error.status;
  return typeof status === 'number' ? status : undefined;
}
