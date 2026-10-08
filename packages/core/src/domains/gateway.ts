import { z } from 'zod';
import { createGatewayController } from '../gateway.js';
import type { CoreHost } from '../host.js';
import type { FerryServices } from '../services.js';

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
    async start() {
      return await gateway.start();
    },
    async stop() {
      return await gateway.stop();
    },
  });
}
