import { MessageSchema, SessionSchema, TaskRecordSchema, WorkspaceSchema } from '@ferry/shared';
import type { OutboxRepository } from '@ferry/storage';
import type { createStorageAdapter } from '@ferry/storage';

export type HydrationAdapter = ReturnType<typeof createStorageAdapter>;
export interface HydrationCounts {
  inserted: number;
  updatedSessions: number;
  skippedExisting: number;
  skippedCaptureOff: number;
  skippedInvalid: number;
}

/** Applies pulled rows to a no-mirror adapter without overwriting local messages. */
export function applyHydratedRows(
  table: string,
  rows: Record<string, unknown>[],
  adapter: HydrationAdapter,
  outbox: OutboxRepository,
  counts: HydrationCounts = createHydrationCounts(),
): HydrationCounts {
  for (const row of rows) {
    if (table === 'settings_kv') {
      const key = stringValue(row.key);
      if (!key) {
        counts.skippedInvalid += 1;
        continue;
      }
      if (adapter.settings.get(key) !== undefined) {
        counts.skippedExisting += 1;
        continue;
      }
      adapter.settings.put(key, row.value);
      counts.inserted += 1;
      continue;
    }
    if (table === 'workspaces') {
      const parsed = WorkspaceSchema.safeParse({
        id: row.id,
        name: row.name,
        path: row.path,
        gitBranch: row.git_branch ?? null,
        language: row.language ?? 'other',
        lastOpenedAt: row.last_opened_at ?? row.updated_at ?? new Date(0).toISOString(),
        settings: row.settings ?? {
          gateCommands: [],
          instructionsFile: null,
          defaultProfileId: null,
          permissionMode: 'ask',
        },
      });
      if (!parsed.success) {
        counts.skippedInvalid += 1;
        continue;
      }
      if (adapter.workspaces.get(parsed.data.id)) {
        counts.skippedExisting += 1;
        continue;
      }
      adapter.workspaces.put(parsed.data);
      counts.inserted += 1;
      continue;
    }
    if (table === 'sessions') {
      const metadata = object(row.metadata);
      const fullData = object(metadata.data);
      if (!Object.keys(fullData).length) {
        counts.skippedCaptureOff += 1;
        continue;
      }
      const parsed = SessionSchema.safeParse(fullData);
      if (!parsed.success) {
        counts.skippedInvalid += 1;
        continue;
      }
      const local = adapter.sessions.get(parsed.data.id);
      if (!local) {
        adapter.sessions.put(parsed.data);
        counts.inserted += 1;
      } else if (
        !outbox.hasPending('sessions', parsed.data.id) &&
        Date.parse(parsed.data.updatedAt) > Date.parse(local.updatedAt)
      ) {
        adapter.sessions.put(parsed.data);
        counts.updatedSessions += 1;
      } else counts.skippedExisting += 1;
      continue;
    }
    if (table === 'messages') {
      const id = stringValue(row.id);
      if (!id) {
        counts.skippedInvalid += 1;
        continue;
      }
      if (adapter.messages.get(id)) {
        counts.skippedExisting += 1;
        continue;
      }
      const parts = Array.isArray(row.parts) ? row.parts : [];
      if (containsCaptureOff(parts)) {
        counts.skippedCaptureOff += 1;
        continue;
      }
      const metadata = object(row.metadata);
      const fullData = object(metadata.data);
      const fallback = {
        id,
        sessionId: row.session_id,
        role: row.role,
        createdAt: row.created_at,
        modelRef: row.model_ref,
        agentRole: row.agent_role ?? undefined,
        parts,
        modelAttempts: row.model_attempts ?? undefined,
        turnId: typeof row.turn_id === 'string' ? row.turn_id : undefined,
      };
      const parsed = MessageSchema.safeParse(Object.keys(fullData).length ? fullData : fallback);
      if (!parsed.success) {
        counts.skippedInvalid += 1;
        continue;
      }
      adapter.messages.put(parsed.data);
      counts.inserted += 1;
      continue;
    }
    if (table === 'task_records') {
      const sessionId = stringValue(row.session_id);
      if (!sessionId) {
        counts.skippedInvalid += 1;
        continue;
      }
      if (adapter.tasks.get(sessionId)) {
        counts.skippedExisting += 1;
        continue;
      }
      if (containsCaptureOff([row.goal, row.plan, row.decisions, row.touched_files])) {
        counts.skippedCaptureOff += 1;
        continue;
      }
      const touchedFiles = Array.isArray(row.touched_files) ? row.touched_files : [];
      const parsed = TaskRecordSchema.safeParse({
        sessionId,
        goal: row.goal,
        plan: row.plan,
        decisions: row.decisions,
        touchedFiles,
        nextStep: row.next_step ?? null,
      });
      if (!parsed.success) {
        counts.skippedInvalid += 1;
        continue;
      }
      adapter.tasks.put(parsed.data);
      counts.inserted += 1;
    }
  }
  return counts;
}

/** Creates empty hydration counters. */
export function createHydrationCounts(): HydrationCounts {
  return {
    inserted: 0,
    updatedSessions: 0,
    skippedExisting: 0,
    skippedCaptureOff: 0,
    skippedInvalid: 0,
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function containsCaptureOff(value: unknown): boolean {
  if (typeof value === 'string')
    return value.includes('content-capture-off') || value.includes('[content capture off:');
  if (Array.isArray(value)) return value.some(containsCaptureOff);
  if (value && typeof value === 'object') return Object.values(value).some(containsCaptureOff);
  return false;
}
