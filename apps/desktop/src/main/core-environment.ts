const operatingSystemEnvironment = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
] as const;

const isolatedE2eEnvironment = [
  'NODE_ENV',
  'FERRY_E2E_USER_DATA_DIR',
  'FERRY_E2E_OPEN_FOLDER',
  'FERRY_E2E_WEBSOCKET',
  'FERRY_E2E_PROVIDER_ID',
  'FERRY_E2E_PROVIDER_KEY',
  'FERRY_E2E_CORE_ONLY',
  'FERRY_TEST_KEYRING_NAMESPACE',
  'FERRY_HOME',
  'FERRY_REAL_DOMAINS',
] as const;

/** Build the small environment inherited by the isolated core utility process. */
export function buildCoreEnvironment(
  source: NodeJS.ProcessEnv,
  isPackaged: boolean,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of operatingSystemEnvironment) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }

  if (!isPackaged && source.FERRY_E2E_USER_DATA_DIR) {
    for (const name of isolatedE2eEnvironment) {
      const value = source[name];
      if (value !== undefined) result[name] = value;
    }
    for (const [name, value] of Object.entries(source)) {
      if (name.startsWith('FERRY_PROVIDER_BASE_URL_') && value !== undefined) result[name] = value;
    }
  }

  return result;
}
