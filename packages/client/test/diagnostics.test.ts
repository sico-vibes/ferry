import { expect, it, vi } from 'vitest';
import { collectDiagnostics, createMockFerryClient } from '../src/index.js';
it('exports an allowlist without credentials, arbitrary errors, paths or headers', async () => {
  const client = createMockFerryClient();
  const info = await client.system.info();
  vi.spyOn(client.system, 'info').mockResolvedValue({ ...info, dataDir: 'private-path' });
  const health = await client.providers.health();
  vi.spyOn(client.providers, 'health').mockResolvedValue(
    health.map((row) => ({
      ...row,
      lastError: 'secret-fixture',
      keys: [{ keyId: 'sensitive-key-id', cooldownUntil: null, reason: 'secret-fixture' }],
    })),
  );
  const report = await collectDiagnostics(client);
  expect(report.format).toBe('ferry-diagnostics/1');
  expect(report.providers.length).toBeGreaterThan(0);
  expect(JSON.stringify(report)).not.toMatch(
    /private-path|secret-fixture|sensitive-key-id|providerOverrides/,
  );
});
