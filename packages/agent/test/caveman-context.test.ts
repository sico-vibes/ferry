import { describe, expect, it } from 'vitest';
import { MessageSchema } from '@ferry/shared';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sampleModelInfo,
  sampleProfile,
  sampleProvider,
  sampleTaskRecord,
} from '@ferry/shared/testing';
import { MessageRepository, SessionRepository, TaskRepository, openDatabase } from '@ferry/storage';
import {
  cavemanCompress,
  cavemanOutputInstruction,
  compressCavemanMessages,
} from '@ferry/optimizer';
import { AgentLoop, toModelMessages, type AgentEvent } from '../src/loop.js';
import { SessionStore } from '../src/session.js';
import { assembleSystemPrompt } from '../src/prompt.js';

const prose =
  'Hello, could you please review the configuration in order to identify each and every issue? I would like you to actually check the settings due to the fact that the application is currently failing. Furthermore, please make sure to inspect the database as well as the authentication setup for the purpose of finding the problem.';

describe('Caveman at model context boundary', () => {
  it(
    'applies profile defaults in the loop, emits once per step, and keeps durable history',
    { timeout: 30_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'ferry-caveman-'));
      const database = await openDatabase(':memory:');
      try {
        const store = new SessionStore({
          sessions: new SessionRepository(database.client),
          messages: new MessageRepository(database.client),
          tasks: new TaskRepository(database.client),
        });
        const profile = {
          ...sampleProfile,
          allowedProviders: 'all_free' as const,
          optimizers: {
            ...sampleProfile.optimizers,
            cavemanInput: 'lite' as const,
            terse: 'lite' as const,
          },
          roles: { ...sampleProfile.roles, enabled: false },
        };
        const model = {
          ...sampleModelInfo,
          free: true,
          tier: 'T1' as const,
          priceInPerM: 0,
          priceOutPerM: 0,
        };
        const provider = { ...sampleProvider, windows: [], stepsLeftToday: 100 };
        const session = store.create({ profileId: profile.id, prompt: prose });
        store.appendMessage(
          session.id,
          'assistant',
          [
            {
              id: 'part_old_answer' as Parameters<typeof store.appendMessage>[2][number]['id'],
              type: 'text',
              text: prose,
            },
          ],
          model.ref,
        );
        store.appendMessage(
          session.id,
          'user',
          [
            {
              id: 'part_latest' as Parameters<typeof store.appendMessage>[2][number]['id'],
              type: 'text',
              text: prose,
            },
          ],
          null,
        );
        const before = store.load(session.id)?.messages;
        const events: AgentEvent[] = [];
        const loop = new AgentLoop({
          store,
          workspace: root,
          dataDir: root,
          recent: true,
          profile,
          catalog: { models: [model], providers: [], tiers: {} },
          capacity: () => ({ providers: [provider] }),
          apiKeys: {},
          permissionMode: 'full_auto',
          emit: (event) => {
            events.push(event);
          },
          generator: (request) => {
            expect(request.system).toContain(cavemanOutputInstruction('lite'));
            expect(request.messages[0]?.parts[0]).toMatchObject({
              text: cavemanCompress(prose, { intensity: 'lite' }).text,
            });
            expect(request.messages.at(-1)?.parts[0]).toMatchObject({ text: prose });
            return Promise.resolve({ text: 'Done.' });
          },
        });
        expect((await loop.run({ sessionId: session.id })).status).toBe('completed');
        const inputEvents = events.filter(
          (event) => event.type === 'optimizer.event' && event.kind === 'caveman-input',
        );
        expect(inputEvents).toHaveLength(1);
        const inputEvent = inputEvents[0];
        if (inputEvent?.type !== 'optimizer.event') throw new Error('Missing Caveman event');
        expect(typeof inputEvent.runId).toBe('string');
        expect(inputEvent.beforeTokens).toBeGreaterThan(inputEvent.afterTokens);
        expect(
          events.some(
            (event) => event.type === 'optimizer.event' && event.kind.startsWith('terse-'),
          ),
        ).toBe(false);
        expect(store.load(session.id)?.messages.slice(0, before?.length)).toEqual(before);
      } finally {
        database.close();
        await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    },
  );

  it('preserves latest user text, tool arguments, reasoning, and file contents in model messages', () => {
    const args = { query: prose };
    const transcript = [
      MessageSchema.parse({
        id: 'message_old',
        sessionId: 'session_test',
        role: 'user',
        modelRef: null,
        createdAt: '2026-10-08T00:00:00.000Z',
        parts: [{ id: 'part_old', type: 'text', text: prose }],
      }),
      MessageSchema.parse({
        id: 'message_tool',
        sessionId: 'session_test',
        role: 'assistant',
        modelRef: null,
        createdAt: '2026-10-08T00:00:00.000Z',
        parts: [
          { id: 'part_reply', type: 'text', text: prose },
          {
            id: 'part_search',
            type: 'tool_call',
            tool: 'search',
            title: 'search',
            args,
            status: 'succeeded',
            changes: [],
            durationMs: null,
            output: {
              text: prose,
              filtered: false,
              originalTokens: null,
              filteredTokens: null,
              recoveryHandle: null,
            },
          },
          {
            id: 'part_file',
            type: 'tool_call',
            tool: 'read_file',
            title: 'read',
            args: { path: 'README.md' },
            status: 'succeeded',
            changes: [],
            durationMs: null,
            output: {
              text: prose,
              filtered: false,
              originalTokens: null,
              filteredTokens: null,
              recoveryHandle: null,
            },
          },
        ],
      }),
      MessageSchema.parse({
        id: 'message_latest',
        sessionId: 'session_test',
        role: 'user',
        modelRef: null,
        createdAt: '2026-10-08T00:00:00.000Z',
        parts: [{ id: 'part_latest', type: 'text', text: prose }],
      }),
    ];
    const snapshot = structuredClone(transcript);
    const compressed = compressCavemanMessages(transcript, 'standard');
    const wire = toModelMessages(compressed.messages, undefined);
    expect(wire[0]).toEqual({
      role: 'user',
      content: cavemanCompress(prose, { intensity: 'standard' }).text,
    });
    expect(wire.at(-1)).toEqual({ role: 'user', content: prose });
    expect(wire[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'text', text: cavemanCompress(prose, { intensity: 'standard' }).text },
        { type: 'tool-call', input: args },
        { type: 'tool-call', input: { path: 'README.md' } },
      ],
    });
    expect(wire[2]).toMatchObject({
      role: 'tool',
      content: [
        { output: { value: cavemanCompress(prose, { intensity: 'standard' }).text } },
        { output: { value: prose } },
      ],
    });
    expect(transcript).toEqual(snapshot);
  });

  it.each(['off', 'lite', 'full', 'ultra'] as const)(
    'applies %s output mode only through the system prompt',
    async (terseLevel) => {
      const system = await assembleSystemPrompt({
        recent: true,
        workspace: process.cwd(),
        sessionId: 'session_test',
        task: sampleTaskRecord,
        terseLevel,
      });
      if (terseLevel === 'off') expect(system).not.toContain('Respond terse');
      else expect(system).toContain(cavemanOutputInstruction(terseLevel));
      expect(system).not.toContain('Optimizer terse level:');
    },
  );
});
