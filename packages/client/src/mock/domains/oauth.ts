import type { OAuthProvider } from '@ferry/shared';
import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

const data: Omit<OAuthProvider, 'connected'>[] = [
  {
    id: 'anthropic',
    tag: 'subscription_oauth',
    name: 'Anthropic Claude Pro/Max',
    subscriptionRequired: true,
    models: ['Claude Opus', 'Claude Sonnet'],
    riskLevel: 'high',
    riskText:
      'Unofficial subscription access may violate provider terms and lead to account suspension or a ban.',
  },
  {
    id: 'openai-codex',
    tag: 'subscription_oauth',
    name: 'OpenAI ChatGPT',
    subscriptionRequired: true,
    models: ['Codex'],
    riskLevel: 'high',
    riskText:
      'Unofficial subscription access may violate provider terms and lead to account suspension or a ban.',
  },
  {
    id: 'github-copilot',
    tag: 'subscription_oauth',
    name: 'GitHub Copilot',
    subscriptionRequired: true,
    models: ['Copilot Chat'],
    riskLevel: 'high',
    riskText:
      'Unofficial subscription access may violate provider terms and lead to account suspension or a ban.',
  },
];

export function createOAuthDomain(_store: MockStore, deps: MockDeps): FerryClient['oauth'] {
  const connected = new Set<string>();
  return {
    async list() {
      await deps.before();
      return data.map((item) => ({ ...item, connected: connected.has(item.id) }));
    },
    async login(id) {
      await deps.before();
      deps.emit('oauth.progress', { type: 'success', id });
      connected.add(id);
    },
    async logout(id) {
      await deps.before();
      connected.delete(id);
    },
    async status(id) {
      await deps.before();
      return connected.has(id);
    },
  };
}
