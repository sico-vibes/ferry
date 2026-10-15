import { describe, expect, it } from 'vitest';
import { ProviderIdSchema, type ModelRef } from '@ferry/shared';
import { createMockFerryClient } from '../src/index.js';

const FREE_ZEN = 'opencode-cli/opencode/deepseek-v4.1-flash-free' as ModelRef;
const GO = 'opencode-cli/opencode-go/deepseek-v4.1-flash' as ModelRef;
const LEGACY_FREE_ALIAS = 'opencode/deepseek-v4.1-flash-free' as ModelRef;
const LEGACY_API_ZEN = 'opencode/big-pickle' as ModelRef;
const OPENCODE = ProviderIdSchema.parse('opencode');
const OPENCODE_GO = ProviderIdSchema.parse('opencode-go');

/** Select the installed Zen CLI transport, mirroring the two writes the UI performs. */
async function enableZenCli(client: ReturnType<typeof createMockFerryClient>): Promise<void> {
  await client.cliConnections.update('opencode-cli', { surfaces: { native: true } });
  await client.settings.update({ opencodeZenTransport: 'cli' });
}

describe('mock Zen CLI facade', () => {
  it('reports the discovered free Zen list and source without treating a Go credential as proof', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const status = await client.providers.zenCliStatus();
    expect(status.available).toBe(true);
    expect(status.executable).toBe('opencode');
    expect(status.version).toBe('1.18.35');
    // Only the actually discovered free Zen model, expressed in canonical CLI refs. The legacy API
    // catalog row (`opencode/big-pickle`) is deliberately not reported as a CLI free model.
    expect(status.freeModels).toEqual([{ ref: FREE_ZEN, name: 'DeepSeek V4.1 Flash (Free)' }]);
    // The mock connection carries an OpenCode Go label, which is the declared source…
    expect(status.credentialSource).toBe('opencode_go');
    // …but a Go credential is never proof of Zen access on its own.
    expect(status.verifiedModels).toEqual([]);
  });

  it('rejects explicit unknown or non-free targets instead of verifying another model', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const unknown = await client.providers.verifyZenCli('opencode/does-not-exist');
    expect(unknown).toMatchObject({ ok: false, modelRef: 'opencode/does-not-exist' });
    expect(unknown.message).toMatch(/not a discovered free Zen model/);
    const nonFree = await client.providers.verifyZenCli(GO);
    expect(nonFree).toMatchObject({ ok: false, modelRef: GO });
    // The legacy API-only Zen row has no canonical CLI counterpart, so it is not a CLI target either.
    const legacyApi = await client.providers.verifyZenCli(LEGACY_API_ZEN);
    expect(legacyApi).toMatchObject({ ok: false, modelRef: LEGACY_API_ZEN });
    expect((await client.providers.zenCliStatus()).verifiedModels).toEqual([]);
  });

  it('records canonical proof through the shared receipts without enabling a surface', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const result = await client.providers.verifyZenCli(FREE_ZEN);
    expect(result).toMatchObject({ ok: true, modelRef: FREE_ZEN });
    expect((await client.providers.zenCliStatus()).verifiedModels).toEqual([FREE_ZEN]);
    const connection = (await client.cliConnections.list()).find(
      (entry) => entry.kind === 'opencode-cli',
    );
    expect(connection?.verify.state).toBe('verified');
    expect(connection?.verify.modelReceipts?.[FREE_ZEN]).toBeTruthy();
    // Verification never opts the connection into a surface by itself.
    expect(connection?.surfaces).toEqual({ native: false, gateway: false });
    const settings = await client.settings.get();
    expect(settings.cliConnections['opencode-cli']?.native ?? false).toBe(false);
    expect(settings.cliConnections['opencode-cli']?.gateway ?? false).toBe(false);
  });

  it('resolves the legacy alias only in CLI mode and preserves the caller ref while proving canonical', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    // API mode: the legacy `opencode/<id>` alias is not accepted as a CLI target.
    expect((await client.providers.verifyZenCli(LEGACY_FREE_ALIAS)).ok).toBe(false);
    await enableZenCli(client);
    const result = await client.providers.verifyZenCli(LEGACY_FREE_ALIAS);
    // The caller's original ref is preserved; the underlying proof is the canonical model.
    expect(result).toMatchObject({ ok: true, modelRef: LEGACY_FREE_ALIAS });
    expect((await client.providers.zenCliStatus()).verifiedModels).toEqual([FREE_ZEN]);
  });

  it('keeps a genuine API reference out of the CLI route while the general CLI surface is on', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    await enableZenCli(client);
    // `opencode/big-pickle` is a real API ref with no canonical CLI counterpart: enabling the
    // OpenCode CLI surface must not silently reroute it through the CLI.
    expect((await client.providers.verifyZenCli(LEGACY_API_ZEN)).ok).toBe(false);
    const apiModels = await client.models.list(ProviderIdSchema.parse('opencode'));
    expect(apiModels.some((model) => model.ref === LEGACY_API_ZEN)).toBe(true);
    expect(apiModels.some((model) => model.ref.startsWith('opencode-cli/opencode/'))).toBe(false);
  });

  it('invalidates CLI proof on a source change without touching Go or API keys', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    await client.providers.addKey(OPENCODE, 'Zen API', 'zen-api-key');
    await client.providers.addKey(OPENCODE_GO, 'Go', 'go-key-1234');
    const zenKeys = await client.providers.listKeys(OPENCODE);
    const goKeys = await client.providers.listKeys(OPENCODE_GO);
    await client.providers.verifyZenCli(FREE_ZEN);
    expect((await client.providers.zenCliStatus()).verifiedModels).toEqual([FREE_ZEN]);

    // Switching the shared credential source invalidates the recorded Zen proof…
    await client.cliConnections.update('opencode-cli', { credentialMode: 'anonymous' });
    const anonymousStatus = await client.providers.zenCliStatus();
    expect(anonymousStatus.verifiedModels).toEqual([]);
    expect(anonymousStatus.credentialSource).toBe('anonymous');

    // …and the legacy Ferry-key opt-in is a source change too.
    await client.cliConnections.update('opencode-cli', { credentialMode: 'installed' });
    await client.providers.verifyZenCli(FREE_ZEN);
    expect((await client.providers.zenCliStatus()).verifiedModels).toEqual([FREE_ZEN]);
    await client.settings.update({ opencodeZenCliUseFerryKey: true });
    expect((await client.providers.zenCliStatus()).verifiedModels).toEqual([]);

    // Provider API/Go keys are untouched by a Zen credential-source change.
    expect(await client.providers.listKeys(OPENCODE)).toEqual(zenKeys);
    expect(await client.providers.listKeys(OPENCODE_GO)).toEqual(goKeys);
  });

  it('validates per-conversation options against canonical capabilities once the alias resolves', async () => {
    const client = createMockFerryClient({ behavior: 'test' });
    const session = (await client.sessions.list())[0];
    if (!session) throw new Error('Mock session fixture missing');
    // API mode: the alias does not resolve to a CLI model, so no CLI capability validation applies.
    const apiMode = await client.sessions.updateCliOptions(session.id, {
      modelRef: LEGACY_FREE_ALIAS,
      options: { effort: 'max' },
    });
    expect(apiMode.cliOptions?.[LEGACY_FREE_ALIAS]).toMatchObject({ effort: 'max' });
    await enableZenCli(client);
    // In CLI mode the alias resolves to the canonical free model; a valid option is stored under the
    // caller's alias key, never rewritten to the canonical ref.
    const updated = await client.sessions.updateCliOptions(session.id, {
      modelRef: LEGACY_FREE_ALIAS,
      options: { effort: 'high' },
    });
    expect(updated.cliOptions?.[LEGACY_FREE_ALIAS]).toMatchObject({ effort: 'high' });
    expect(updated.cliOptions?.[FREE_ZEN]).toBeUndefined();
    // The free Zen model advertises only low/high, so `max` is rejected against its capabilities.
    await expect(
      client.sessions.updateCliOptions(session.id, {
        modelRef: LEGACY_FREE_ALIAS,
        options: { effort: 'max' },
      }),
    ).rejects.toThrow(/not a supported effort/);
  });
});
