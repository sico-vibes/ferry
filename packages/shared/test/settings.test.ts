import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_SETTINGS,
  resolveCaptureContent,
  SettingsSchema,
  SettingsPatchSchema,
} from '../src/index.js';
import { sampleSettings } from '../src/testing/index.js';

describe('storage and content capture settings', () => {
  it('does not clear other spending limits when patching one cap', () => {
    expect(SettingsPatchSchema.parse({ paidCaps: { dailyUsd: 1 } }).paidCaps).toEqual({
      dailyUsd: 1,
    });
  });
  it('does not clear CLI connection opt-ins when patching unrelated settings', () => {
    const patch = SettingsPatchSchema.parse({ theme: 'light' });
    expect('cliConnections' in patch).toBe(false);
    const current = SettingsSchema.parse({
      ...sampleSettings,
      cliConnections: {
        'codex-cli': {
          native: true,
          gateway: true,
          defaultOptions: { effort: 'high', speed: 'fast' },
          modelDefaults: {},
        },
      },
    });
    // Mirrors the Core settings domain and mock merges (`{ ...current, ...patch }`).
    const merged = SettingsSchema.parse({ ...current, ...patch });
    expect(merged.cliConnections['codex-cli']).toMatchObject({ native: true, gateway: true });
    expect(merged.cliConnections['codex-cli']?.defaultOptions).toEqual({
      effort: 'high',
      speed: 'fast',
    });
  });
  it('defaults older settings to local mode and resolves capture by mode', () => {
    const { storageMode: _mode, captureContent: _capture, ...legacyInput } = sampleSettings;
    const legacy = SettingsSchema.parse(legacyInput);
    expect(legacy.routing.pinnedExhaustion).toBe('handover');
    expect(DEFAULT_ROUTING_SETTINGS.pinnedExhaustion).toBe('handover');
    expect(legacy.storageMode).toBe('local');
    expect(resolveCaptureContent(legacy)).toBe(false);
    expect(resolveCaptureContent({ storageMode: 'cloud', captureContent: undefined })).toBe(true);
    expect(resolveCaptureContent({ storageMode: 'cloud', captureContent: false })).toBe(false);
  });
});
