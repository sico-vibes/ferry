import { z } from 'zod';
import { createGatewayController } from '../gateway.js';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';
import { GatewayHistoryQuerySchema } from '@ferry/shared';

const settingsSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(0).max(65535),
  allowLan: z.boolean(),
  confirmLan: z.boolean().optional(),
});
const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  profile: z.string().min(1).max(100),
});
const idSchema = z.string().min(1).max(64);
const updateSchema = z.object({
  id: idSchema,
  patch: z.object({
    paidBackup: z.boolean().optional(),
    client: z.string().max(80).optional(),
    budgetUsd: z.number().positive().nullable().optional(),
    profile: z.string().optional(),
    allowedModels: z.array(z.string()).optional(),
    rateLimit: z.number().int().positive().nullable().optional(),
    tokenLimitPerMinute: z.number().int().positive().nullable().optional(),
    tokenLimitPerDay: z.number().int().positive().nullable().optional(),
    concurrencyLimit: z.number().int().positive().nullable().optional(),
    compressToolResults: z.boolean().optional(),
    terseSystemPrompt: z.boolean().optional(),
  }),
});
export function register(host: CoreHost, services: FerryServices): void {
  const gateway = createGatewayController(services, (record) => {
    host.emit('gateway.request', record);
  });
  host.onStart(async () => {
    if (gateway.settings.enabled) await gateway.start(gateway.settings);
  });
  host.onShutdown(async () => {
    await gateway.stop();
  });
  host.registerDomain('gateway', {
    settings: () => ({ ...gateway.settings, status: gateway.status }),
    async setSettings(value: unknown) {
      const parsed = settingsSchema.parse(value);
      if (parsed.allowLan && parsed.confirmLan !== true)
        throw new Error('Enabling LAN connections requires explicit confirmation');
      return await gateway.setSettings(parsed);
    },
    listKeys: () => gateway.listKeys(),
    async createKey(value: unknown) {
      const created = gateway.createKey(
        ...(Object.values(createSchema.parse(value)) as [string, string]),
      );
      await services.gatewaySecrets.set(`gateway:${created.key.id}`, created.secret);
      return created;
    },
    async keySecret(value: unknown) {
      const id = idSchema.parse(value);
      if (!gateway.key(id)) throw new Error(`Unknown or revoked Gateway key: ${id}`);
      const secret = await services.gatewaySecrets.get(`gateway:${id}`);
      if (!secret)
        throw new Error(
          'This legacy Gateway key cannot be retrieved. Create a new key for tool launch.',
        );
      return secret;
    },
    updateKey(value: unknown) {
      const parsed = updateSchema.parse(value);
      const patch = {
        ...(parsed.patch.client === undefined ? {} : { client: parsed.patch.client }),
        ...(parsed.patch.paidBackup === undefined ? {} : { paidBackup: parsed.patch.paidBackup }),
        ...(parsed.patch.budgetUsd === undefined ? {} : { budgetUsd: parsed.patch.budgetUsd }),
        ...(parsed.patch.profile === undefined ? {} : { profile: parsed.patch.profile }),
        ...(parsed.patch.allowedModels === undefined
          ? {}
          : { allowedModels: parsed.patch.allowedModels }),
        ...(parsed.patch.rateLimit === undefined ? {} : { rateLimit: parsed.patch.rateLimit }),
        ...(parsed.patch.tokenLimitPerMinute === undefined
          ? {}
          : { tokenLimitPerMinute: parsed.patch.tokenLimitPerMinute }),
        ...(parsed.patch.tokenLimitPerDay === undefined
          ? {}
          : { tokenLimitPerDay: parsed.patch.tokenLimitPerDay }),
        ...(parsed.patch.concurrencyLimit === undefined
          ? {}
          : { concurrencyLimit: parsed.patch.concurrencyLimit }),
        ...(parsed.patch.compressToolResults === undefined
          ? {}
          : { compressToolResults: parsed.patch.compressToolResults }),
        ...(parsed.patch.terseSystemPrompt === undefined
          ? {}
          : { terseSystemPrompt: parsed.patch.terseSystemPrompt }),
      };
      return gateway.updateKey(parsed.id, patch);
    },
    async revokeKey(value: unknown) {
      const id = idSchema.parse(value);
      gateway.revokeKey(id);
      // A revoked key's secret is never needed again; don't leave it in the keyring.
      await services.gatewaySecrets.delete(`gateway:${id}`);
      return gateway.listKeys();
    },
    requests: () => gateway.requests(),
    history: (value: unknown = {}) => gateway.history(GatewayHistoryQuerySchema.parse(value)),
    request: (value: unknown) => gateway.request(idSchema.parse(value)),
    usage: (value: unknown = {}) => {
      const parsed = z
        .object({
          range: z.enum(['24h', '7d', '30d']).default('24h'),
          groupBy: z.enum(['key', 'provider', 'model']).default('key'),
        })
        .parse(value);
      return gateway.usage(parsed.range, parsed.groupBy);
    },
    activity: () => gateway.activity(),
    routing: (value: unknown) =>
      gateway.routing(value === undefined ? undefined : idSchema.parse(value)),
    async rotateKey(value: unknown) {
      const id = idSchema.parse(value);
      const created = await gateway.rotateKey(id, (secret) =>
        services.gatewaySecrets.set(`gateway:${id}`, secret),
      );
      return created;
    },
    testConnection: (value: unknown) => {
      const parsed = z
        .object({
          id: idSchema,
          protocol: z.enum(['chat', 'responses', 'anthropic']).default('chat'),
          approvedCostUsd: z.number().positive().max(1).optional(),
        })
        .parse(value);
      return gateway.testConnection(parsed.id, parsed.protocol, parsed.approvedCostUsd);
    },
    async start() {
      return await gateway.start();
    },
    async stop() {
      return await gateway.stop();
    },
  });
}
