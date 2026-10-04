import { createMockFerryClient } from '@ferry/client';
import { MessagePartSchema, SessionDetailSchema } from '@ferry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedWebPreview } from './web-preview';

describe('web preview fixtures', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    localStorage.removeItem('ferry.simulateOffline');
  });

  it('seeds sessions and message parts that pass the shared schemas', async () => {
    vi.useFakeTimers();
    const client = createMockFerryClient({ behavior: 'test' });
    await seedWebPreview(client, 'busy');

    for (const session of client.__store().sessions) {
      const detail = SessionDetailSchema.parse(await client.sessions.get(session.id));
      for (const message of detail.messages)
        for (const part of message.parts) expect(MessagePartSchema.parse(part)).toEqual(part);
    }
  });
});
