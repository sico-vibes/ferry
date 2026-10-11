import type { PaidCaps } from '@ferry/shared';
import type { FerryServices } from './services.js';

export class BudgetError extends Error {
  readonly code = 'budget_exhausted';
  readonly statusCode = 402;
}

interface Reservation {
  id: string;
  keyId?: string;
  profileId: string;
  sessionId: string;
  amountUsd: number;
  keyCaps?: PaidCaps;
  profileCaps: PaidCaps;
  globalCaps: PaidCaps;
}

/** Synchronous SQLite transaction: no dispatch can interleave the check and reservation. */
export function reserveSpend(services: FerryServices, input: Reservation) {
  const db = services.db.client;
  const at = services.clock.now().toISOString();
  db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT key_id,profile_id,session_id,at,amount_usd FROM spend_reservations
      UNION ALL SELECT key_id,profile_id,session_id,at,amount_usd FROM spend_charges`,
      )
      .all() as {
      key_id: string | null;
      profile_id: string;
      session_id: string;
      at: string;
      amount_usd: number;
    }[];
    // Include pre-migration agent usage and compacted usage. New calls are represented in charges.
    const historic = db
      .prepare(
        `SELECT session_id,ts AS at,cost_usd AS amount_usd FROM requests
      WHERE cost_usd > 0
      UNION ALL SELECT NULL AS session_id,day AS at,cost_usd AS amount_usd FROM usage_daily`,
      )
      .all() as { session_id: string | null; at: string; amount_usd: number }[];
    const globalPending = db
      .prepare(
        `SELECT session_id,at,amount_usd FROM spend_reservations
      UNION ALL SELECT session_id,at,amount_usd FROM spend_charges WHERE recorded=0`,
      )
      .all() as { session_id: string; at: string; amount_usd: number }[];
    const scopes = [
      { label: 'global', caps: input.globalCaps, rows: [...globalPending, ...historic] },
      {
        label: 'profile',
        caps: input.profileCaps,
        rows: rows.filter((row) => row.profile_id === input.profileId),
      },
      ...(input.keyCaps
        ? [
            {
              label: 'key',
              caps: input.keyCaps,
              rows: rows.filter((row) => row.key_id === input.keyId),
            },
          ]
        : []),
    ];
    for (const scope of scopes) {
      for (const [period, cap] of Object.entries(scope.caps)) {
        if (cap === null) continue;
        const used = scope.rows
          .filter((row) =>
            period === 'dailyUsd'
              ? row.at.slice(0, 10) === at.slice(0, 10)
              : period === 'monthlyUsd'
                ? row.at.slice(0, 7) === at.slice(0, 7)
                : 'session_id' in row && row.session_id === input.sessionId,
          )
          .reduce((sum, row) => sum + row.amount_usd, 0);
        if (used + input.amountUsd > cap + 1e-12)
          throw new BudgetError(
            `The ${scope.label} ${period} budget is exhausted. Raise its limit or use a free route.`,
          );
      }
    }
    db.prepare(
      'INSERT INTO spend_reservations(id,key_id,profile_id,session_id,at,amount_usd) VALUES(?,?,?,?,?,?)',
    ).run(input.id, input.keyId ?? null, input.profileId, input.sessionId, at, input.amountUsd);
  }).immediate();
  let settled = false;
  return {
    id: input.id,
    estimatedUsd: input.amountUsd,
    settle(amountUsd = input.amountUsd, estimated = true, recorded = false) {
      if (settled) return;
      db.transaction(() => {
        db.prepare(
          'INSERT INTO spend_charges(id,key_id,profile_id,session_id,at,amount_usd,estimated,recorded) VALUES(?,?,?,?,?,?,?,?)',
        ).run(
          input.id,
          input.keyId ?? null,
          input.profileId,
          input.sessionId,
          at,
          amountUsd,
          Number(estimated),
          Number(recorded),
        );
        db.prepare('DELETE FROM spend_reservations WHERE id=?').run(input.id);
      }).immediate();
      settled = true;
    },
    cancelBeforeDispatch() {
      if (settled) return;
      db.prepare('DELETE FROM spend_reservations WHERE id=?').run(input.id);
      settled = true;
    },
  };
}
