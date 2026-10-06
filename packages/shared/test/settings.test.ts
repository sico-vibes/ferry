import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTING_SETTINGS, resolveCaptureContent, SettingsSchema } from '../src/index.js';
import { sampleSettings } from '../src/testing/index.js';

describe('storage and content capture settings', () => {
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
