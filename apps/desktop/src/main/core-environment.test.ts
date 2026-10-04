import { describe, expect, it } from 'vitest';
import { buildCoreEnvironment } from './core-environment.js';

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
});
