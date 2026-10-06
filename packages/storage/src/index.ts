import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFerryRuntimePaths } from '@ferry/shared/electron-paths';
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
import { newId, redactForTelemetry, type TelemetrySink } from '@ferry/shared';

export { schema };
const storageMigrationFiles = [
  '0001_initial.sql',
  '0002_interrupted_sessions.sql',
  '0003_agent_events.sql',
  '0004_provider_key_entries.sql',
  '0005_cloud_outbox_and_telemetry.sql',
  '0006_outbox_claims.sql',
];
export const STORAGE_SCHEMA_VERSION = storageMigrationFiles.length;
/** Observes successful local writes so cloud mode can persist them for later sync. */
export interface StorageMirror {
  onPut(table: string, value: unknown): void;
  onDelete(table: string, id: string): void;
}
/** No-op observer used by local mode. */
function ignoreStorageWrite(): void {
  // Local mode intentionally skips cloud mirroring.
}
export const NOOP_STORAGE_MIRROR: StorageMirror = {
  onPut: ignoreStorageWrite,
  onDelete: ignoreStorageWrite,
};
export interface DatabaseConnection {
  client: Database.Database;
  orm: BetterSQLite3Database<typeof schema>;
  close(): void;
}

export async function openDatabase(path: string): Promise<DatabaseConnection> {
  if (path !== ':memory:') await mkdir(dirname(path), { recursive: true });
  const runtimePaths = resolveFerryRuntimePaths({
    entryFilePath: fileURLToPath(import.meta.url),
    execPath: process.execPath,
    env: process.env,
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    exists: existsSync,
  });
  const storageMigrations = storageMigrationFiles.map((filename) =>
    join(runtimePaths.migrationsDirectory, filename),
  );
  const client = new Database(path);
  try {
    client.pragma('journal_mode = WAL');
    client.pragma('busy_timeout = 5000');
    client.pragma('foreign_keys = ON');
    const current = Number(client.pragma('user_version', { simple: true }));
    for (const [index, migrationPath] of storageMigrations.entries()) {
      const targetVersion = index + 1;
      if (current >= targetVersion) continue;
      const sql = await readFile(migrationPath, 'utf8');
      const migrate = client.transaction(() => {
        if (targetVersion === 6) {
          const columns = new Set(
            (client.pragma('table_info(cloud_outbox)') as { name: string }[]).map(
              ({ name }) => name,
            ),
          );
          if (!columns.has('claimed_generation'))
            client.exec('ALTER TABLE cloud_outbox ADD COLUMN claimed_generation INTEGER');
          if (!columns.has('claimed_at'))
            client.exec('ALTER TABLE cloud_outbox ADD COLUMN claimed_at TEXT');
        } else client.exec(sql);
        client.pragma(`user_version = ${String(targetVersion)}`);
      });
      migrate();
    }
  } catch (error) {
    client.close();
    throw error;
  }
  return { client, orm: drizzle(client, { schema }), close: () => client.close() };
}

const salvageTables = [
  'providers',
  'workspaces',
  'sessions',
  'messages',
  'tasks',
  'checkpoints',
  'delegations',
  'quota_windows',
  'quota_observations',
  'cooldowns',
  'task_steps',
  'decisions',
  'touched_files',
  'handoffs',
  'optimizer_events',
  'optimizer_blobs',
  'provider_keys',
  'provider_key_entries',
  'provider_key_usage_daily',
  'models_cache',
  'settings_kv',
  'requests',
  'usage_daily',
] as const;
/** Makes a WAL-aware SQLite backup, then copies each readable table independently. */
export async function salvageReadableTables(
  target: Database.Database,
  damagedPath: string,
): Promise<string[]> {
  const recovered: string[] = [];
  const backupPath = `${damagedPath}.salvage-${String(process.pid)}-${String(Date.now())}`;
  let sourcePath = damagedPath;
  let source: Database.Database | undefined;
  try {
    try {
      source = new Database(damagedPath, { readonly: true, fileMustExist: true });
      await source.backup(backupPath);
      sourcePath = backupPath;
    } catch {
      // A damaged page can make backup fail; ATTACH can still read other tables.
    } finally {
      source?.close();
    }
    target.prepare('ATTACH DATABASE ? AS damaged').run(sourcePath);
    for (const table of salvageTables) {
      try {
        const result = target
          .prepare(
            'INSERT OR IGNORE INTO main."' + table + '" SELECT * FROM damaged."' + table + '"',
          )
          .run();
        if (result.changes > 0) recovered.push(table);
      } catch {
        // A malformed or older table does not prevent copying readable tables.
      }
    }
  } catch {
    return recovered;
  } finally {
    try {
      target.exec('DETACH DATABASE damaged');
    } catch {
      /* attach may have failed */
    }
    if (sourcePath === backupPath) await unlink(backupPath).catch(() => undefined);
  }
  return recovered;
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
    private readonly mirror: StorageMirror = NOOP_STORAGE_MIRROR,
  ) {}
  put(value: T): void {
    this.client
      .prepare(
        `INSERT INTO ${this.table} (id, data_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at`,
      )
      .run(value.id, JSON.stringify(value), new Date().toISOString());
    this.mirror.onPut(this.table, value);
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
    const removed =
      this.client.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id).changes > 0;
    if (removed) this.mirror.onDelete(this.table, id);
    return removed;
  }
}

/** Persistent retry queue for Supabase operations. */
export class OutboxRepository {
  constructor(private readonly client: Database.Database) {}
  enqueue(input: {
    opId: string;
    target: string;
    op: 'upsert' | 'insert' | 'delete' | 'rpc';
    payload: unknown;
    now?: string;
  }): void {
    const createdAt = input.now ?? new Date().toISOString();
    if (input.op === 'upsert') {
      this.client
        .prepare(
          "DELETE FROM cloud_outbox WHERE op_id=? AND target=? AND op='delete' AND status IN ('pending','failed_permanent') AND (claimed_generation IS NULL OR claimed_generation<>generation)",
        )
        .run(`${input.opId}:delete`, input.target);
    } else if (input.op === 'delete' && input.opId.endsWith(':delete')) {
      this.client
        .prepare(
          "DELETE FROM cloud_outbox WHERE op_id=? AND target=? AND op='upsert' AND status IN ('pending','failed_permanent') AND (claimed_generation IS NULL OR claimed_generation<>generation)",
        )
        .run(input.opId.slice(0, -7), input.target);
    }
    this.client
      .prepare(
        `INSERT INTO cloud_outbox(op_id,target,op,payload_json,created_at,next_attempt_at,status) VALUES(?,?,?,?,?,?, 'pending') ON CONFLICT(op_id) DO UPDATE SET payload_json=excluded.payload_json,created_at=excluded.created_at,next_attempt_at=excluded.next_attempt_at,attempts=0,last_error=NULL,status='pending',generation=cloud_outbox.generation+1,claimed_generation=NULL,claimed_at=NULL WHERE cloud_outbox.status IN ('pending','failed_permanent')`,
      )
      .run(input.opId, input.target, input.op, JSON.stringify(input.payload), createdAt, createdAt);
  }
  claimDue(limit: number, now = new Date().toISOString()): OutboxEntry[] {
    const staleBefore = new Date(Date.parse(now) - 30_000).toISOString();
    this.client
      .prepare('UPDATE cloud_outbox SET claimed_generation=NULL,claimed_at=NULL WHERE claimed_at<?')
      .run(staleBefore);
    const select = this.client.prepare(
      `SELECT id,op_id AS opId,target,op,payload_json AS payloadJson,created_at AS createdAt,attempts,next_attempt_at AS nextAttemptAt,last_error AS lastError,status,generation FROM cloud_outbox WHERE status='pending' AND next_attempt_at<=? AND (claimed_generation IS NULL OR claimed_generation<>generation) ORDER BY id LIMIT ?`,
    );
    const rows = select.all(now, limit) as OutboxEntry[];
    const claim = this.client.prepare(
      'UPDATE cloud_outbox SET claimed_generation=generation,claimed_at=? WHERE id=? AND generation=? AND (claimed_generation IS NULL OR claimed_generation<>generation)',
    );
    return rows.filter((row) => claim.run(now, row.id, row.generation).changes > 0);
  }
  hasPending(target: string, entityId: string): boolean {
    return Boolean(
      this.client
        .prepare(
          "SELECT 1 FROM cloud_outbox WHERE target=? AND op_id LIKE ? AND status='pending' LIMIT 1",
        )
        .get(target, `%:${entityId}`),
    );
  }
  markDone(id: number, generation: number, now = new Date().toISOString()): void {
    this.client.prepare(`DELETE FROM cloud_outbox WHERE id=? AND generation=?`).run(id, generation);
    this.client
      .prepare(
        "UPDATE cloud_outbox SET next_attempt_at=?,claimed_generation=NULL,claimed_at=NULL WHERE id=? AND generation<>? AND status='pending'",
      )
      .run(now, id, generation);
  }
  markRetry(
    id: number,
    generation: number,
    error: string,
    nextAt: string,
    now = new Date().toISOString(),
  ): void {
    this.client
      .prepare(
        `UPDATE cloud_outbox SET attempts=attempts+1,last_error=?,next_attempt_at=?,claimed_generation=NULL,claimed_at=NULL WHERE id=? AND generation=?`,
      )
      .run(redactStorageText(error), nextAt, id, generation);
    this.client
      .prepare(
        "UPDATE cloud_outbox SET next_attempt_at=?,claimed_generation=NULL,claimed_at=NULL WHERE id=? AND generation<>? AND status='pending'",
      )
      .run(now, id, generation);
  }
  markPermanent(
    id: number,
    generation: number,
    error: string,
    now = new Date().toISOString(),
  ): void {
    this.client
      .prepare(
        `UPDATE cloud_outbox SET attempts=attempts+1,last_error=?,status='failed_permanent',claimed_generation=NULL,claimed_at=NULL WHERE id=? AND generation=?`,
      )
      .run(redactStorageText(error), id, generation);
    this.client
      .prepare(
        "UPDATE cloud_outbox SET next_attempt_at=? WHERE id=? AND generation<>? AND status='pending'",
      )
      .run(now, id, generation);
  }
  counts(): { pending: number; failedPermanent: number } {
    const rows = this.client
      .prepare(`SELECT status,count(*) AS count FROM cloud_outbox GROUP BY status`)
      .all() as { status: string; count: number }[];
    return {
      pending: rows.find((row) => row.status === 'pending')?.count ?? 0,
      failedPermanent: rows.find((row) => row.status === 'failed_permanent')?.count ?? 0,
    };
  }
}
function redactStorageText(value: string): string {
  return redactForTelemetry(value) as string;
}
export interface OutboxEntry {
  id: number;
  opId: string;
  target: string;
  op: 'upsert' | 'insert' | 'delete' | 'rpc';
  payloadJson: string;
  createdAt: string;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  status: string;
  generation: number;
}

export interface TelemetryRecord extends Record<string, unknown> {
  id: string;
}
export interface TurnTelemetryRecord extends TelemetryRecord {
  session_id?: string | null;
  message_id?: string | null;
  user_message_id?: string | null;
  device_id?: string | null;
  trace_id?: string;
  request_group_id?: string | null;
  attempt?: number;
  parent_turn_id?: string | null;
  source?: string;
  task_id?: string | null;
  step_id?: string | null;
  step_kind?: string | null;
  agent_role?: string | null;
  agent_profile_id?: string | null;
  requested_model?: string | null;
  routing_mode?: string | null;
  routed_provider?: string | null;
  routed_model?: string | null;
  routed_upstream_model?: string | null;
  response_model?: string | null;
  provider_key_id?: string | null;
  fallback_reason?: string | null;
  routing_decision?: unknown;
  routed_differs_from_requested?: boolean;
  response_differs_from_routed?: boolean;
  status?: string;
  http_status?: number | null;
  error_kind?: string | null;
  error_message?: string | null;
  finish_reason?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cached_tokens?: number | null;
  reasoning_tokens?: number | null;
  cost_usd?: number | null;
  plan_units?: number | null;
  latency_ms?: number | null;
  ttft_ms?: number | null;
  request_bytes?: number | null;
  rate_limit_headers?: unknown;
  started_at?: string;
  finished_at?: string | null;
  created_at?: string;
  updated_at?: string;
}
export interface EventTelemetryRecord extends TelemetryRecord {
  ts?: string;
  device_id?: string | null;
  level?: string;
  source?: string;
  event?: string;
  message?: string | null;
  session_id?: string | null;
  turn_id?: string | null;
  trace_id?: string | null;
  span_id?: string | null;
  parent_span_id?: string | null;
  app_version?: string | null;
  data?: unknown;
}
export interface ModelSwitchTelemetryRecord extends TelemetryRecord {
  session_id?: string;
  turn_id?: string | null;
  kind?: string;
  from_model?: string | null;
  to_model?: string | null;
  from_provider?: string | null;
  to_provider?: string | null;
  reason?: string | null;
  data?: unknown;
  created_at?: string;
}
const telemetryColumns: Record<
  'telemetry_turns' | 'telemetry_logs' | 'telemetry_model_switches',
  string[]
> = {
  telemetry_turns: [
    'session_id',
    'message_id',
    'user_message_id',
    'device_id',
    'trace_id',
    'request_group_id',
    'attempt',
    'parent_turn_id',
    'source',
    'task_id',
    'step_id',
    'step_kind',
    'agent_role',
    'agent_profile_id',
    'requested_model',
    'routing_mode',
    'routed_provider',
    'routed_model',
    'routed_upstream_model',
    'response_model',
    'provider_key_id',
    'fallback_reason',
    'routing_decision_json',
    'routed_differs_from_requested',
    'response_differs_from_routed',
    'status',
    'http_status',
    'error_kind',
    'error_message',
    'finish_reason',
    'input_tokens',
    'output_tokens',
    'cached_tokens',
    'reasoning_tokens',
    'cost_usd',
    'plan_units',
    'latency_ms',
    'ttft_ms',
    'request_bytes',
    'rate_limit_headers_json',
    'started_at',
    'finished_at',
    'created_at',
    'updated_at',
  ],
  telemetry_logs: [
    'ts',
    'device_id',
    'level',
    'source',
    'event',
    'message',
    'session_id',
    'turn_id',
    'trace_id',
    'span_id',
    'parent_span_id',
    'app_version',
    'data',
  ],
  telemetry_model_switches: [
    'session_id',
    'turn_id',
    'kind',
    'from_model',
    'to_model',
    'from_provider',
    'to_provider',
    'reason',
    'data',
    'created_at',
  ],
};
class TelemetryRepository<T extends TelemetryRecord> {
  constructor(
    private readonly client: Database.Database,
    private readonly table: 'telemetry_turns' | 'telemetry_logs' | 'telemetry_model_switches',
  ) {}
  put(value: T): void {
    const safeValue = redactForTelemetry(value) as T;
    const columns = telemetryColumns[this.table];
    const jsonColumns = new Set(['routing_decision_json', 'rate_limit_headers_json', 'data']);
    const values = columns.map((column) => {
      const key = column.endsWith('_json') ? column.slice(0, -5) : column;
      const raw = safeValue[column] ?? safeValue[key];
      if (raw === undefined) return null;
      if (jsonColumns.has(column)) return JSON.stringify(raw);
      return typeof raw === 'boolean' ? Number(raw) : raw;
    });
    const dataJson = JSON.stringify(safeValue);
    const insertColumns = ['id', ...columns, 'data_json'];
    const placeholders = insertColumns.map(() => '?').join(',');
    const updates = columns
      .map((column) => `${column}=excluded.${column}`)
      .concat('data_json=excluded.data_json');
    const conflict =
      this.table === 'telemetry_turns'
        ? `ON CONFLICT(id) DO UPDATE SET ${updates.join(',')}`
        : 'ON CONFLICT(id) DO NOTHING';
    this.client
      .prepare(
        `INSERT INTO ${this.table}(${insertColumns.join(',')}) VALUES(${placeholders}) ${conflict}`,
      )
      .run(safeValue.id, ...values, dataJson);
  }
  get(id: string): T | undefined {
    const row = this.client.prepare(`SELECT data_json FROM ${this.table} WHERE id=?`).get(id) as
      { data_json: string } | undefined;
    return row ? (JSON.parse(row.data_json) as T) : undefined;
  }
  list(): T[] {
    const rows = this.client
      .prepare(
        `SELECT data_json FROM ${this.table} ORDER BY ${this.table === 'telemetry_logs' ? 'ts' : 'created_at'},id`,
      )
      .all() as { data_json: string }[];
    return rows.map((row) => JSON.parse(row.data_json) as T);
  }
}
/** Stores local provider-attempt telemetry. */
export class TurnLogRepository extends TelemetryRepository<TurnTelemetryRecord> {
  constructor(client: Database.Database) {
    super(client, 'telemetry_turns');
  }
}
/** Stores local structured event telemetry. */
export class EventLogRepository extends TelemetryRepository<EventTelemetryRecord> {
  constructor(client: Database.Database) {
    super(client, 'telemetry_logs');
  }
}
/** Stores local model-selection and routing switch telemetry. */
export class ModelSwitchRepository extends TelemetryRepository<ModelSwitchTelemetryRecord> {
  constructor(client: Database.Database) {
    super(client, 'telemetry_model_switches');
  }
}

function capturePolicy(
  value: Record<string, unknown>,
  captureContent: boolean,
): Record<string, unknown> {
  if (captureContent) return value;
  const contentKey =
    /^(?:prompt|response|reasoning|input|output|args|arguments|brief|tool(?:Input|Output|_input|_output)|content|text)$/i;
  const walk = (item: unknown, key = ''): unknown => {
    if (
      contentKey.test(key) &&
      item &&
      typeof item === 'object' &&
      'omitted' in item &&
      item.omitted === 'capture-off'
    )
      return item;
    if (contentKey.test(key))
      return {
        omitted: 'capture-off',
        chars: typeof item === 'string' ? item.length : JSON.stringify(item ?? '').length,
      };
    if (Array.isArray(item)) return item.map((child) => walk(child));
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([childKey, child]) => [childKey, walk(child, childKey)]),
      );
    return item;
  };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, key)]));
}

/** Writes structured telemetry locally, and optionally mirrors it through the durable cloud outbox. */
export class LocalTelemetrySink implements TelemetrySink {
  constructor(
    protected readonly turns: TurnLogRepository,
    protected readonly logs: EventLogRepository,
    protected readonly switches: ModelSwitchRepository,
    private readonly captureContent: boolean | (() => boolean) = false,
  ) {}
  protected sanitize(event: Record<string, unknown>): Record<string, unknown> {
    const capture =
      typeof this.captureContent === 'function' ? this.captureContent() : this.captureContent;
    return redactForTelemetry(capturePolicy(event, capture)) as Record<string, unknown>;
  }
  log(event: Record<string, unknown>): void {
    const id = typeof event.id === 'string' ? event.id : newId('evt');
    this.logs.put({
      id,
      ts: new Date().toISOString(),
      ...this.sanitize(event),
    });
  }
  turnStarted(turn: Record<string, unknown>): void {
    const id = typeof turn.id === 'string' ? turn.id : newId('turn');
    this.turns.put({
      id,
      status: 'pending',
      started_at: new Date().toISOString(),
      ...this.sanitize(turn),
    });
  }
  turnUpdated(turnId: string, patch: Record<string, unknown>): void {
    this.turns.put({
      ...(this.turns.get(turnId) ?? { id: turnId }),
      ...this.sanitize(patch),
      id: turnId,
    });
  }
  modelSwitch(record: Record<string, unknown>): void {
    const id = typeof record.id === 'string' ? record.id : globalThis.crypto.randomUUID();
    this.switches.put({
      id,
      created_at: new Date().toISOString(),
      ...this.sanitize(record),
    });
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
}

/** Local sink with idempotent outbox mirroring for ferry.turns, ferry.logs and model_switches. */
export class CloudTelemetrySink extends LocalTelemetrySink {
  constructor(
    turns: TurnLogRepository,
    logs: EventLogRepository,
    switches: ModelSwitchRepository,
    private readonly outbox: OutboxRepository,
    captureContent: boolean | (() => boolean) = true,
  ) {
    super(turns, logs, switches, captureContent);
  }
  override log(event: Record<string, unknown>): void {
    const id = typeof event.id === 'string' ? event.id : newId('evt');
    const normalized = this.sanitize({
      ...event,
      id,
      data: {
        ...(typeof event.data === 'object' && event.data !== null ? event.data : {}),
        event_id: id,
      },
    });
    super.log(normalized);
    const payload = Object.fromEntries(Object.entries(normalized).filter(([key]) => key !== 'id'));
    this.outbox.enqueue({
      opId: `logs:${id}`,
      target: 'logs',
      op: 'insert',
      payload: redactForTelemetry(payload),
    });
  }
  override turnStarted(turn: Record<string, unknown>): void {
    super.turnStarted(turn);
    const id = typeof turn.id === 'string' ? turn.id : '';
    if (id)
      this.outbox.enqueue({
        opId: `turns:${id}`,
        target: 'turns',
        op: 'upsert',
        payload: redactForTelemetry(turn),
      });
  }
  override turnUpdated(turnId: string, patch: Record<string, unknown>): void {
    super.turnUpdated(turnId, patch);
    const turn = { ...(this.turns.get(turnId) ?? { id: turnId }), ...patch, id: turnId };
    this.outbox.enqueue({
      opId: `turns:${turnId}`,
      target: 'turns',
      op: 'upsert',
      payload: redactForTelemetry(turn),
    });
  }
  override modelSwitch(record: Record<string, unknown>): void {
    if (
      record.kind === 'selection_change' ||
      record.kind === 'pin' ||
      record.kind === 'unpin' ||
      record.kind === 'initial' ||
      record.kind === 'router_fallback'
    )
      return;
    const id = typeof record.id === 'string' ? record.id : globalThis.crypto.randomUUID();
    const normalized = {
      ...record,
      id,
      data: {
        ...(typeof record.data === 'object' && record.data !== null ? record.data : {}),
        event_id: id,
      },
    };
    super.modelSwitch(normalized);
    const payload = redactForTelemetry(normalized) as Record<string, unknown>;
    this.outbox.enqueue({
      opId: `model_switches:${id}`,
      target: 'model_switches',
      op: 'insert',
      payload,
    });
  }
}

export const NoopStorageTelemetrySink: TelemetrySink = {
  log: () => undefined,
  turnStarted: () => undefined,
  turnUpdated: () => undefined,
  modelSwitch: () => undefined,
  flush: () => Promise.resolve(),
};

export class ProviderRepository extends JsonRepository<Provider> {
  constructor(client: Database.Database, mirror?: StorageMirror) {
    super(client, 'providers', mirror);
  }
}
export class WorkspaceRepository extends JsonRepository<Workspace> {
  constructor(client: Database.Database, mirror?: StorageMirror) {
    super(client, 'workspaces', mirror);
  }
}
export class SessionRepository extends JsonRepository<Session> {
  constructor(client: Database.Database, mirror?: StorageMirror) {
    super(client, 'sessions', mirror);
  }
}
export class MessageRepository extends JsonRepository<Message> {
  constructor(client: Database.Database, mirror?: StorageMirror) {
    super(client, 'messages', mirror);
  }
}
export class TaskRepository {
  private readonly repository: JsonRepository<TaskRecord & { id: string }>;
  constructor(client: Database.Database, mirror?: StorageMirror) {
    this.repository = new JsonRepository(client, 'tasks', mirror);
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
  constructor(client: Database.Database, mirror?: StorageMirror) {
    super(client, 'checkpoints', mirror);
  }
}
export class DelegationRepository extends JsonRepository<DelegationRun> {
  constructor(client: Database.Database, mirror?: StorageMirror) {
    super(client, 'delegations', mirror);
  }
}
export class QuotaWindowRepository extends JsonRepository<QuotaWindow> {
  constructor(client: Database.Database, mirror?: StorageMirror) {
    super(client, 'quota_windows', mirror);
  }
}
export interface KeyReference {
  id: string;
  providerId: string;
  keyringRef: string;
  createdAt: string;
}
export interface ProviderKeyEntry {
  id: string;
  providerId: string;
  keyId: string;
  label: string;
  position: number;
  enabled: boolean;
  status: 'ok' | 'rate_limited' | 'invalid' | 'disabled';
  lastError: string | null;
  cooldownUntil: string | null;
  keyringRef: string;
  createdAt: string;
  updatedAt: string;
}
export class ProviderKeyEntryRepository {
  constructor(
    private readonly client: Database.Database,
    private readonly mirror: StorageMirror = NOOP_STORAGE_MIRROR,
  ) {}
  list(providerId: string): ProviderKeyEntry[] {
    const rows = this.client
      .prepare(
        `SELECT id,provider_id AS providerId,key_id AS keyId,label,position,enabled,status,last_error AS lastError,cooldown_until AS cooldownUntil,keyring_ref AS keyringRef,created_at AS createdAt,updated_at AS updatedAt FROM provider_key_entries WHERE provider_id=? ORDER BY position,key_id`,
      )
      .all(providerId) as (Omit<ProviderKeyEntry, 'enabled'> & { enabled: number })[];
    return rows.map((entry) => ({ ...entry, enabled: Boolean(entry.enabled) }));
  }
  put(entry: ProviderKeyEntry): void {
    this.client
      .prepare(
        `INSERT INTO provider_key_entries (id,provider_id,key_id,label,position,enabled,status,last_error,cooldown_until,keyring_ref,created_at,updated_at) VALUES (@id,@providerId,@keyId,@label,@position,@enabled,@status,@lastError,@cooldownUntil,@keyringRef,@createdAt,@updatedAt) ON CONFLICT(provider_id,key_id) DO UPDATE SET label=excluded.label,position=excluded.position,enabled=excluded.enabled,status=excluded.status,last_error=excluded.last_error,cooldown_until=excluded.cooldown_until,keyring_ref=excluded.keyring_ref,updated_at=excluded.updated_at`,
      )
      .run({ ...entry, enabled: entry.enabled ? 1 : 0 });
    const { keyringRef: _keyringRef, ...metadata } = entry;
    this.mirror.onPut('provider_key_entries', metadata);
  }
  delete(providerId: string, keyId: string): boolean {
    const removed =
      this.client
        .prepare('DELETE FROM provider_key_entries WHERE provider_id=? AND key_id=?')
        .run(providerId, keyId).changes > 0;
    if (removed) this.mirror.onDelete('provider_key_entries', `${providerId}:${keyId}`);
    return removed;
  }
}
export interface ProviderKeyUsage {
  requests: number;
  tokens: number;
}
export class ProviderKeyUsageDailyRepository {
  constructor(private readonly client: Database.Database) {}
  record(
    providerId: string,
    keyId: string,
    occurredAt: Date,
    inputTokens: number,
    outputTokens: number,
  ): void {
    const day = occurredAt.toISOString().slice(0, 10);
    this.client
      .prepare(
        `INSERT INTO provider_key_usage_daily (day,provider_id,key_id,requests,tokens) VALUES (?,?,?,1,?) ON CONFLICT(day,provider_id,key_id) DO UPDATE SET requests=requests+1,tokens=tokens+excluded.tokens`,
      )
      .run(
        day,
        providerId,
        keyId,
        Math.max(0, Math.round(inputTokens)) + Math.max(0, Math.round(outputTokens)),
      );
  }
  today(providerId: string, keyId: string, at = new Date()): ProviderKeyUsage {
    const row = this.client
      .prepare(
        'SELECT requests,tokens FROM provider_key_usage_daily WHERE day=? AND provider_id=? AND key_id=?',
      )
      .get(at.toISOString().slice(0, 10), providerId, keyId) as ProviderKeyUsage | undefined;
    return row ?? { requests: 0, tokens: 0 };
  }
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
  constructor(
    private readonly client: Database.Database,
    private readonly mirror: StorageMirror = NOOP_STORAGE_MIRROR,
  ) {}
  replace(providerId: string, models: ModelInfo[], fetchedAt = new Date().toISOString()): void {
    this.client.transaction(() => {
      const previous = this.client
        .prepare('SELECT id FROM models_cache WHERE provider_id=?')
        .all(providerId) as { id: string }[];
      this.client.prepare('DELETE FROM models_cache WHERE provider_id=?').run(providerId);
      for (const row of previous) this.mirror.onDelete('models_cache', row.id);
      for (const model of models) this.put(providerId, model, fetchedAt);
    })();
  }
  put(providerId: string, model: ModelInfo, fetchedAt = new Date().toISOString()): void {
    this.client
      .prepare(
        'INSERT INTO models_cache (id,provider_id,data_json,fetched_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,data_json=excluded.data_json,fetched_at=excluded.fetched_at',
      )
      .run(model.ref, providerId, JSON.stringify(model), fetchedAt);
    this.mirror.onPut('models_cache', { id: model.ref, providerId, model, updatedAt: fetchedAt });
  }
  list(providerId: string): ModelInfo[] {
    return (
      this.client
        .prepare('SELECT data_json FROM models_cache WHERE provider_id=? ORDER BY id')
        .all(providerId) as { data_json: string }[]
    ).map((row) => JSON.parse(row.data_json) as ModelInfo);
  }
}
export class QuotaObservationRepository extends JsonRepository<
  import('@ferry/shared').QuotaObservation
> {
  constructor(client: Database.Database, mirror?: StorageMirror) {
    super(client, 'quota_observations', mirror);
  }
}
export class CooldownRepository extends JsonRepository<{
  id: string;
  until: string;
  provenance?: 'heuristic' | 'authoritative' | 'credit' | 'tier';
}> {
  constructor(client: Database.Database, mirror?: StorageMirror) {
    super(client, 'cooldowns', mirror);
  }
}
export class TaskStepRepository extends JsonRepository<{
  id: string;
  sessionId: string;
  status: string;
}> {
  constructor(client: Database.Database, mirror?: StorageMirror) {
    super(client, 'task_steps', mirror);
  }
}
export class DecisionRepository extends JsonRepository<{
  id: string;
  sessionId: string;
  text: string;
  why: string;
  at: string;
}> {
  constructor(client: Database.Database, mirror?: StorageMirror) {
    super(client, 'decisions', mirror);
  }
}
export class TouchedFileRepository extends JsonRepository<{
  id: string;
  sessionId: string;
  path: string;
  purpose: string;
}> {
  constructor(client: Database.Database, mirror?: StorageMirror) {
    super(client, 'touched_files', mirror);
  }
}
export class HandoffRepository extends JsonRepository<{
  id: string;
  sessionId: string;
  reason: string;
}> {
  constructor(
    client: Database.Database,
    private readonly handoffClient: Database.Database = client,
    mirror?: StorageMirror,
  ) {
    super(client, 'handoffs', mirror);
  }
  listSince(since: Date): { id: string; sessionId: string; reason: string }[] {
    return (
      this.handoffClient
        .prepare('SELECT data_json FROM handoffs WHERE updated_at >= ? ORDER BY updated_at')
        .all(since.toISOString()) as { data_json: string }[]
    ).map((row) => JSON.parse(row.data_json) as { id: string; sessionId: string; reason: string });
  }
}
export class OptimizerEventRepository extends JsonRepository<{
  id: string;
  sessionId: string;
  kind: string;
}> {
  constructor(client: Database.Database, mirror?: StorageMirror) {
    super(client, 'optimizer_events', mirror);
  }
}
export class OptimizerBlobRepository extends JsonRepository<{
  id: string;
  sessionId: string;
  content: string;
}> {
  constructor(client: Database.Database, mirror?: StorageMirror) {
    super(client, 'optimizer_blobs', mirror);
  }
}
export class SettingsRepository {
  constructor(
    private readonly client: Database.Database,
    private readonly mirror: StorageMirror = NOOP_STORAGE_MIRROR,
  ) {}
  put(key: string, value: unknown): void {
    this.client
      .prepare(
        'INSERT INTO settings_kv (key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at',
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
    this.mirror.onPut('settings_kv', { id: key, key, value });
  }
  get(key: string): unknown {
    const row = this.client.prepare('SELECT value_json FROM settings_kv WHERE key=?').get(key) as
      { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as unknown) : undefined;
  }
  delete(key: string): boolean {
    const removed = this.client.prepare('DELETE FROM settings_kv WHERE key=?').run(key).changes > 0;
    if (removed) this.mirror.onDelete('settings_kv', key);
    return removed;
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

/** Builds the synchronous repository set for either local or mirrored storage. */
export function createStorageAdapter(options: {
  client: Database.Database;
  mode: 'local' | 'cloud';
  mirror?: StorageMirror;
}) {
  const mirror =
    options.mode === 'cloud' ? (options.mirror ?? NOOP_STORAGE_MIRROR) : NOOP_STORAGE_MIRROR;
  return {
    providers: new ProviderRepository(options.client, mirror),
    workspaces: new WorkspaceRepository(options.client, mirror),
    sessions: new SessionRepository(options.client, mirror),
    messages: new MessageRepository(options.client, mirror),
    tasks: new TaskRepository(options.client, mirror),
    checkpoints: new CheckpointRepository(options.client, mirror),
    delegations: new DelegationRepository(options.client, mirror),
    quotaWindows: new QuotaWindowRepository(options.client, mirror),
    quotaObservations: new QuotaObservationRepository(options.client, mirror),
    cooldowns: new CooldownRepository(options.client, mirror),
    taskSteps: new TaskStepRepository(options.client, mirror),
    decisions: new DecisionRepository(options.client, mirror),
    touchedFiles: new TouchedFileRepository(options.client, mirror),
    handoffs: new HandoffRepository(options.client, options.client, mirror),
    optimizerEvents: new OptimizerEventRepository(options.client, mirror),
    optimizerBlobs: new OptimizerBlobRepository(options.client, mirror),
    models: new ModelCacheRepository(options.client, mirror),
    settings: new SettingsRepository(options.client, mirror),
    providerKeys: new ProviderKeyRepository(options.client),
    providerKeyEntries: new ProviderKeyEntryRepository(options.client, mirror),
    providerKeyUsage: new ProviderKeyUsageDailyRepository(options.client),
    requests: new RequestRepository(options.client, mirror),
    outbox: new OutboxRepository(options.client),
    turnLogs: new TurnLogRepository(options.client),
    eventLogs: new EventLogRepository(options.client),
    modelSwitches: new ModelSwitchRepository(options.client),
  };
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
  return JSON.stringify(redactForTelemetry(headers));
}

export class RequestRepository {
  constructor(
    private readonly client: Database.Database,
    private readonly mirror: StorageMirror = NOOP_STORAGE_MIRROR,
  ) {}
  list(): RequestRecord[] {
    return this.client.prepare('SELECT * FROM requests ORDER BY ts').all() as RequestRecord[];
  }
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
    this.mirror.onPut('requests', record);
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

/** Removes local structured events older than the cloud log retention window. */
export function runTelemetryRetention(
  client: Database.Database,
  before = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
): number {
  return client.prepare('DELETE FROM telemetry_logs WHERE ts < ?').run(before.toISOString())
    .changes;
}
