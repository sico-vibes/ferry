import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  CapacitySummary,
  DelegationRun,
  Message,
  MessagePart,
  Provider,
  Session,
  TaskRecord,
} from '@ferry/shared';
import {
  sampleCapacitySummary,
  sampleDelegationRun,
  sampleMessage,
  sampleMessagePart,
  sampleProvider,
  sampleSession,
  sampleTaskRecord,
  sampleWorkspace,
  sampleSettings,
} from '@ferry/shared/testing';
import type { FerryClient } from '../src/ferry-client.js';
import { FerryEventSchemas } from '../src/events.js';

const sessionId = sampleSession.id;
const messageId = sampleMessage.id;
const partId = sampleMessagePart.id;
const samples = {
  'session.updated': sampleSession satisfies Session,
  'session.status': sampleSession satisfies Session,
  'approval.request': {
    sessionId,
    messageId,
    part: {
      type: 'approval_request',
      id: partId,
      kind: 'command',
      summary: 'Run tests',
      detail: 'npm test',
      risk: 'high',
      state: 'pending',
    },
  },
  'mcp.status': { serverId: 'fixture', status: 'connected', toolCount: 2 },
  'session.message': { sessionId, message: sampleMessage } satisfies {
    sessionId: string;
    message: Message;
  },
  'session.part': { sessionId, messageId, part: sampleMessagePart } satisfies {
    sessionId: string;
    messageId: string;
    part: MessagePart;
  },
  'session.delta': { sessionId, messageId, partId, textDelta: 'delta' },
  'task.updated': sampleTaskRecord satisfies TaskRecord,
  'quota.updated': sampleCapacitySummary satisfies CapacitySummary,
  'provider.updated': sampleProvider satisfies Provider,
  'delegation.updated': sampleDelegationRun satisfies DelegationRun,
  'workspace.updated': sampleWorkspace,
  'workspace.removed': { id: sampleWorkspace.id },
  'settings.updated': sampleSettings,
  toast: { kind: 'info', title: 'Ready', body: null },
  'oauth.progress': { type: 'success', id: 'anthropic' },
} as const;

describe('Ferry event schemas', () => {
  for (const event of Object.keys(FerryEventSchemas) as (keyof typeof FerryEventSchemas)[]) {
    it(`parses ${event}`, () => {
      expect(FerryEventSchemas[event].safeParse(samples[event]).success).toBe(true);
    });
  }
});

describe('FerryClient types', () => {
  it('returns SessionDetail from sessions.get', () => {
    expectTypeOf<FerryClient['sessions']['get']>().returns.toEqualTypeOf<
      Promise<import('@ferry/shared').SessionDetail>
    >();
  });
});
