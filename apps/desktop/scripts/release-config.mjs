export const RELEASE_BASE_VERSION = '0.9.0';

export function betaVersionForRunNumber(runNumber) {
  if (!Number.isSafeInteger(runNumber) || runNumber < 1)
    throw new RangeError('The GitHub run number must be a positive safe integer.');
  return `${RELEASE_BASE_VERSION}-beta.${String(runNumber)}`;
}

export function packageManifestWithVersion(manifest, version) {
  if (!/^0\.9\.0(?:-beta\.\d+)?$/.test(version))
    throw new Error(`Unsupported Ferry release version: ${version}`);
  return { ...manifest, version };
}

export function releaseChannelForVersion(version) {
  const beta = /^0\.9\.0-beta\.\d+$/.test(version);
  return {
    displayChannel: beta ? 'beta' : 'stable',
    updaterChannel: beta ? 'beta' : 'latest',
    allowPrerelease: beta,
  };
}

export function electronBuilderConfigForVersion(config, version) {
  const { updaterChannel } = releaseChannelForVersion(version);
  const channelLine = /^  channel: (?:latest|beta)$/m;
  if (!channelLine.test(config))
    throw new Error('electron-builder.yml publish channel is missing.');
  return config.replace(channelLine, `  channel: ${updaterChannel}`);
}
