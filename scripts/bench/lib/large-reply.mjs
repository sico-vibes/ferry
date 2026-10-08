import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { root } from './options.mjs';

export function transportModel(providerId) {
  return {
    ref: `${providerId}/ferry-transport-only`,
    providerId,
    name: `Ferry transport-only fixture ${'x'.repeat(1_100_000)}`,
    tier: 'T1',
    contextWindow: 32,
    maxOutput: 1,
    toolCalling: false,
    reasoning: false,
    free: false,
    priceInPerM: null,
    priceOutPerM: null,
  };
}

// Only the freshly-created isolated engine database is passed here. Temporary
// model metadata makes the historical 1 MB pipe regression deterministic even
// when the keyed providers return small catalogs. It is never routed to a model.
export async function withLargeReply(dataDir, providerId, action) {
  const requireCli = createRequire(join(root, 'apps/cli/package.json'));
  const Database = requireCli('better-sqlite3');
  const database = new Database(join(dataDir, 'db/ferry.sqlite'), { fileMustExist: true });
  let original;
  try {
    original = database
      .prepare('SELECT data_json FROM providers WHERE id=?')
      .get(providerId)?.data_json;
    assert(original, 'Transport fixture requires an existing isolated provider record');
    const padded = { ...JSON.parse(original), availableModels: [transportModel(providerId)] };
    database
      .prepare('UPDATE providers SET data_json=? WHERE id=?')
      .run(JSON.stringify(padded), providerId);
    return await action();
  } finally {
    try {
      if (original)
        database.prepare('UPDATE providers SET data_json=? WHERE id=?').run(original, providerId);
    } finally {
      database.close();
    }
  }
}
