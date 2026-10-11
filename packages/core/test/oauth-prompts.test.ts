import { beforeEach, expect, it, vi } from 'vitest';
import type { LoginOptions } from '@ferry/oauth';
import type { OAuthLoginProgress } from '@ferry/shared';
import type { CoreHost, RpcHandler } from '../src/host.js';
import type { FerryServices } from '../src/services.js';
import { register } from '../src/domains/oauth.js';

const login = vi.hoisted(() => vi.fn());
vi.mock('@ferry/oauth', () => ({
  isSupportedOAuthProvider: () => true,
  listOAuthProviders: () => Promise.resolve([]),
  oauthModelCatalog: [],
  startLogin: login,
  logout: vi.fn(),
}));
beforeEach(() => {
  login.mockReset();
});

function harness() {
  let handlers: Record<string, RpcHandler> = {};
  const events: OAuthLoginProgress[] = [];
  const host = {
    registerDomain: (_name: string, value: Record<string, RpcHandler>) => {
      handlers = value;
    },
    emit: (_name: string, event: OAuthLoginProgress) => events.push(event),
    onShutdown: vi.fn(),
  } as unknown as CoreHost;
  register(host, {} as FerryServices);
  login.mockImplementation(async (_id: string, options: LoginOptions) => {
    const value = await options.onPrompt?.(
      { kind: 'manual_code', message: 'Paste redirect URL' },
      options.signal ?? new AbortController().signal,
    );
    options.onProgress?.({ type: 'success' });
    return value;
  });
  const call = (name: string, ...args: unknown[]) => {
    const handler = handlers[name];
    if (!handler) throw new Error('Missing handler');
    return handler(...args);
  };
  return { call, events };
}

it('keeps browser sign-in pending until the matching authorization prompt is answered', async () => {
  const h = harness();
  let settled = false;
  const pending = Promise.resolve(h.call('login', 'anthropic')).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  const prompt = h.events.find((event) => event.type === 'prompt');
  if (!prompt) throw new Error('Missing prompt');
  expect(() => h.call('respond', 'openai-codex', prompt.promptId, 'fixture-code')).toThrow(
    /no longer active/,
  );
  await h.call('respond', 'anthropic', prompt.promptId, 'fixture-code');
  await pending;
  expect(h.events.at(-1)?.type).toBe('success');
  expect(() => h.call('respond', 'anthropic', prompt.promptId, 'fixture-code')).toThrow(
    /no longer active/,
  );
});

it('cancels pending prompts and releases the login slot for another attempt', async () => {
  const h = harness();
  const pending = Promise.resolve(h.call('login', 'anthropic'));
  const cancelled = expect(pending).rejects.toThrow(/cancelled/);
  await expect(Promise.resolve(h.call('login', 'openai-codex'))).rejects.toThrow(/current sign-in/);
  await h.call('cancel', 'anthropic');
  await cancelled;
  const next = Promise.resolve(h.call('login', 'anthropic'));
  const nextCancelled = expect(next).rejects.toThrow(/cancelled/);
  await h.call('cancel', 'anthropic');
  await nextCancelled;
});
