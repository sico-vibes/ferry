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
    group: 'subscription',
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
    group: 'subscription',
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
    group: 'subscription',
    riskText:
      'Unofficial subscription access may violate provider terms and lead to account suspension or a ban.',
  },
  {
    id: 'openrouter',
    tag: 'legit',
    name: 'OpenRouter',
    subscriptionRequired: false,
    models: ['OpenRouter catalog'],
    riskLevel: 'low',
    riskText: 'Official OpenRouter PKCE login. The API key belongs to your account.',
    group: 'official',
  },
  {
    id: 'kimi-coding',
    tag: 'subscription_oauth',
    name: 'Kimi Code',
    subscriptionRequired: true,
    models: ['Kimi Code'],
    riskLevel: 'high',
    riskText:
      'Unofficial subscription access may violate provider terms and lead to account suspension or a ban.',
    group: 'subscription',
  },
  {
    id: 'meta',
    tag: 'subscription_oauth',
    name: 'Meta Muse',
    subscriptionRequired: true,
    models: ['Muse Code'],
    riskLevel: 'high',
    riskText:
      'Unofficial subscription access may violate provider terms and lead to account suspension or a ban.',
    group: 'subscription',
  },
  {
    id: 'xai',
    tag: 'subscription_oauth',
    name: 'xAI Grok',
    subscriptionRequired: true,
    models: ['Grok Code'],
    riskLevel: 'high',
    riskText:
      'Unofficial subscription access may violate provider terms and lead to account suspension or a ban.',
    group: 'subscription',
  },
  {
    id: 'radius',
    tag: 'subscription_oauth',
    name: 'Radius',
    subscriptionRequired: false,
    models: [],
    riskLevel: 'medium',
    riskText: 'Gateway OAuth uses the configured endpoint.',
    group: 'gateway',
    advanced: true,
  },
  ...(
    [
      ['kilo', 'Kilo Gateway', 'https://kilo.ai/'],
      ['qoder', 'Qoder', 'https://qoder.com/'],
      ['cline', 'Cline', 'https://cline.bot/'],
    ] as const
  ).map(([id, name, signupUrl]) => ({
    id,
    tag: 'legit' as const,
    name,
    subscriptionRequired: false,
    models: [],
    riskLevel: 'low' as const,
    riskText: 'This login flow is not available yet.',
    group: 'unavailable' as const,
    actionAvailable: false,
    signupUrl,
  })),
  ...(
    [
      [
        'gemini-cli',
        'Gemini CLI',
        'Removed from pi-ai; Google ended the Gemini CLI free login 2026-06-18.',
      ],
      ['antigravity', 'Antigravity', 'Removed from pi-ai; Antigravity OAuth reuse led to bans.'],
    ] as const
  ).map(([id, name, reason]) => ({
    id,
    tag: 'subscription_oauth' as const,
    name,
    subscriptionRequired: true,
    models: [],
    riskLevel: 'high' as const,
    riskText: reason,
    group: 'unavailable' as const,
    actionAvailable: false,
  })),
];

export function createOAuthDomain(_store: MockStore, deps: MockDeps): FerryClient['oauth'] {
  const connected = new Set<string>();
  return {
    async list() {
      await deps.before();
      return data.map((item) => {
        const isConnected = connected.has(item.id);
        return {
          ...item,
          connected: isConnected,
          status: isConnected ? ('connected' as const) : ('not_connected' as const),
          account: isConnected ? `${item.id}-user` : null,
        };
      });
    },
    async login(id) {
      await deps.before();
      const provider = data.find((item) => item.id === id);
      if (!provider || provider.actionAvailable === false || provider.group === 'unavailable')
        throw new Error(`OAuth login is unavailable for ${id}`);
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
