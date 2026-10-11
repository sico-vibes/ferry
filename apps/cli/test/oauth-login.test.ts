import { expect, it, vi } from 'vitest';
import type { FerryClient } from '@ferry/client';
import type { OAuthLoginProgress } from '@ferry/shared';
import { runOAuthLogin } from '../src/oauth-login.js';

function setup() {
  let receive: (event: OAuthLoginProgress) => void = () => undefined;
  const respond = vi.fn().mockResolvedValue(undefined);
  const cancel = vi.fn().mockResolvedValue(undefined);
  let finish: () => void = () => undefined;
  const client = {
    on: (_: string, listener: typeof receive) => {
      receive = listener;
      return vi.fn();
    },
    oauth: {
      respond,
      cancel,
      login: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    },
  } as unknown as FerryClient;
  const write = vi.fn();
  const read = vi.fn().mockResolvedValue('fixture-secret');
  return {
    client,
    write,
    read,
    respond,
    cancel,
    finish: () => {
      finish();
    },
    emit: (event: OAuthLoginProgress) => {
      receive(event);
    },
  };
}
it('handles progress, device codes, URLs, text, secret and manual prompts without printing answers', async () => {
  const h = setup();
  const task = runOAuthLogin(h.client, 'anthropic', h);
  h.emit({ id: 'anthropic', type: 'progress', message: 'Preparing' });
  h.emit({
    id: 'anthropic',
    type: 'device_code',
    userCode: 'ABCD',
    verificationUri: 'https://example.test/device',
  });
  h.emit({ id: 'anthropic', type: 'open_url', url: 'https://example.test/login' });
  for (const kind of ['text', 'secret', 'manual_code'] as const) {
    h.emit({ id: 'anthropic', type: 'prompt', promptId: kind, message: 'Authorization', kind });
    await vi.waitFor(() => {
      expect(h.respond).toHaveBeenCalledWith('anthropic', kind, 'fixture-secret');
    });
  }
  expect(h.write.mock.calls.flat().join('\n')).not.toContain('fixture-secret');
  h.finish();
  await task;
});
it('cancels the Core login and pending prompt on interruption', async () => {
  const h = setup();
  h.read.mockImplementation(() => new Promise(() => undefined));
  const controller = new AbortController();
  const task = runOAuthLogin(h.client, 'anthropic', { ...h, signal: controller.signal });
  const rejected = expect(task).rejects.toThrow('cancelled');
  h.emit({ id: 'anthropic', type: 'prompt', promptId: 'secret', message: 'Code', kind: 'secret' });
  controller.abort();
  await rejected;
  expect(h.cancel).toHaveBeenCalledWith('anthropic');
  expect(h.respond).not.toHaveBeenCalled();
});
