import { z } from 'zod';
import { ReadOutputInputSchema } from './domain/session.js';
import { ProviderIdSchema, SessionIdSchema, WorkspaceIdSchema } from './domain/ids.js';
import { EffortSchema } from './domain/provider.js';

export const FERRY_PROTOCOL = 'ferry/1' as const;
export const DomainErrorKindSchema = z.enum([
  'not_found',
  'validation',
  'conflict',
  'permission_denied',
  'unavailable',
  'gateway_not_running',
  'not_implemented',
  'domain_error',
  'internal',
  'workspace_untrusted',
]);
export const FERRY_METHODS = [
  'workspaces.list',
  'workspaces.open',
  'workspaces.remove',
  'workspaces.update',
  'workspaces.archiveChats',
  'workspaces.searchFiles',
  'workspaces.trust',
  'sessions.list',
  'sessions.search',
  'sessions.get',
  'sessions.readOutput',
  'sessions.create',
  'sessions.start',
  'sessions.send',
  'sessions.resume',
  'sessions.cancel',
  'sessions.rename',
  'sessions.setStarred',
  'sessions.setPinned',
  'sessions.setEffort',
  'sessions.archive',
  'sessions.move',
  'sessions.remove',
  'approvals.respond',
  'checkpoints.list',
  'checkpoints.diff',
  'checkpoints.restore',
  'providers.list',
  'providers.listKeys',
  'providers.effectiveOverrides',
  'providers.setKey',
  'providers.addKey',
  'providers.removeKey',
  'providers.removeKeyEntry',
  'providers.setKeyEnabled',
  'providers.reorderKeys',
  'providers.setAutoDisablePolicy',
  'providers.probe',
  'providers.setEnabled',
  'providers.setBillingEnabled',
  'oauth.list',
  'oauth.login',
  'oauth.logout',
  'oauth.status',
  'quota.capacity',
  'quota.limits',
  'quota.history',
  'quota.handoffs',
  'models.list',
  'models.page',
  'models.candidates',
  'models.select',
  'profiles.list',
  'profiles.save',
  'profiles.remove',
  'profiles.activate',
  'settings.get',
  'settings.update',
  'cloud.status',
  'cloud.signIn',
  'cloud.signOut',
  'cloud.setStorageMode',
  'cloud.syncNow',
  'cloud.setCaptureContent',
  'cloud.migrateLocalKeys',
  'optimizer.stats',
  'delegation.lanes',
  'delegation.detectAgents',
  'delegation.approveProjectLanes',
  'delegation.approveProjectConfig',
  'delegation.runs',
  'delegation.start',
  'delegation.cancel',
  'delegation.decide',
  'skills.list',
  'skills.setEnabled',
  'mcp.list',
  'mcp.setEnabled',
  'gateway.settings',
  'gateway.setSettings',
  'gateway.listKeys',
  'gateway.createKey',
  'gateway.updateKey',
  'gateway.revokeKey',
  'gateway.requests',
  'gateway.start',
  'gateway.stop',
  'system.info',
  'system.hello',
  'system.selfTest',
] as const;
export const FERRY_METHOD_PARAMS_SCHEMAS: Readonly<
  Record<string, z.ZodType<unknown[]> | undefined>
> = {
  'sessions.readOutput': z.tuple([ReadOutputInputSchema]),
  'sessions.setEffort': z.tuple([SessionIdSchema, EffortSchema.nullable()]),
  'sessions.archive': z.tuple([SessionIdSchema, z.boolean()]),
  'sessions.move': z.tuple([SessionIdSchema, WorkspaceIdSchema.nullable()]),
  'workspaces.archiveChats': z.tuple([WorkspaceIdSchema]),
  'workspaces.searchFiles': z.tuple([
    z.object({
      workspaceId: WorkspaceIdSchema,
      query: z.string().max(512),
      limit: z.number().int().positive().max(200).optional(),
    }),
  ]),
  'quota.limits': z.tuple([]),
  'providers.listKeys': z.tuple([ProviderIdSchema]),
  'providers.effectiveOverrides': z.tuple([ProviderIdSchema]),
  'providers.setKey': z.tuple([ProviderIdSchema, z.string()]),
  'providers.addKey': z.tuple([ProviderIdSchema, z.string(), z.string()]),
  'providers.removeKeyEntry': z.tuple([ProviderIdSchema, z.string()]),
  'providers.setKeyEnabled': z.tuple([ProviderIdSchema, z.string(), z.boolean()]),
  'providers.reorderKeys': z.tuple([ProviderIdSchema, z.array(z.string())]),
  'providers.setAutoDisablePolicy': z.tuple([
    ProviderIdSchema,
    z.object({
      enabled: z.boolean(),
      failureCount: z.number().int().min(2).max(20),
      failureWindowMinutes: z.number().int().min(1).max(1440),
      statusCodes: z.array(z.number().int().min(100).max(599)),
      keywords: z.array(z.string().trim().min(1).max(120)),
      disableMinutes: z.number().int().min(1).max(1440),
    }),
  ]),
  'providers.probe': z.tuple([ProviderIdSchema, z.string().optional()]),
  'cloud.signIn': z.tuple([z.object({ email: z.email(), password: z.string().min(1) })]),
  'cloud.setStorageMode': z.tuple([z.object({ mode: z.enum(['local', 'cloud']) })]),
  'cloud.setCaptureContent': z.tuple([z.object({ value: z.boolean().nullable() })]),
};
export const FERRY_EVENTS = [
  'session.updated',
  'session.removed',
  'session.status',
  'approval.request',
  'mcp.status',
  'session.message',
  'session.part',
  'session.delta',
  'agent.event',
  'routing.explain',
  'task.updated',
  'quota.updated',
  'quota.limits.updated',
  'provider.updated',
  'delegation.updated',
  'workspace.updated',
  'workspace.removed',
  'settings.updated',
  'cloud.status',
  'toast',
  'oauth.progress',
  'gateway.request',
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
