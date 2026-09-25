import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

export function createSystemDomain(_store: MockStore, deps: MockDeps): FerryClient['system'] {
  return {
    async info() {
      await deps.before();
      return {
        version: '0.1.0-mock',
        mock: true,
        platform: navigator.userAgent.includes('Windows') ? 'win32' : 'web',
        dataDir: null,
        realDomains: [],
      };
    },
  };
}
