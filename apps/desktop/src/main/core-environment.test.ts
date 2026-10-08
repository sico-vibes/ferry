import { describe, expect, it } from 'vitest';
import { buildCoreEnvironment, TEST_KEYRING_SERVICE } from './core-environment.js';

describe('desktop core environment', () => {
  it('passes the configured Ferry keyring service through to the shared core', () => {
    expect(buildCoreEnvironment({ FERRY_KEYRING_SERVICE: 'Ferry-Shared' }, true)).toEqual({
      FERRY_KEYRING_SERVICE: 'Ferry-Shared',
    });
  });

  it('passes the explicit data directory override to packaged core launch', () => {
    expect(buildCoreEnvironment({ FERRY_DATA_DIR: 'D:\\FerryData' }, true)).toEqual({
      FERRY_DATA_DIR: 'D:\\FerryData',
    });
  });

  it('passes Windows identity values used to protect the local endpoint descriptor', () => {
    expect(
      buildCoreEnvironment(
        { USERNAME: 'ferry-user', USERDOMAIN: 'FERRY-PC', COMPUTERNAME: 'FERRY-PC' },
        true,
      ),
    ).toEqual({ USERNAME: 'ferry-user', USERDOMAIN: 'FERRY-PC', COMPUTERNAME: 'FERRY-PC' });
  });

  it('never lets a packaged test launch use the real Ferry keyring', () => {
    for (const testFlag of [
      { FERRY_E2E_PACKAGED: '1' },
      { FERRY_E2E_USER_DATA_DIR: 'C:\\tmp\\e2e' },
      { FERRY_INSTALL_SMOKE: 'true' },
      { FERRY_TEST_KEYRING_NAMESPACE: 'ns' },
    ]) {
      expect(buildCoreEnvironment(testFlag, true).FERRY_KEYRING_SERVICE).toBe(TEST_KEYRING_SERVICE);
      // Asking for the real service under a test harness is overridden too.
      expect(
        buildCoreEnvironment({ ...testFlag, FERRY_KEYRING_SERVICE: 'Ferry' }, true)
          .FERRY_KEYRING_SERVICE,
      ).toBe(TEST_KEYRING_SERVICE);
      expect(
        buildCoreEnvironment({ ...testFlag, FERRY_KEYRING_SERVICE: 'Ferry-E2E-42' }, true)
          .FERRY_KEYRING_SERVICE,
      ).toBe('Ferry-E2E-42');
    }
    // A normal packaged launch keeps the real keyring.
    expect(buildCoreEnvironment({}, true).FERRY_KEYRING_SERVICE).toBeUndefined();
  });
});
