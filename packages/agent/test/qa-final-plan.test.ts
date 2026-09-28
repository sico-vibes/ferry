/* eslint
  @typescript-eslint/no-non-null-assertion: off,
  @typescript-eslint/require-await: off,
  @typescript-eslint/no-empty-function: off,
  @typescript-eslint/unbound-method: off
*/
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_SETTINGS,
  ModelInfoSchema,
  ProviderIdSchema,
  ProviderSchema,
} from '@ferry/shared';
import type { ModelInfo, RoutingSettings } from '@ferry/shared';
import { openDatabase, MessageRepository, SessionRepository, TaskRepository } from '@ferry/storage';
import { BUILTIN_PROFILES } from '@ferry/router';
import { AgentLoop, type AgentOptions } from '../src/loop.js';
import { SessionStore } from '../src/session.js';
import { EditPlanSchema, formatEditPlan, parseEditPlan } from '../src/role-plan.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 8 })),
  );
});

const nowMs = Date.parse('2026-09-27T12:00:00.000Z');

function model(ref: string): ModelInfo {
  const providerId = ref.slice(0, ref.indexOf('/'));
  return ModelInfoSchema.parse({
    ref,
    providerId,
    name: ref,
    tier: 'T2',
    contextWindow: 8_192,
    maxOutput: 2_048,
    toolCalling: true,
    reasoning: false,
    free: true,
    priceInPerM: 0,
    priceOutPerM: 0,
  });
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'ferry-qa-final-plan-'));
  tempDirs.push(root);
  const database = await openDatabase(':memory:');
  const store = new SessionStore({
    sessions: new SessionRepository(database.client),
    messages: new MessageRepository(database.client),
    tasks: new TaskRepository(database.client),
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
    modelCount: 2,
    windows: [],
    stepsLeftToday: 50,
  });
  const catalog = {
    models: [model('openai/alpha'), model('openai/beta')],
    providers: [],
    tiers: {},
    warnings: [],
  };
  const session = store.create({
    workspaceId: 'workspace_test' as never,
    profileId: BUILTIN_PROFILES[0]!.id,
    prompt: 'Update the greeting in README.md',
  });
  await writeFile(path.join(root, 'README.md'), '# Ferry\n', 'utf8');
  return { root, database, store, session, provider, catalog };
}

type State = Awaited<ReturnType<typeof setup>>;

function makeLoop(
  state: State,
  routing: RoutingSettings,
  overrides: Partial<AgentOptions> = {},
): AgentLoop {
  const autoFree = {
    ...BUILTIN_PROFILES.find((profile) => profile.name === 'Auto-Free')!,
    roles: {
      ...BUILTIN_PROFILES.find((profile) => profile.name === 'Auto-Free')!.roles,
      enabled: false,
    },
  };
  return new AgentLoop({
    store: state.store,
    workspace: state.root,
    dataDir: state.root,
    profile: autoFree,
    catalog: state.catalog,
    capacity: () => ({ providers: [state.provider] }),
    apiKeys: {},
    emit: () => {},
    routingNow: () => nowMs,
    routingSettings: () => routing,
    ...overrides,
    permissionMode: overrides.permissionMode ?? 'full_auto',
  });
}

function routedSettings(overrides: Partial<RoutingSettings> = {}): RoutingSettings {
  return { ...DEFAULT_ROUTING_SETTINGS, ...overrides };
}

function roleProfile() {
  const autoFree = {
    ...BUILTIN_PROFILES.find((profile) => profile.name === 'Auto-Free')!,
    roles: {
      ...BUILTIN_PROFILES.find((profile) => profile.name === 'Auto-Free')!.roles,
      enabled: false,
    },
  };
  return {
    ...autoFree,
    name: 'Role Test',
    allowedProviders: [ProviderIdSchema.parse('openai'), ProviderIdSchema.parse('groq')],
    fallbackChain: [],
    roles: {
      enabled: true,
      plannerModelRef: 'openai/planner' as ModelInfo['ref'],
      editorModelRef: 'groq/editor' as ModelInfo['ref'],
      editorFailureThreshold: 2,
    },
  };
}

describe('QA final: edit-plan parsing variants', () => {
  it('parses bare and fenced JSON plans and round-trips formatting', () => {
    const plan = {
      files: [{ path: 'src/a.ts', intent: 'Add export' }],
      changes: [{ path: 'src/a.ts', instructions: 'Add export const x = 1' }],
    };
    expect(parseEditPlan(JSON.stringify(plan))).toEqual(plan);
    expect(parseEditPlan('```json\n' + JSON.stringify(plan) + '\n```')).toEqual(plan);
    expect(parseEditPlan(formatEditPlan(plan))).toEqual(plan);
  });

  it('rejects malformed, empty-file, and empty-change plans without throwing', () => {
    expect(parseEditPlan('')).toBeNull();
    expect(parseEditPlan('not json at all')).toBeNull();
    expect(parseEditPlan('{"files":[],"changes":[{"path":"a","instructions":"b"}]}')).toBeNull();
    expect(parseEditPlan('{"files":[{"path":"a","intent":"b"}],"changes":[]}')).toBeNull();
    expect(parseEditPlan('[{"path":"a"}]')).toBeNull();
    expect(parseEditPlan('{"files":[{"path":"","intent":"b"}],"changes":[]}')).toBeNull();
  });

  it('accepts a very large plan without truncating instructions or throwing', () => {
    const instructions = 'x'.repeat(500_000);
    const parsed = parseEditPlan(
      JSON.stringify({
        files: [{ path: 'big.txt', intent: 'rewrite' }],
        changes: [{ path: 'big.txt', instructions }],
      }),
    );
    expect(parsed?.changes[0]?.instructions.length).toBe(instructions.length);
    expect(EditPlanSchema.safeParse(parsed).success).toBe(true);
  });
});

describe('QA final: planner output confinement', () => {
  it.fails(
    'never records planner-provided paths that escape the workspace',
    async () => {
      const state = await setup();
      try {
        const planner = model('openai/planner');
        const editor = model('groq/editor');
        const groq = ProviderSchema.parse({ ...state.provider, id: 'groq', name: 'Groq' });
        const calls: string[] = [];
        const loop = makeLoop(state, routedSettings({ stickySessions: false }), {
          profile: roleProfile(),
          catalog: { ...state.catalog, models: [planner, editor] },
          capacity: () => ({ providers: [state.provider, groq] }),
          generator: async ({ model: selected }) => {
            calls.push(selected.ref);
            return calls.length === 1
              ? {
                  text: JSON.stringify({
                    files: [
                      { path: '../escape.txt', intent: 'Write outside the workspace' },
                      { path: 'C:\\Windows\\system32\\drivers\\etc\\hosts', intent: 'Absolute' },
                    ],
                    changes: [{ path: '../escape.txt', instructions: 'overwrite' }],
                  }),
                }
              : { text: 'Applied.', finishReason: 'stop' };
          },
        });
        const result = await loop.run({ sessionId: state.session.id });
        // BUG: AgentLoop trusts planner JSON paths with no workspace check, so
        // taskRecord.touchedFiles records '../escape.txt' and an absolute path,
        // and the editor prompt is built from the unvalidated plan.
        const escaped = result.taskRecord.touchedFiles.filter(
          (file) =>
            path.isAbsolute(file.path) ||
            file.path.split(/[\\/]/).includes('..') ||
            /^[A-Za-z]:/.test(file.path),
        );
        expect(escaped).toEqual([]);
      } finally {
        state.database.close();
      }
    },
    30_000,
  );

  it('disables the roles split and continues in single-model mode after malformed planner JSON', async () => {
    const state = await setup();
    try {
      const planner = model('openai/planner');
      const editor = model('groq/editor');
      const groq = ProviderSchema.parse({ ...state.provider, id: 'groq', name: 'Groq' });
      const calls: string[] = [];
      const loop = makeLoop(state, routedSettings({ stickySessions: false }), {
        profile: roleProfile(),
        catalog: { ...state.catalog, models: [planner, editor] },
        capacity: () => ({ providers: [state.provider, groq] }),
        generator: async ({ model: selected }) => {
          calls.push(selected.ref);
          return calls.length === 1
            ? { text: 'I will edit the file shortly.' }
            : { text: 'Done in single-model mode.', finishReason: 'stop' };
        },
      });
      const result = await loop.run({ sessionId: state.session.id });
      expect(result.status).toBe('completed');
      const messages = state.store.load(state.session.id)?.messages ?? [];
      expect(messages.some((message) => message.parts.some((part) => part.type === 'error'))).toBe(
        false,
      );
      expect(result.taskRecord.nextStep).toMatch(/single-model mode/i);
    } finally {
      state.database.close();
    }
  }, 30_000);
});
