import type { FerryClient } from './ferry-client.js';

/** An allowlist, not a scrub of arbitrary logs: never includes secrets, paths or content. */
export async function collectDiagnostics(client: FerryClient) {
  const [info, providers, health, gateway, settings] = await Promise.all([
    client.system.info(),
    client.providers.list(),
    client.providers.health(),
    client.gateway.settings(),
    client.settings.get(),
  ]);
  return {
    format: 'ferry-diagnostics/1',
    generatedAt: new Date().toISOString(),
    version: info.version,
    platform: info.platform,
    mock: info.mock,
    gateway: { running: gateway.status.running, port: gateway.status.port },
    settings: { storageMode: settings.storageMode, logRetentionDays: settings.logRetentionDays },
    providers: providers.map((provider) => ({
      id: provider.id,
      enabled: provider.enabled,
      keyStatus: provider.keyStatus,
      health: provider.health,
      modelCount: provider.modelCount,
      modelsVerifiedAt: provider.modelsVerifiedAt ?? null,
      discoveryErrorClass: provider.discoveryErrorClass ?? null,
      latencyP50Ms: health.find((row) => row.providerId === provider.id)?.latencyP50Ms ?? null,
      successRate1h: health.find((row) => row.providerId === provider.id)?.successRate1h ?? null,
    })),
  };
}
