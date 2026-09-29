import { describe, expect, it } from 'vitest';
import {
  betaVersionForRunNumber,
  electronBuilderConfigForVersion,
  packageManifestWithVersion,
  releaseChannelForVersion,
} from '../../scripts/release-config.mjs';

describe('release build configuration', () => {
  it('stamps a run number into the beta package version', () => {
    expect(betaVersionForRunNumber(1)).toBe('0.9.0-beta.1');
    expect(() => betaVersionForRunNumber(0)).toThrow(RangeError);
  });

  it('changes package version data without changing the source manifest', () => {
    const manifest = { name: '@ferry/desktop', version: '0.9.0' };
    expect(packageManifestWithVersion(manifest, '0.9.0-beta.4')).toEqual({
      ...manifest,
      version: '0.9.0-beta.4',
    });
    expect(manifest.version).toBe('0.9.0');
  });

  it('selects beta prereleases for beta builds and latest for stable builds', () => {
    expect(releaseChannelForVersion('0.9.0-beta.4')).toEqual({
      displayChannel: 'beta',
      updaterChannel: 'beta',
      allowPrerelease: true,
    });
    expect(releaseChannelForVersion('0.9.0')).toEqual({
      displayChannel: 'stable',
      updaterChannel: 'latest',
      allowPrerelease: false,
    });
  });

  it('writes the matching channel to electron-builder metadata config', () => {
    const config = 'publish:\n  provider: github\n  channel: latest\n';
    expect(electronBuilderConfigForVersion(config, '0.9.0-beta.1')).toContain('  channel: beta');
    expect(electronBuilderConfigForVersion(config, '0.9.0')).toContain('  channel: latest');
  });
});
