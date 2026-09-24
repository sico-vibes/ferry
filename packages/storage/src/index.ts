import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type {
  Checkpoint,
  DelegationRun,
  Message,
  ModelInfo,
  Provider,
  QuotaWindow,
  Session,
  TaskRecord,
  Workspace,
} from '@ferry/shared';
import * as schema from './schema.js';

export { schema };
const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'migrations',
  '0001_initial.sql',
);
export interface DatabaseConnection {
  client: Database.Database;
  orm: BetterSQLite3Database<typeof schema>;
  close(): void;
}

export async function openDatabase(path: string): Promise<DatabaseConnection> {
  if (path !== ':memory:') await mkdir(dirname(path), { recursive: true });
  const client = new Database(path);
  client.pragma('journal_mode = WAL');
  client.pragma('busy_timeout = 5000');
  client.pragma('foreign_keys = ON');
  const current = Number(client.pragma('user_version', { simple: true }));
  if (current < 1) {
    const sql = await readFile(migrationPath, 'utf8');
    const migrate = client.transaction(() => {
      client.exec(sql);
      client.pragma('user_version = 1');
    });
    migrate();
  }
  return { client, orm: drizzle(client, { schema }), close: () => client.close() };
}

interface AggregateRow {
  id: string;
  data_json: string;
}
type AggregateTable =
  | 'providers'
  | 'workspaces'
  | 'sessions'
  | 'messages'
  | 'tasks'
  | 'checkpoints'
  | 'delegations'
  | 'quota_windows'
  | 'quota_observations'
  | 'cooldowns'
  | 'task_steps'
  | 'decisions'
  | 'touched_files'
  | 'handoffs'
  | 'optimizer_events'
  | 'optimizer_blobs';
export class JsonRepository<T extends { id: string }> {
  constructor(
    private readonly client: Database.Database,
    private readonly table: AggregateTable,
  ) {}
  put(value: T): void {
    this.client
      .prepare(
        `INSERT INTO ${this.table} (id, data_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at`,
      )
      .run(value.id, JSON.stringify(value), new Date().toISOString());
  }
  get(id: string): T | undefined {
    const row = this.client
      .prepare(`SELECT id, data_json FROM ${this.table} WHERE id = ?`)
      .get(id) as AggregateRow | undefined;
    return row ? (JSON.parse(row.data_json) as T) : undefined;
  }
  list(): T[] {
    const rows = this.client
      .prepare(`SELECT id, data_json FROM ${this.table} ORDER BY id`)
      .all() as AggregateRow[];
    return rows.map((row) => JSON.parse(row.data_json) as T);
  }
  delete(id: string): boolean {
    return this.client.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id).changes > 0;
  }
}

export class ProviderRepository extends JsonRepository<Provider> {
  constructor(client: Database.Database) {
    super(client, 'providers');
  }
}
export class WorkspaceRepository extends JsonRepository<Workspace> {
  constructor(client: Database.Database) {
    super(client, 'workspaces');
  }
}
export class SessionRepository extends JsonRepository<Session> {
  constructor(client: Database.Database) {
    super(client, 'sessions');
  }
}
export class MessageRepository extends JsonRepository<Message> {
  constructor(client: Database.Database) {
    super(client, 'messages');
  }
}
export class TaskRepository {
  private readonly repository: JsonRepository<TaskRecord & { id: string }>;
  constructor(client: Database.Database) {
    this.repository = new JsonRepository(client, 'tasks');
  }
  put(value: TaskRecord): void {
    this.repository.put({ ...value, id: value.sessionId });
  }
  get(sessionId: string): TaskRecord | undefined {
    const value = this.repository.get(sessionId);
    if (!value) return undefined;
    const { id: _id, ...task } = value;
    return task;
  }
  list(): TaskRecord[] {
    return this.repository.list().map(({ id: _id, ...task }) => task);
  }
  delete(sessionId: string): boolean {
    return this.repository.delete(sessionId);
  }
}
export class CheckpointRepository extends JsonRepository<Checkpoint> {
  constructor(client: Database.Database) {
    super(client, 'checkpoints');
  }
}
export class DelegationRepository extends JsonRepository<DelegationRun> {
  constructor(client: Database.Database) {
    super(client, 'delegations');
  }
}
export class QuotaWindowRepository extends JsonRepository<QuotaWindow> {
  constructor(client: Database.Database) {
    super(client, 'quota_windows');
  }
}
export interface KeyReference {
  id: string;
  providerId: string;
  keyringRef: string;
  createdAt: string;
}
export class ProviderKeyRepository {
  constructor(private readonly client: Database.Database) {}
  put(value: KeyReference): void {
    this.client
      .prepare(
        'INSERT INTO provider_keys (id,provider_id,keyring_ref,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,keyring_ref=excluded.keyring_ref,created_at=excluded.created_at',
      )
      .run(value.id, value.providerId, value.keyringRef, value.createdAt);
  }
  get(id: string): KeyReference | undefined {
    return this.client
      .prepare(
        'SELECT id,provider_id AS providerId,keyring_ref AS keyringRef,created_at AS createdAt FROM provider_keys WHERE id=?',
      )
      .get(id) as KeyReference | undefined;
  }
  delete(id: string): boolean {
    return this.client.prepare('DELETE FROM provider_keys WHERE id=?').run(id).changes > 0;
  }
}
export class ModelCacheRepository {
  constructor(private readonly client: Database.Database) {}
  put(providerId: string, model: ModelInfo, fetchedAt = new Date().toISOString()): void {
    this.client
      .prepare(
        'INSERT INTO models_cache (id,provider_id,data_json,fetched_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,data_json=excluded.data_json,fetched_at=excluded.fetched_at',
      )
      .run(model.ref, providerId, JSON.stringify(model), fetchedAt);
  }
  list(providerId: string): ModelInfo[] {
    return (
      this.client
        .prepare('SELECT data_json FROM models_cache WHERE provider_id=? ORDER BY id')
        .all(providerId) as { data_json: string }[]
    ).map((row) => JSON.parse(row.data_json) as ModelInfo);
  }
}
export class QuotaObservationRepository extends JsonRepository<{
  id: string;
  observedAt: string;
  value: number;
}> {
  constructor(client: Database.Database) {
    super(client, 'quota_observations');
  }
}
export class CooldownRepository extends JsonRepository<{ id: string; until: string }> {
  constructor(client: Database.Database) {
    super(client, 'cooldowns');
  }
}
export class TaskStepRepository extends JsonRepository<{
  id: string;
  sessionId: string;
  status: string;
}> {
  constructor(client: Database.Database) {
    super(client, 'task_steps');
  }
}
export class DecisionRepository extends JsonRepository<{
  id: string;
  sessionId: string;
  text: string;
  why: string;
  at: string;
}> {
  constructor(client: Database.Database) {
    super(client, 'decisions');
  }
}
export class TouchedFileRepository extends JsonRepository<{
  id: string;
  sessionId: string;
  path: string;
  purpose: string;
}> {
  constructor(client: Database.Database) {
    super(client, 'touched_files');
  }
}
export class HandoffRepository extends JsonRepository<{
  id: string;
  sessionId: string;
  reason: string;
}> {
  constructor(client: Database.Database) {
    super(client, 'handoffs');
  }
}
export class OptimizerEventRepository extends JsonRepository<{
  id: string;
  sessionId: string;
  kind: string;
}> {
  constructor(client: Database.Database) {
    super(client, 'optimizer_events');
  }
}
export class OptimizerBlobRepository extends JsonRepository<{
  id: string;
  sessionId: string;
  content: string;
}> {
  constructor(client: Database.Database) {
    super(client, 'optimizer_blobs');
  }
}
export class SettingsRepository {
  constructor(private readonly client: Database.Database) {}
  put(key: string, value: unknown): void {
    this.client
      .prepare(
        'INSERT INTO settings_kv (key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at',
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }
  get(key: string): unknown {
    const row = this.client.prepare('SELECT value_json FROM settings_kv WHERE key=?').get(key) as
      { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as unknown) : undefined;
  }
  delete(key: string): boolean {
    return this.client.prepare('DELETE FROM settings_kv WHERE key=?').run(key).changes > 0;
  }
}
export interface DailyUsage {
  day: string;
  provider: string;
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}
export class UsageDailyRepository {
  constructor(private readonly client: Database.Database) {}
  list(): DailyUsage[] {
    return this.client
      .prepare(
        'SELECT day,provider,model,requests,input_tokens,output_tokens,cost_usd FROM usage_daily ORDER BY day,provider,model',
      )
      .all() as DailyUsage[];
  }
}

export interface RequestRecord {
  id: string;
  ts: string;
  provider: string;
  model: string;
  session_id?: string | null;
  task_id?: string | null;
  step_id?: string | null;
  step_kind?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cached_tokens?: number | null;
  reasoning_tokens?: number | null;
  cost_usd?: number | null;
  plan_units?: number | null;
  status: string;
  error_kind?: string | null;
  latency_ms?: number | null;
  headers?: unknown;
}
export function redactHeaders(headers: unknown): string | null {
  if (headers === undefined || headers === null) return null;
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    if (typeof value === 'object' && value !== null)
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) =>
          /authorization|api[-_]?key|token|secret|password/i.test(key)
            ? [key, '[REDACTED]']
            : [key, clean(item)],
        ),
      );
    if (typeof value === 'string')
      return value
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
        .replace(
          /\b(?:sk-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{8,}|nvapi-[A-Za-z0-9_-]{8,})\b/g,
          '[REDACTED]',
        );
    return value;
  };
  return JSON.stringify(clean(headers));
}

export class RequestRepository {
  constructor(private readonly client: Database.Database) {}
  put(record: RequestRecord): void {
    this.client
      .prepare(
        `INSERT OR REPLACE INTO requests (id,ts,provider,model,session_id,task_id,step_id,step_kind,input_tokens,output_tokens,cached_tokens,reasoning_tokens,cost_usd,plan_units,status,error_kind,latency_ms,headers_json) VALUES (@id,@ts,@provider,@model,@session_id,@task_id,@step_id,@step_kind,@input_tokens,@output_tokens,@cached_tokens,@reasoning_tokens,@cost_usd,@plan_units,@status,@error_kind,@latency_ms,@headers_json)`,
      )
      .run({
        ...record,
        session_id: record.session_id ?? null,
        task_id: record.task_id ?? null,
        step_id: record.step_id ?? null,
        step_kind: record.step_kind ?? null,
        input_tokens: record.input_tokens ?? null,
        output_tokens: record.output_tokens ?? null,
        cached_tokens: record.cached_tokens ?? null,
        reasoning_tokens: record.reasoning_tokens ?? null,
        cost_usd: record.cost_usd ?? null,
        plan_units: record.plan_units ?? null,
        error_kind: record.error_kind ?? null,
        latency_ms: record.latency_ms ?? null,
        headers_json: redactHeaders(record.headers),
      });
  }
}

export function runRetention(
  client: Database.Database,
  before = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
): number {
  const cutoff = before.toISOString();
  const retain = client.transaction(() => {
    client
      .prepare(
        `INSERT INTO usage_daily (day,provider,model,requests,input_tokens,output_tokens,cost_usd)
      SELECT substr(ts,1,10),provider,model,count(*),sum(coalesce(input_tokens,0)),sum(coalesce(output_tokens,0)),sum(coalesce(cost_usd,0)) FROM requests WHERE ts < ?
      GROUP BY substr(ts,1,10),provider,model ON CONFLICT(day,provider,model) DO UPDATE SET requests=requests+excluded.requests,input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,cost_usd=cost_usd+excluded.cost_usd`,
      )
      .run(cutoff);
    return client.prepare('DELETE FROM requests WHERE ts < ?').run(cutoff).changes;
  });
  return retain();
}
