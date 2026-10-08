const operatingSystemEnvironment = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'FERRY_DATA_DIR',
  'FERRY_KEYRING_SERVICE',
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

  if (isPackaged && source.FERRY_E2E_PACKAGED === '1') {
    for (const [name, value] of Object.entries(source)) {
      if (
        name.startsWith('FERRY_PROVIDER_BASE_URL_') &&
        value !== undefined &&
        isLoopbackUrl(value)
      )
        result[name] = value;
    }
  }

  // A packaged build under any test harness must never write to the user's real "Ferry" keyring:
  // the core ignores test keyring namespaces in packaged builds, so tests once overwrote the
  // user's real provider keys. Force a separate Credential Manager service in those modes.
  if (isPackaged && isTestLaunch(source)) {
    const requested = source.FERRY_KEYRING_SERVICE?.trim();
    result.FERRY_KEYRING_SERVICE =
      requested && requested.toLowerCase() !== 'ferry' ? requested : TEST_KEYRING_SERVICE;
  }

  return result;
}

export const TEST_KEYRING_SERVICE = 'Ferry-Test';

function isTestLaunch(source: NodeJS.ProcessEnv): boolean {
  return (
    source.FERRY_E2E_PACKAGED === '1' ||
    Boolean(source.FERRY_E2E_USER_DATA_DIR) ||
    source.FERRY_INSTALL_SMOKE === 'true' ||
    Boolean(source.FERRY_TEST_KEYRING_NAMESPACE)
  );
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  } catch {
    return false;
  }
}
