import { z } from 'zod';

export const FERRY_PROTOCOL = 'ferry/1' as const;
export const DomainErrorKindSchema = z.enum([
  'not_found',
  'validation',
  'conflict',
  'permission_denied',
  'unavailable',
  'not_implemented',
  'domain_error',
  'internal',
]);
export const FERRY_METHODS = [
  'workspaces.list',
  'workspaces.open',
  'workspaces.remove',
  'workspaces.update',
  'sessions.list',
  'sessions.search',
  'sessions.get',
  'sessions.create',
  'sessions.send',
  'sessions.cancel',
  'sessions.rename',
  'sessions.setStarred',
  'sessions.setPinned',
  'sessions.remove',
  'approvals.respond',
  'checkpoints.list',
  'checkpoints.diff',
  'checkpoints.restore',
  'providers.list',
  'providers.setKey',
  'providers.removeKey',
  'providers.probe',
  'providers.setEnabled',
  'quota.capacity',
  'quota.history',
  'quota.handoffs',
  'models.list',
  'models.candidates',
  'models.select',
  'profiles.list',
  'profiles.save',
  'profiles.remove',
  'profiles.activate',
  'settings.get',
  'settings.update',
  'optimizer.stats',
  'delegation.lanes',
  'delegation.detectAgents',
  'delegation.approveProjectLanes',
  'delegation.runs',
  'delegation.start',
  'delegation.cancel',
  'delegation.decide',
  'skills.list',
  'skills.setEnabled',
  'mcp.list',
  'mcp.setEnabled',
  'system.info',
  'system.hello',
  'system.selfTest',
] as const;
export const FERRY_EVENTS = [
  'session.updated',
  'session.status',
  'approval.request',
  'mcp.status',
  'session.message',
  'session.part',
  'session.delta',
  'task.updated',
  'quota.updated',
  'provider.updated',
  'delegation.updated',
  'workspace.updated',
  'workspace.removed',
  'settings.updated',
  'toast',
] as const;
export const FERRY_DOMAINS = [
  ...new Set(FERRY_METHODS.map((method) => method.split('.')[0] ?? '')),
].filter((domain) => domain !== 'system');

export const JsonRpcIdSchema = z.union([z.string(), z.number().int(), z.null()]);
export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number().int()]),
  method: z.string().regex(/^[a-z][a-zA-Z0-9_-]*\.[a-z][a-zA-Z0-9_-]*$/),
  params: z.array(z.unknown()).optional(),
});
export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().regex(/^[a-z][a-zA-Z0-9_-]*\.[a-z][a-zA-Z0-9_-]*$/),
  params: z.unknown().optional(),
});
export const JsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.object({ kind: z.string(), details: z.unknown().optional() }).optional(),
});
export const JsonRpcSuccessSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema,
  result: z.unknown(),
});
export const JsonRpcFailureSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema,
  error: JsonRpcErrorSchema,
});
export const JsonRpcResponseSchema = z.union([JsonRpcSuccessSchema, JsonRpcFailureSchema]);

export const HelloParamsSchema = z.object({
  protocol: z.string(),
  capabilities: z.array(z.string()),
});
export const HelloResultSchema = z.object({
  protocol: z.literal(FERRY_PROTOCOL),
  capabilities: z.array(z.string()),
  realDomains: z.array(z.string()),
  implementedMethods: z.array(z.string()),
});
export const SelfTestResultSchema = z.object({
  modules: z.array(
    z.object({
      name: z.string(),
      ok: z.boolean(),
      version: z.string().nullable(),
      error: z.string().nullable(),
    }),
  ),
});

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;
export type HelloResult = z.infer<typeof HelloResultSchema>;

export function rpcError(code: number, kind: string, message: string, details?: unknown) {
  return { code, message, data: { kind, ...(details === undefined ? {} : { details }) } };
}
