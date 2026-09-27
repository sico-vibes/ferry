import { afterEach, describe, expect, it } from 'vitest';
import { FakeOpenAIServer } from '../packages/testkit/src/fake-servers.js';
import {
  accountRun,
  budgetGuard,
  parseDotEnv,
  parseEvalArgs,
  redactText,
  runHarness,
} from './eval-live-lib.mjs';

const servers: FakeOpenAIServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe('live eval harness helpers', () => {
  it('parses CLI options and dotenv values without emitting credentials', () => {
    expect(
      parseEvalArgs(['--profile', 'best-available', '--only', 'one,two', '--repeat', '2', '--yes']),
    ).toMatchObject({
      profile: 'best-available',
      only: ['one', 'two'],
      repeat: 2,
      yes: true,
    });
    const env = parseDotEnv("GROQ_API_KEY='secret-key'\nexport GEMINI_API_KEY=another-secret");
    expect(env).toEqual({ GROQ_API_KEY: 'secret-key', GEMINI_API_KEY: 'another-secret' });
    expect(redactText(JSON.stringify(env), Object.values(env))).not.toContain('secret-key');
    expect(redactText('Authorization: Bearer abcdefghijklmnop', [])).toContain('[REDACTED]');
  });

  it('blocks paid and credits providers unless explicitly allowed', () => {
    const providers = [
      { id: 'groq', tag: 'legit' },
      { id: 'openrouter', tag: 'credits' },
    ];
    expect(budgetGuard(providers)).toEqual({ allowed: false, paid: ['openrouter'] });
    expect(budgetGuard(providers, { allowPaid: true }).allowed).toBe(true);
  });

  it('runs scenarios through a local fake provider and accounts pass, fail, usage, and errors', async () => {
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
      id: 'chatcmpl_live_eval',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fake-free-model',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
    const server = await FakeOpenAIServer.scriptedTurns([
      { chunks: [chunk({ role: 'assistant' }), chunk({ content: 'ok' }), chunk({}, 'stop')] },
      { chunks: [chunk({ role: 'assistant' }), chunk({ content: 'not ok' }), chunk({}, 'stop')] },
    ]).start();
    servers.push(server);
    const report = await runHarness({
      scenarios: [{ id: 'pass' }, { id: 'fail' }],
      runScenario: async (scenario) => {
        const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer fake-key' },
          body: JSON.stringify({
            model: 'fake-free-model',
            messages: [{ role: 'user', content: scenario.id }],
          }),
        });
        expect(response.ok).toBe(true);
        return {
          passed: scenario.id === 'pass',
          steps: 2,
          models: ['fake/fake-free-model'],
          tokensIn: 17,
          tokensOut: 9,
          providerErrors: scenario.id === 'fail' ? { rate_limit: 1 } : {},
        };
      },
    });
    expect(server.requests).toHaveLength(2);
    expect(report).toMatchObject({ passed: 1, total: 2 });
    expect(report.results.map(({ passed }) => passed)).toEqual([true, false]);
    expect(report.results[1]).toMatchObject({
      steps: 2,
      tokensIn: 17,
      tokensOut: 9,
      providerErrors: { rate_limit: 1 },
    });
  }, 30_000);

  it('accounts engine request rows by session id', () => {
    expect(
      accountRun({
        result: { sessionId: 's1', steps: 3 },
        measurements: [
          { sessionId: 's1', model: 'groq/model', input_tokens: 10, output_tokens: 5 },
          {
            sessionId: 's1',
            model: 'gemini/model',
            input_tokens: 7,
            output_tokens: 4,
            error_kind: 'rate_limit',
          },
          { sessionId: 's2', model: 'other/model', input_tokens: 100, output_tokens: 100 },
        ],
      }),
    ).toEqual({
      steps: 3,
      models: ['groq/model', 'gemini/model'],
      tokensIn: 17,
      tokensOut: 9,
      providerErrors: { rate_limit: 1 },
    });
  });
});
