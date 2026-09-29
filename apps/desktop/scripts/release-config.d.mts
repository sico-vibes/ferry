export interface ReleaseChannelConfig {
  displayChannel: 'beta' | 'stable';
  updaterChannel: 'beta' | 'latest';
  allowPrerelease: boolean;
}

export const RELEASE_BASE_VERSION: '0.9.0';
export function betaVersionForRunNumber(runNumber: number): string;
export function packageManifestWithVersion<T extends { version: string }>(
  manifest: T,
  version: string,
): T;
export function releaseChannelForVersion(version: string): ReleaseChannelConfig;
export function electronBuilderConfigForVersion(config: string, version: string): string;
