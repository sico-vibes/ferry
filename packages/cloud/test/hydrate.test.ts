import { describe, expect, it } from 'vitest';
import { createStorageAdapter, openDatabase, OutboxRepository } from '@ferry/storage';
import { applyHydratedRows } from '../src/index.js';
import type { Message, Session, Workspace } from '@ferry/shared';

const workspace: Workspace = {
  pinned: false,
  chatCount: 0,
  lastActivityAt: null,
  id: 'workspace_1' as Workspace['id'],
  name: 'Local',
  path: '/work/local',
  trusted: true,
  riskyRoot: false,
  gitBranch: null,
  language: 'ts' as const,
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  settings: {
    gateCommands: [],
    instructionsFile: null,
    defaultProfileId: null,
    permissionMode: 'ask' as const,
  },
};
const session: Session = {
  archived: false,
  id: 'session_1' as Session['id'],
  workspaceId: workspace.id,
  title: 'Local',
  preview: '',
  profileId: 'profile_1' as Session['profileId'],
  modelRef: null,
  pinnedModelRef: null,
  starred: false,
  pinned: false,
  status: 'idle' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  agentEvents: [],
};

describe('cloud hydration', () => {
  it('does not clobber local rows or echo hydrated rows to the outbox', async () => {
    const db = await openDatabase(':memory:');
    try {
      const adapter = createStorageAdapter({ client: db.client, mode: 'local' });
      const outbox = new OutboxRepository(db.client);
      adapter.workspaces.put(workspace);
      adapter.sessions.put(session);
      const message: Message = {
        id: 'message_1' as Message['id'],
        sessionId: session.id,
        role: 'assistant',
        createdAt: session.createdAt,
        modelRef: null,
        parts: [{ type: 'text', id: 'part_1' as Message['parts'][number]['id'], text: 'local' }],
      };
      adapter.messages.put(message);
      outbox.enqueue({
        opId: 'sessions:session_1',
        target: 'sessions',
        op: 'upsert',
        payload: { id: 'session_1' },
      });
      const counts = applyHydratedRows(
        'sessions',
        [
          {
            id: session.id,
            metadata: {
              data: { ...session, title: 'Cloud newer', updatedAt: '2026-01-03T00:00:00.000Z' },
            },
          },
        ],
        adapter,
        outbox,
      );
      applyHydratedRows(
        'workspaces',
        [
          {
            id: workspace.id,
            name: 'Cloud',
            path: '/work/cloud',
            language: 'ts',
            settings: workspace.settings,
          },
        ],
        adapter,
        outbox,
      );
      applyHydratedRows(
        'messages',
        [
          {
            id: message.id,
            session_id: session.id,
            role: 'assistant',
            created_at: session.createdAt,
            parts: [{ type: 'text', id: 'part_1', text: 'cloud' }],
          },
        ],
        adapter,
        outbox,
      );
      expect(adapter.sessions.get(session.id)?.title).toBe('Local');
      expect(adapter.workspaces.get(workspace.id)?.name).toBe('Local');
      expect(adapter.messages.get(message.id)?.parts[0]).toMatchObject({ text: 'local' });
      expect(outbox.counts().pending).toBe(1);
      expect(counts.skippedExisting).toBe(1);
    } finally {
      db.close();
    }
  });

  it('skips capture-off placeholders and preserves lossless message metadata on insert', async () => {
    const db = await openDatabase(':memory:');
    try {
      const adapter = createStorageAdapter({ client: db.client, mode: 'local' });
      const outbox = new OutboxRepository(db.client);
      const counts = applyHydratedRows(
        'messages',
        [
          {
            id: 'message_off',
            session_id: session.id,
            role: 'assistant',
            created_at: session.createdAt,
            parts: [{ type: 'text', text: '[content capture off: 12 chars]' }],
          },
          {
            id: 'message_full',
            session_id: session.id,
            role: 'assistant',
            agent_role: 'editor',
            created_at: session.createdAt,
            model_ref: 'openai/gpt-4o',
            turn_id: 'turn_1',
            model_attempts: [
              {
                model: 'openai/gpt-4o',
                provider: 'openai',
                status: 200,
                latencyMs: 12,
                errorKind: null,
              },
            ],
            parts: [{ type: 'text', id: 'part_1', text: 'answer' }],
          },
        ],
        adapter,
        outbox,
      );
      expect(counts.skippedCaptureOff).toBe(1);
      expect(adapter.messages.get('message_full')).toMatchObject({
        role: 'assistant',
        agentRole: 'editor',
        modelRef: 'openai/gpt-4o',
        turnId: 'turn_1',
        createdAt: session.createdAt,
        parts: [{ text: 'answer' }],
      });
      expect(outbox.counts().pending).toBe(0);
    } finally {
      db.close();
    }
  });
});
