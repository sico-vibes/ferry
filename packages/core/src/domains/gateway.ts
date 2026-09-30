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
    compressToolResults: z.boolean().optional(),
    terseSystemPrompt: z.boolean().optional(),
  }),
});
export function register(host: CoreHost, services: FerryServices): void {
  const gateway = createGatewayController(services);
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
    createKey(value: unknown) {
      return gateway.createKey(...(Object.values(createSchema.parse(value)) as [string, string]));
    },
    updateKey(value: unknown) {
      const parsed = updateSchema.parse(value);
      const patch = {
        ...(parsed.patch.profile === undefined ? {} : { profile: parsed.patch.profile }),
        ...(parsed.patch.allowedModels === undefined
          ? {}
          : { allowedModels: parsed.patch.allowedModels }),
        ...(parsed.patch.rateLimit === undefined ? {} : { rateLimit: parsed.patch.rateLimit }),
        ...(parsed.patch.compressToolResults === undefined
          ? {}
          : { compressToolResults: parsed.patch.compressToolResults }),
        ...(parsed.patch.terseSystemPrompt === undefined
          ? {}
          : { terseSystemPrompt: parsed.patch.terseSystemPrompt }),
      };
      return gateway.updateKey(parsed.id, patch);
    },
    revokeKey(value: unknown) {
      gateway.revokeKey(idSchema.parse(value));
      return gateway.listKeys();
    },
    async start() {
      return await gateway.start();
    },
    async stop() {
      return await gateway.stop();
    },
  });
}
