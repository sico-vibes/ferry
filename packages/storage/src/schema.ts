import { integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const aggregate = (name: string) =>
  sqliteTable(name, {
    id: text('id').primaryKey(),
    dataJson: text('data_json').notNull(),
    updatedAt: text('updated_at').notNull(),
  });
export const providers = aggregate('providers');
export const providerKeys = sqliteTable('provider_keys', {
  id: text('id').primaryKey(),
  providerId: text('provider_id').notNull(),
  keyringRef: text('keyring_ref').notNull(),
  createdAt: text('created_at').notNull(),
});
export const modelsCache = sqliteTable('models_cache', {
  id: text('id').primaryKey(),
  providerId: text('provider_id').notNull(),
  dataJson: text('data_json').notNull(),
  fetchedAt: text('fetched_at').notNull(),
});
export const requests = sqliteTable('requests', {
  id: text('id').primaryKey(),
  ts: text('ts').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  sessionId: text('session_id'),
  taskId: text('task_id'),
  stepId: text('step_id'),
  stepKind: text('step_kind'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cachedTokens: integer('cached_tokens'),
  reasoningTokens: integer('reasoning_tokens'),
  costUsd: real('cost_usd'),
  planUnits: real('plan_units'),
  status: text('status').notNull(),
  errorKind: text('error_kind'),
  latencyMs: integer('latency_ms'),
  headersJson: text('headers_json'),
});
export const quotaWindows = aggregate('quota_windows');
export const quotaObservations = aggregate('quota_observations');
export const cooldowns = aggregate('cooldowns');
export const workspaces = aggregate('workspaces');
export const sessions = aggregate('sessions');
export const messages = aggregate('messages');
export const tasks = aggregate('tasks');
export const taskSteps = aggregate('task_steps');
export const decisions = aggregate('decisions');
export const touchedFiles = aggregate('touched_files');
export const checkpoints = aggregate('checkpoints');
export const handoffs = aggregate('handoffs');
export const optimizerEvents = aggregate('optimizer_events');
export const optimizerBlobs = aggregate('optimizer_blobs');
export const delegations = aggregate('delegations');
export const settingsKv = sqliteTable('settings_kv', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export const usageDaily = sqliteTable(
  'usage_daily',
  {
    day: text('day').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    requests: integer('requests').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    costUsd: real('cost_usd').notNull(),
  },
  (table) => [uniqueIndex('usage_daily_key_idx').on(table.day, table.provider, table.model)],
);
