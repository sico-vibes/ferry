import type { FerryClient } from '@ferry/client';
import type { OAuthLoginProgress } from '@ferry/shared';

type Prompt = Extract<OAuthLoginProgress, { type: 'prompt' }>;
export interface OAuthLoginIO {
  write(message: string): void;
  read(prompt: Prompt, signal: AbortSignal): Promise<string>;
  event?(event: OAuthLoginProgress): void;
  signal?: AbortSignal;
}

export async function runOAuthLogin(
  client: FerryClient,
  id: string,
  io: OAuthLoginIO,
): Promise<void> {
  const controller = new AbortController();
  let fail: (reason: unknown) => void = () => undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  const cancel = () => {
    controller.abort();
    void client.oauth.cancel(id).catch(fail);
    fail(new Error('Sign-in cancelled'));
  };
  const off = client.on('oauth.progress', (event) => {
    if (event.id !== id) return;
    io.event?.(event);
    switch (event.type) {
      case 'progress':
        io.write(event.message);
        break;
      case 'device_code':
        io.write(`Enter ${event.userCode} at ${event.verificationUri}`);
        break;
      case 'open_url':
        io.write(`Open ${event.url}${event.instructions ? `\n${event.instructions}` : ''}`);
        break;
      case 'prompt':
        void io
          .read(event, controller.signal)
          .then((value) => {
            if (!controller.signal.aborted) return client.oauth.respond(id, event.promptId, value);
            return undefined;
          })
          .catch((error: unknown) => {
            controller.abort();
            void client.oauth.cancel(id).catch(() => undefined);
            fail(error);
          });
        break;
      case 'error':
        fail(new Error(event.message));
        break;
      case 'success':
        break;
    }
  });
  io.signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (io.signal?.aborted) {
      cancel();
      await failure;
    }
    await Promise.race([client.oauth.login(id), failure]);
  } finally {
    controller.abort();
    off();
    io.signal?.removeEventListener('abort', cancel);
  }
}
