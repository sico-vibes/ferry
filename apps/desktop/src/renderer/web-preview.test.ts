import { createMockFerryClient } from '@ferry/client';
import { GatewayRequestRecordSchema, MessagePartSchema, SessionDetailSchema } from '@ferry/shared';
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

  it('seeds a gateway request log that passes the shared schema', async () => {
    vi.useFakeTimers();
    const client = createMockFerryClient({ behavior: 'test' });
    await seedWebPreview(client, 'busy');
    const requests = await client.gateway.requests();
    expect(requests.length).toBeGreaterThan(0);
    for (const record of requests) expect(GatewayRequestRecordSchema.parse(record)).toEqual(record);
    const keys = await client.gateway.listKeys();
    expect(keys.some((key) => key.usage.requests > 0)).toBe(true);
  });
});
