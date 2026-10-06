import { OutboxRepository, type StorageMirror } from '@ferry/storage';
import { mapCloudRow } from './mapping.js';
import { redactCloudPayload } from './redaction.js';

/** Maps local aggregate writes to durable cloud outbox operations. */
export class CloudOutboxMirror implements StorageMirror {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly captureContent: boolean | (() => boolean) = true,
  ) {}
  onPut(table: string, value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const rawId = record.id ?? record.sessionId;
    const id = typeof rawId === 'string' ? rawId : '';
    if (!id) return;
    const mapping: Record<string, string> = {
      workspaces: 'workspaces',
      sessions: 'sessions',
      messages: 'messages',
      tasks: 'task_records',
      providers: 'sync_records',
      models_cache: 'sync_records',
      quota_windows: 'quota_windows',
      checkpoints: 'sync_records',
      delegations: 'sync_records',
      optimizer_events: 'sync_records',
      optimizer_blobs: 'sync_records',
      task_steps: 'sync_records',
      decisions: 'sync_records',
      touched_files: 'sync_records',
      handoffs: 'sync_records',
      quota_observations: 'sync_records',
      cooldowns: 'cooldowns',
      settings_kv: 'settings_kv',
      provider_key_entries: 'provider_keys',
    };
    const target = mapping[table];
    if (!target) return;
    const captureContent =
      typeof this.captureContent === 'function' ? this.captureContent() : this.captureContent;
    const row = redactCloudPayload(mapCloudRow(table, id, record, captureContent));
    const syncKind: Record<string, string> = {
      providers: 'provider',
      models_cache: 'model_cache',
      checkpoints: 'checkpoint',
      delegations: 'delegation',
      optimizer_events: 'optimizer_event',
      optimizer_blobs: 'optimizer_blob',
      task_steps: 'task_step',
      decisions: 'decision',
      touched_files: 'touched_file',
      handoffs: 'handoff',
      quota_observations: 'other',
    };
    const kind = syncKind[table];
    this.outbox.enqueue({
      opId: kind ? `${target}:${kind}:${id}` : `${target}:${id}`,
      target,
      op: 'upsert',
      payload: row,
    });
    if (
      table === 'settings_kv' &&
      record.key === 'global' &&
      record.value &&
      typeof record.value === 'object'
    ) {
      const settings = record.value as Record<string, unknown>;
      this.outbox.enqueue({
        opId: 'profiles:current',
        target: 'profiles',
        op: 'upsert',
        payload: redactCloudPayload({
          storage_mode: settings.storageMode ?? 'local',
          default_model: settings.defaultModel ?? null,
          settings,
        }),
      });
    }
  }
  onDelete(table: string, id: string): void {
    const targets: Record<string, string> = {
      sessions: 'sessions',
      messages: 'messages',
      workspaces: 'workspaces',
      tasks: 'task_records',
      quota_windows: 'quota_windows',
      cooldowns: 'cooldowns',
      settings_kv: 'settings_kv',
      providers: 'sync_records',
      models_cache: 'sync_records',
      checkpoints: 'sync_records',
      delegations: 'sync_records',
      optimizer_events: 'sync_records',
      optimizer_blobs: 'sync_records',
      task_steps: 'sync_records',
      decisions: 'sync_records',
      touched_files: 'sync_records',
      handoffs: 'sync_records',
      quota_observations: 'sync_records',
    };
    const target = targets[table];
    if (!target || table === 'provider_key_entries') return;
    const syncKind: Record<string, string> = {
      providers: 'provider',
      models_cache: 'model_cache',
      checkpoints: 'checkpoint',
      delegations: 'delegation',
      optimizer_events: 'optimizer_event',
      optimizer_blobs: 'optimizer_blob',
      task_steps: 'task_step',
      decisions: 'decision',
      touched_files: 'touched_file',
      handoffs: 'handoff',
      quota_observations: 'other',
    };
    const kind = syncKind[table];
    const keyField = table === 'settings_kv' ? 'key' : table === 'tasks' ? 'session_id' : 'id';
    this.outbox.enqueue({
      opId: kind ? `${target}:${kind}:${id}:delete` : `${target}:${id}:delete`,
      target,
      op: 'delete',
      payload: { [keyField]: id, ...(kind ? { kind } : {}) },
    });
  }
}
