import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ModelInfoSchema,
  ProviderSchema,
  PartIdSchema,
  newId,
  extractRequirements,
  type TaskRecord,
} from '@ferry/shared';
import { openDatabase, MessageRepository, SessionRepository, TaskRepository } from '@ferry/storage';
import { BUILTIN_PROFILES } from '@ferry/router';
import { AgentLoop, toModelMessages, type AgentOptions } from '../src/loop.js';
import { SessionStore } from '../src/session.js';
import { createWorkspaceTools } from '../src/tool-registry.js';
import { serializeMessagesForEstimate } from '../src/message-estimate.js';

vi.setConfig({ testTimeout: 30_000 });

async function fixture(
  run: (options: AgentOptions, sessionId: string) => Promise<void> | void,
  request = 'Build a site.\n- Safe headings\n- No overflow',
  startEmpty = false,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'ferry-requirements-'));
  const database = await openDatabase(':memory:');
  try {
    const messageRepository = new MessageRepository(database.client);
    const store = new SessionStore({
      sessions: new SessionRepository(database.client),
      messages: messageRepository,
      tasks: new TaskRepository(database.client),
    });
    const profile = BUILTIN_PROFILES[0];
    if (!profile) throw new Error('Missing built-in profile');
    const model = ModelInfoSchema.parse({
      ref: 'openai/fixture',
      providerId: 'openai',
      name: 'Fixture',
      tier: 'T2',
      contextWindow: 32000,
      maxOutput: 2048,
      toolCalling: true,
      reasoning: false,
      free: true,
      priceInPerM: 0,
      priceOutPerM: 0,
    });
    const provider = ProviderSchema.parse({
      id: 'openai',
      name: 'OpenAI',
      tag: 'legit',
      kind: 'api',
      brand: null,
      keyStatus: 'valid',
      enabled: true,
      health: 'ok',
      cooldownUntil: null,
      dataUse: null,
      termsNote: null,
      signupUrl: null,
      docsUrl: null,
      verifiedAt: null,
      modelCount: 1,
      windows: [],
      stepsLeftToday: 50,
    });
    const session = store.create({ profileId: profile.id, prompt: request });
    if (startEmpty)
      for (const message of messageRepository.list()) messageRepository.delete(message.id);
    await run(
      {
        store,
        workspace: root,
        dataDir: root,
        recent: true,
        profile: { ...profile, roles: { ...profile.roles, enabled: false } },
        catalog: { models: [model], providers: [], tiers: {} },
        capacity: () => ({ providers: [provider] }),
        apiKeys: {},
        emit: () => undefined,
        permissionMode: 'ask',
      },
      session.id,
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

describe('verification before finishing', () => {
  it('records the full first desktop request immediately and preserves it on follow-ups', async () => {
    await fixture(
      (options, sessionId) => {
        const request =
          '  Create a single self-contained file named blog.html in this folder with a responsive accessible admin section.  ';
        options.store.appendMessage(
          sessionId,
          'user',
          [{ type: 'text', id: PartIdSchema.parse(newId('part')), text: request }],
          null,
        );
        expect(options.store.load(sessionId)?.taskRecord.goal).toBe(request.trim());
        options.store.appendMessage(
          sessionId,
          'user',
          [{ type: 'text', id: PartIdSchema.parse(newId('part')), text: 'Make it blue.' }],
          null,
        );
        expect(options.store.load(sessionId)?.taskRecord.goal).toBe(request.trim());
      },
      'New Chat',
      true,
    );
  });
  it('injects one verification turn, round-trips update_plan and reports failed items', async () => {
    await fixture(async (options, sessionId) => {
      let calls = 0;
      const notes: string[] = [];
      const approval = vi.fn(() => Promise.resolve('denied' as const));
      const loop = new AgentLoop({
        ...options,
        requestApproval: approval,
        generator: ({ system }) => {
          calls++;
          if (system.includes('Verification round')) notes.push(system);
          if (calls === 2)
            return Promise.resolve({
              toolCalls: [
                {
                  name: 'update_plan',
                  input: {
                    items: [
                      {
                        id: 'requirement_1',
                        text: 'Safe headings',
                        status: 'done',
                        evidence: 'read_file: escaped headings',
                      },
                      {
                        id: 'requirement_2',
                        text: 'No overflow',
                        status: 'failed',
                        evidence: 'check_page: 800px at 375px',
                      },
                    ],
                  },
                },
              ],
              finishReason: 'stop',
            });
          return Promise.resolve({ text: 'Short summary.', finishReason: 'stop' });
        },
      });
      const result = await loop.run({ sessionId });
      expect(calls).toBe(3);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('requirement_2: No overflow');
      expect(approval).not.toHaveBeenCalled();
      expect(result.report?.outcome).toBe('completed_with_warnings');
      expect(result.report?.warnings).toEqual([
        'Requirement failed: No overflow — check_page: 800px at 375px',
      ]);
      expect(result.report?.checklist).toEqual(result.taskRecord.plan);
      expect(result.taskRecord.goal).toBe('Build a site.\n- Safe headings\n- No overflow');
      expect(options.store.load(sessionId)?.session.runReport).toEqual(result.report);
    });
  });
  it('ends after exactly two unanswered verification rounds', async () => {
    await fixture(async (options, sessionId) => {
      const systems: string[] = [];
      const result = await new AgentLoop({
        ...options,
        generator: ({ system }) => {
          systems.push(system);
          return Promise.resolve({ text: 'Done.' });
        },
      }).run({ sessionId });
      expect(systems).toHaveLength(3);
      expect(systems[1]).toContain('Verification round 1/2');
      expect(systems[2]).toContain('Verification round 2/2');
      expect(
        result.taskRecord.plan.every(
          (item) => item.status === 'skipped' && item.evidence === 'not verified',
        ),
      ).toBe(true);
    });
  });
  it('respects step and token limits without starting verification', async () => {
    for (const limits of [{ maxSteps: 1 }, { tokenBudget: 1 }]) {
      await fixture(async (options, sessionId) => {
        const generator = vi.fn(() =>
          Promise.resolve({ text: 'Done.', inputTokens: 1, outputTokens: 1 }),
        );
        const result = await new AgentLoop({ ...options, ...limits, generator }).run({ sessionId });
        expect(generator).toHaveBeenCalledTimes(1);
        expect(result.status).toBe('limit');
        expect(result.taskRecord.plan.every((item) => item.status === 'skipped')).toBe(true);
      });
    }
  });
  it('honors cancellation at the verification boundary', async () => {
    await fixture(async (options, sessionId) => {
      const controller = new AbortController();
      let calls = 0;
      const result = await new AgentLoop({
        ...options,
        generator: () => {
          calls++;
          if (calls === 2) controller.abort();
          return Promise.resolve({ text: 'Done.' });
        },
      }).run({ sessionId, signal: controller.signal });
      expect(calls).toBe(2);
      expect(result.status).toBe('cancelled');
    });
  });
  it('does not add verification turns for a plain question', async () => {
    await fixture(async (options, sessionId) => {
      const generator = vi.fn(() =>
        Promise.resolve({ text: 'A closure captures lexical bindings.' }),
      );
      const result = await new AgentLoop({ ...options, generator }).run({ sessionId });
      expect(generator).toHaveBeenCalledTimes(1);
      expect(result.taskRecord.plan).toEqual([]);
    }, 'Explain closures.');
  });
  it('repairs a truncated desktop goal from the first request', async () => {
    const request =
      'Create a single self-contained file named blog.html in this folder: a beautiful modern blog website.';
    await fixture(async (options, sessionId) => {
      const task = options.store.load(sessionId)?.taskRecord;
      if (!task) throw new Error('Missing task');
      options.store.saveTask({ ...task, goal: request.slice(0, 60) });
      const result = await new AgentLoop({
        ...options,
        generator: () => Promise.resolve({ text: 'Done.' }),
      }).run({ sessionId });
      expect(result.taskRecord.goal).toBe(request);
    }, request);
  });
});

it('preserves deterministic items on tool refinements and auto-allows check_page', async () => {
  await fixture(async (options, sessionId) => {
    const loaded = options.store.load(sessionId);
    if (!loaded) throw new Error('Missing session');
    let task: TaskRecord = {
      sessionId: loaded.session.id,
      goal: 'Site',
      plan: extractRequirements('- No overflow'),
      decisions: [],
      touchedFiles: [],
      nextStep: null,
    };
    const approvals = vi.fn(() => Promise.resolve('denied' as const));
    const registry = createWorkspaceTools({
      workspace: options.workspace,
      dataDir: options.dataDir,
      sessionId,
      permissionMode: 'ask',
      onPart: () => undefined,
      requestApproval: approvals,
      updateTask: (updated) => {
        task = updated;
      },
    });
    const update = registry.tools.find((tool) => tool.name === 'update_plan');
    const check = registry.tools.find((tool) => tool.name === 'check_page');
    if (!update || !check) throw new Error('Missing tools');
    await update.execute({ items: [] }, { task, signal: new AbortController().signal });
    expect(task.plan).toHaveLength(1);
    // A missing local file fails validation without seeking approval or starting a browser.
    await expect(
      check.execute({ target: 'missing.html' }, { task, signal: new AbortController().signal }),
    ).rejects.toThrow();
    expect(approvals).not.toHaveBeenCalled();
  });
});

it('attaches screenshot image parts only to vision-capable model transcripts', () => {
  const model = ModelInfoSchema.parse({
    ref: 'openai/fixture',
    providerId: 'openai',
    name: 'Fixture',
    tier: 'T2',
    contextWindow: 8192,
    maxOutput: 2048,
    toolCalling: true,
    reasoning: false,
    free: true,
    priceInPerM: 0,
    priceOutPerM: 0,
    capability: {
      vision: true,
      toolCall: true,
      parallelToolCalls: null,
      reasoning: false,
      context: 8192,
      maxOutput: 2048,
      editFormat: 'search_replace',
      toolProtocol: 'native',
      cachePrompt: null,
      temperature: null,
    },
  });
  const message = {
    id: 'message_fixture' as never,
    sessionId: 'session_fixture' as never,
    role: 'assistant' as const,
    createdAt: new Date().toISOString(),
    modelRef: model.ref,
    parts: [
      {
        type: 'tool_call' as const,
        id: PartIdSchema.parse(newId('part')),
        tool: 'check_page',
        title: 'Check page',
        args: { target: 'blog.html' },
        status: 'succeeded' as const,
        changes: [],
        durationMs: 1,
        output: {
          text: 'Screenshot: data/screen.png',
          filtered: false,
          originalTokens: null,
          filteredTokens: null,
          recoveryHandle: null,
          images: [
            { path: 'data/screen.png', data: 'fixture-base64', mimeType: 'image/png' as const },
          ],
        },
      },
    ],
  };
  expect(JSON.stringify(toModelMessages([message], model))).toContain('fixture-base64');
  expect(
    JSON.stringify(
      toModelMessages([message], { ...model, capability: undefined, inputModalities: ['image'] }),
    ),
  ).toContain('fixture-base64');
  expect(
    JSON.stringify(toModelMessages([message], { ...model, capability: undefined })),
  ).not.toContain('fixture-base64');
});

it('budgets screenshot content without treating base64 bytes as text tokens', () => {
  const messages = [
    {
      role: 'tool' as const,
      content: [
        {
          type: 'tool-result' as const,
          toolCallId: 'shot',
          toolName: 'check_page',
          output: {
            type: 'content' as const,
            value: [
              { type: 'text' as const, text: 'Page title: blog' },
              {
                type: 'file' as const,
                mediaType: 'image/png',
                data: { type: 'data' as const, data: 'a'.repeat(500_000) },
              },
            ],
          },
        },
      ],
    },
  ];
  const estimated = serializeMessagesForEstimate(messages);
  expect(estimated).toContain('Page title: blog');
  expect(estimated.length).toBeLessThan(10_000);
  const text = [{ role: 'user' as const, content: 'Explain closures.' }];
  expect(serializeMessagesForEstimate(text)).toBe(JSON.stringify(text));
});
