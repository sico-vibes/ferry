import { z } from 'zod';
import {
  CapacitySummarySchema,
  ProviderLimitsSchema,
  DelegationRunSchema,
  AgentEventSchema,
  GatewayRequestRecordSchema,
  MessageIdSchema,
  MessagePartSchema,
  MessageSchema,
  PartIdSchema,
  ProviderSchema,
  OAuthLoginProgressSchema,
  SettingsSchema,
  SessionIdSchema,
  SessionSchema,
  TaskRecordSchema,
  WorkspaceSchema,
  WorkspaceIdSchema,
} from '@ferry/shared';
import type {
  CapacitySummary,
  ProviderLimits,
  DelegationRun,
  AgentEvent,
  Message,
  MessagePart,
  Provider,
  Session,
  TaskRecord,
} from '@ferry/shared';

export const FerryEventSchemas = {
  'session.updated': SessionSchema,
  'session.removed': z.object({ id: SessionIdSchema }),
  'session.status': SessionSchema,
  'approval.request': z
    .object({
      sessionId: SessionIdSchema,
      messageId: MessageIdSchema,
      part: MessagePartSchema,
    })
    .refine((event) => event.part.type === 'approval_request'),
  'mcp.status': z.object({
    serverId: z.string(),
    status: z.enum(['connected', 'disconnected', 'error']),
    toolCount: z.number().int().nonnegative(),
    error: z.string().optional(),
  }),
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
  'agent.event': z.object({ sessionId: SessionIdSchema, event: AgentEventSchema }),
  'routing.explain': z.object({
    sessionId: SessionIdSchema,
    selected: z.string(),
    candidates: z.array(
      z.object({
        ref: z.string(),
        score: z.number(),
        explanation: z.string(),
        scoreBreakdown: z.object({
          tierFit: z.number(),
          headroom: z.number(),
          success: z.number(),
          latency: z.number(),
          cost: z.number(),
          affinity: z.number(),
          coding: z.number(),
          preference: z.number(),
          reasoning: z.number(),
          verification: z.number(),
        }),
      }),
    ),
    chain: z
      .array(
        z.object({
          provider: z.string(),
          pattern: z.string(),
          status: z.enum([
            'not_live',
            'cooling',
            'no_key',
            'tools_unsupported',
            'excluded_name',
            'ineligible',
            'available',
            'hit',
          ]),
          modelRef: z.string().nullable(),
          detail: z.string(),
        }),
      )
      .optional(),
    chainHit: z
      .object({ provider: z.string(), pattern: z.string(), modelRef: z.string() })
      .nullable()
      .optional(),
  }),
  'task.updated': TaskRecordSchema,
  'quota.updated': CapacitySummarySchema,
  'quota.limits.updated': z.array(ProviderLimitsSchema),
  'provider.updated': ProviderSchema,
  'delegation.updated': DelegationRunSchema,
  'workspace.updated': WorkspaceSchema,
  'workspace.removed': z.object({ id: WorkspaceIdSchema }),
  'settings.updated': SettingsSchema,
  'cloud.status': z.object({
    storageMode: z.enum(['local', 'cloud']),
    runningMode: z.enum(['local', 'cloud']).optional(),
    pendingMode: z.enum(['local', 'cloud']).nullable().optional(),
    configured: z.boolean(),
    ownerEmail: z.string().nullable(),
    message: z.string().nullable(),
    auth: z.object({
      signedIn: z.boolean(),
      email: z.string().nullable(),
      userId: z.string().nullable(),
      isOwner: z.boolean(),
    }),
    sync: z.object({
      pending: z.number(),
      failed: z.number(),
      lastError: z.string().nullable(),
      lastFlush: z.string().nullable(),
    }),
  }),
  toast: z.object({
    kind: z.enum(['info', 'success', 'warning', 'error']),
    title: z.string(),
    body: z.string().nullable(),
  }),
  'oauth.progress': OAuthLoginProgressSchema,
  'gateway.request': GatewayRequestRecordSchema,
} as const;
export interface FerryEvents {
  'session.updated': Session;
  'session.removed': { id: import('@ferry/shared').SessionId };
  'session.status': Session;
  'approval.request': {
    sessionId: import('@ferry/shared').SessionId;
    messageId: import('@ferry/shared').MessageId;
    part: Extract<MessagePart, { type: 'approval_request' }>;
  };
  'mcp.status': {
    serverId: string;
    status: 'connected' | 'disconnected' | 'error';
    toolCount: number;
    error?: string;
  };
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
  'agent.event': { sessionId: import('@ferry/shared').SessionId; event: AgentEvent };
  'routing.explain': {
    sessionId: import('@ferry/shared').SessionId;
    selected: string;
    candidates: {
      ref: string;
      score: number;
      explanation: string;
      scoreBreakdown: {
        tierFit: number;
        headroom: number;
        success: number;
        latency: number;
        cost: number;
        affinity: number;
        coding: number;
        preference: number;
        reasoning: number;
        verification: number;
      };
    }[];
    chain?: {
      provider: string;
      pattern: string;
      status:
        | 'not_live'
        | 'cooling'
        | 'no_key'
        | 'tools_unsupported'
        | 'excluded_name'
        | 'ineligible'
        | 'available'
        | 'hit';
      modelRef: string | null;
      detail: string;
    }[];
    chainHit?: { provider: string; pattern: string; modelRef: string } | null;
  };
  'task.updated': TaskRecord;
  'quota.updated': CapacitySummary;
  'quota.limits.updated': ProviderLimits[];
  'provider.updated': Provider;
  'delegation.updated': DelegationRun;
  'workspace.updated': import('@ferry/shared').Workspace;
  'workspace.removed': { id: import('@ferry/shared').WorkspaceId };
  'settings.updated': import('@ferry/shared').Settings;
  'cloud.status': import('./ferry-client.js').CloudStatus;
  toast: { kind: 'info' | 'success' | 'warning' | 'error'; title: string; body: string | null };
  'oauth.progress': import('@ferry/shared').OAuthLoginProgress;
  'gateway.request': import('@ferry/shared').GatewayRequestRecord;
}
