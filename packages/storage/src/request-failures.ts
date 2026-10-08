import type Database from 'better-sqlite3';
import {
  COUNTED_FAILURE_KINDS,
  FailureEntrySchema,
  ModelRefSchema,
  redactFailureMessage,
  type FailureEntry,
  type FailureOptions,
  type Provider,
  type ProviderFailures,
} from '@ferry/shared';

type StoredFailure = FailureEntry & { sequence: number };
interface SuccessState {
  last_success_at: string | null;
  reset_after_id: number;
}
const DAY = 24 * 60 * 60 * 1000;

/** Durable attempts; row sequences keep resets correct even with an unchanged clock. */
export class RequestFailureRepository {
  constructor(private readonly db: Database.Database) {}

  put(entry: FailureEntry): void {
    const value = FailureEntrySchema.parse({
      ...entry,
      message: redactFailureMessage(entry.message),
      counted: COUNTED_FAILURE_KINDS.includes(entry.kind) ? 1 : 0,
    });
    this.db
      .prepare(
        `INSERT INTO request_failures
      (id, at, provider_id, model_ref, key_id, request_id, session_id, source, kind, status_code, message, counted)
      VALUES (@id, @at, @providerId, @modelRef, @keyId, @requestId, @sessionId, @source, @kind, @statusCode, @message, @counted)`,
      )
      .run(value);
  }

  success(providerId: string, modelRef: string, at: string): void {
    this.db.transaction(() => {
      this.reset(providerId, '', at);
      this.reset(providerId, modelRef, at);
    })();
  }

  reset(providerId: string, modelRef = '', successAt?: string): void {
    this.db
      .prepare(
        `INSERT INTO request_failure_state (provider_id, model_ref, last_success_at, reset_after_id)
      VALUES (?, ?, ?, (SELECT coalesce(max(rowid),0) FROM request_failures))
      ON CONFLICT(provider_id, model_ref) DO UPDATE SET
      last_success_at=coalesce(excluded.last_success_at,last_success_at), reset_after_id=excluded.reset_after_id`,
      )
      .run(providerId, modelRef, successAt ?? null);
  }

  clear(providerId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM request_failures WHERE provider_id = ?').run(providerId);
      // Reset all baselines after deletion; keep genuine last-success timestamps.
      this.db
        .prepare('UPDATE request_failure_state SET reset_after_id = 0 WHERE provider_id = ?')
        .run(providerId);
    })();
  }

  prune(now = new Date()): number {
    return this.db
      .prepare('DELETE FROM request_failures WHERE at < ?')
      .run(new Date(now.getTime() - 30 * DAY).toISOString()).changes;
  }

  private state(providerId: string, modelRef = ''): SuccessState {
    return (
      (this.db
        .prepare(
          'SELECT last_success_at, reset_after_id FROM request_failure_state WHERE provider_id=? AND model_ref=?',
        )
        .get(providerId, modelRef) as SuccessState | undefined) ?? {
        last_success_at: null,
        reset_after_id: 0,
      }
    );
  }

  summary(
    providers: readonly Pick<Provider, 'id' | 'pausedReason'>[],
    now: Date,
    providerId?: string,
    options: FailureOptions = {},
  ): ProviderFailures {
    const cutoff24 = new Date(now.getTime() - DAY).toISOString();
    const cutoff7 = new Date(now.getTime() - 7 * DAY).toISOString();
    const recentCutoff = new Date(
      now.getTime() - (options.sinceHours ?? 168) * 60 * 60 * 1000,
    ).toISOString();
    const select = `SELECT rowid AS sequence, id, at, provider_id AS providerId, model_ref AS modelRef,
      key_id AS keyId, request_id AS requestId, session_id AS sessionId, source, kind,
      status_code AS statusCode, message, counted FROM request_failures`;
    const rows = this.db
      .prepare(
        `${select} WHERE at >= ? ${providerId ? 'AND provider_id = ?' : ''} ORDER BY at DESC, rowid DESC`,
      )
      .all(
        ...(providerId
          ? [new Date(now.getTime() - 30 * DAY).toISOString(), providerId]
          : [new Date(now.getTime() - 30 * DAY).toISOString()]),
      ) as StoredFailure[];
    const distinct = (values: readonly StoredFailure[]) =>
      new Set(values.map((row) => row.requestId)).size;
    const counts = (values: readonly StoredFailure[], state: SuccessState) => {
      const week = values.filter((row) => row.at >= cutoff7);
      const day = week.filter((row) => row.at >= cutoff24);
      return {
        failed24h: distinct(day),
        failed7d: distinct(week),
        byKind: Object.fromEntries(
          [...new Set(week.map((row) => row.kind))].map((kind) => [
            kind,
            distinct(week.filter((row) => row.kind === kind)),
          ]),
        ),
        lastError: values[0]?.message ?? null,
        lastFailureAt: values[0]?.at ?? null,
        lastSuccessAt: state.last_success_at,
      };
    };
    return {
      providers: providers
        .filter((provider) => !providerId || provider.id === providerId)
        .map((provider) => {
          const values = rows.filter((row) => row.providerId === provider.id);
          const state = this.state(provider.id);
          const counted = values.filter((row) => row.counted === 1 && row.at >= cutoff24);
          const modelRefs = new Set(values.map((row) => row.modelRef));
          for (const row of this.db
            .prepare(
              "SELECT model_ref FROM request_failure_state WHERE provider_id=? AND model_ref != ''",
            )
            .all(provider.id) as { model_ref: string }[])
            modelRefs.add(ModelRefSchema.parse(row.model_ref));
          return {
            providerId: provider.id,
            ...counts(values, state),
            counted24h: distinct(counted),
            consecutive: distinct(counted.filter((row) => row.sequence > state.reset_after_id)),
            paused: provider.pausedReason ?? null,
            models: [...modelRefs].map((modelRef) => {
              const models = values.filter((row) => row.modelRef === modelRef);
              const success = this.state(provider.id, modelRef);
              return {
                modelRef,
                ...counts(models, success),
                failing:
                  distinct(models.filter((row) => row.counted === 1 && row.at >= cutoff24)) >= 3 &&
                  (!success.last_success_at || success.last_success_at < cutoff24),
              };
            }),
          };
        }),
      recent: rows
        .filter((row) => row.at >= recentCutoff)
        .slice(0, options.limit ?? 20)
        .map(({ sequence: _sequence, ...row }) => row),
    };
  }
}
