import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createFixtureRepo,
  FakeClock,
  FakeOpenAIServer,
  FakeProviderServer,
  recordedCliEvents,
} from '../src/index.js';

const servers: FakeProviderServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});
async function start<T extends FakeProviderServer>(server: T): Promise<T> {
  servers.push(server);
  await server.start();
  return server;
}

describe('QA testkit: fake provider server', () => {
  it('cycles scripted responses and 404s unmatched routes', async () => {
    const server = new FakeOpenAIServer({
      responses: [
        { status: 200, body: { n: 1 } },
        { status: 500, body: { n: 2 } },
      ],
    });
    await start(server);
    const first = await fetch(`${server.baseUrl}/v1/chat/completions`, { method: 'POST' });
    expect(((await first.json()) as { n: number }).n).toBe(1);
    const second = await fetch(`${server.baseUrl}/v1/chat/completions`, { method: 'POST' });
    expect(second.status).toBe(500);
    const wrong = await fetch(`${server.baseUrl}/nope`);
    expect(wrong.status).toBe(404);
    expect(server.requests).toHaveLength(3);
  });

  it.fails('emits malformed tool-call arguments when asked', async () => {
    // BUG: FakeOpenAIServer.responseFor() builds the broken arguments string but
    // then omits tool_calls entirely when malformed, so malformedToolCall can
    // never exercise a client's bad-JSON handling.
    const server = new FakeOpenAIServer({ responses: [{ malformedToolCall: true }] });
    await start(server);
    const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x' }),
    });
    const data = (await response.json()) as {
      choices: { message: { tool_calls?: { function: { arguments: string } }[] } }[];
    };
    expect(data.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe('{broken');
  });
});

describe('QA testkit: fixture repos and clocks', () => {
  it('materializes every template and cleans up', async () => {
    for (const template of ['typescript', 'python', 'crlf', 'monorepo'] as const) {
      const repo = await createFixtureRepo(template);
      expect(existsSync(repo.path)).toBe(true);
      try {
        if (template === 'crlf') {
          expect(await readFile(join(repo.path, 'README.md'), 'utf8')).toContain('\r\n');
        }
        if (template === 'monorepo') {
          expect(existsSync(join(repo.path, 'packages', 'a', 'package.json'))).toBe(true);
        }
      } finally {
        await repo.cleanup();
      }
      expect(existsSync(repo.path)).toBe(false);
    }
  });

  it('rejects moving the fake clock backwards and never moves on zero', () => {
    const clock = new FakeClock(100);
    expect(clock.now()).toBe(100);
    clock.advance(0);
    expect(clock.now()).toBe(100);
    expect(() => {
      clock.advance(-1);
    }).toThrow(RangeError);
    expect(clock.date().getTime()).toBe(100);
  });

  it('provides a recorded event stream per CLI', () => {
    for (const name of ['codex', 'opencode', 'claude'] as const) {
      const events = recordedCliEvents(name, 'done');
      expect(Array.isArray(events)).toBe(true);
      expect(JSON.stringify(events)).toContain('done');
    }
  });
});
