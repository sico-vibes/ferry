import { z } from 'zod';
import {
  CapacitySummarySchema,
  DelegationRunSchema,
  MessageIdSchema,
  MessagePartSchema,
  MessageSchema,
  PartIdSchema,
  ProviderSchema,
  SessionIdSchema,
  SessionSchema,
  TaskRecordSchema,
} from '@ferry/shared';
import type {
  CapacitySummary,
  DelegationRun,
  Message,
  MessagePart,
  Provider,
  Session,
  TaskRecord,
} from '@ferry/shared';

export const FerryEventSchemas = {
  'session.updated': SessionSchema,
  'session.message': z.object({ sessionId: SessionIdSchema, message: MessageSchema }),
  'session.part': z.object({
    sessionId: SessionIdSchema,
    messageId: MessageIdSchema,
    part: MessagePartSchema,
  }),
  'session.delta': z.object({
    sessionId: SessionIdSchema,
    messageId: MessageIdSchema,
    partId: PartIdSchema,
    textDelta: z.string(),
  }),
  'task.updated': TaskRecordSchema,
  'quota.updated': CapacitySummarySchema,
  'provider.updated': ProviderSchema,
  'delegation.updated': DelegationRunSchema,
  toast: z.object({
    kind: z.enum(['info', 'success', 'warning', 'error']),
    title: z.string(),
    body: z.string().nullable(),
  }),
} as const;
export interface FerryEvents {
  'session.updated': Session;
  'session.message': { sessionId: import('@ferry/shared').SessionId; message: Message };
  'session.part': {
    sessionId: import('@ferry/shared').SessionId;
    messageId: import('@ferry/shared').MessageId;
    part: MessagePart;
  };
  'session.delta': {
    sessionId: import('@ferry/shared').SessionId;
    messageId: import('@ferry/shared').MessageId;
    partId: import('@ferry/shared').PartId;
    textDelta: string;
  };
  'task.updated': TaskRecord;
  'quota.updated': CapacitySummary;
  'provider.updated': Provider;
  'delegation.updated': DelegationRun;
  toast: { kind: 'info' | 'success' | 'warning' | 'error'; title: string; body: string | null };
}
