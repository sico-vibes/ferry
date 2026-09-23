import type { Provider } from '@ferry/shared';
import type { MockProvider } from '../types.js';

export function createProviders(now: Date): MockProvider[] {
  const dailyUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
  const dailyPt = (() => {
    const dateParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(now);
    const get = (type: string) =>
      Number(dateParts.find((part) => part.type === type)?.value ?? '0');
    const tomorrow = new Date(Date.UTC(get('year'), get('month') - 1, get('day') + 1));
    const expectedParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(tomorrow);
    const expectedValue = (type: string) =>
      expectedParts.find((part) => part.type === type)?.value ?? '';
    const expected = `${expectedValue('year')}-${expectedValue('month')}-${expectedValue('day')}`;
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const limit = now.getTime() + 36 * 60 * 60 * 1000;
    for (
      let instant = Math.ceil(now.getTime() / 60_000) * 60_000;
      instant <= limit;
      instant += 60_000
    ) {
      const formatted = formatter.formatToParts(new Date(instant));
      const value = (type: string) => formatted.find((part) => part.type === type)?.value ?? '';
      if (
        `${value('year')}-${value('month')}-${value('day')}` === expected &&
        value('hour') === '00' &&
        value('minute') === '00'
      )
        return new Date(instant).toISOString();
    }
    throw new Error('Unable to determine the next Pacific midnight');
  })();
  const specs = [
    ['gemini', 'Gemini API', 'legit', 'googlegemini', 250, 212, 10, 3, 38],
    ['openrouter', 'OpenRouter (free models)', 'legit', 'openrouter', 1000, 388, 20, 4, 312],
    ['nvidia', 'NVIDIA NIM', 'legit', 'nvidia', null, null, 40, 11, null],
    ['cerebras', 'Cerebras', 'legit', null, null, null, 5, 1, 27],
    ['groq', 'Groq', 'legit', null, 1000, 140, 8000, 2100, 43],
    ['mistral', 'Mistral (Experiment)', 'legit', 'mistralai', null, null, 1, 0, null],
    ['opencode-zen', 'OpenCode Zen (free models)', 'promo', null, null, null, null, null, null],
    ['opencode-go', 'OpenCode Go', 'paid', null, null, null, null, null, null],
    ['anthropic', 'Anthropic API', 'paid', 'anthropic', null, null, null, null, null],
    ['openai', 'OpenAI API', 'paid', 'openai', null, null, null, null, null],
    ['codex-cli', 'Codex CLI', 'subscription_cli', 'openai', null, null, null, null, null],
    [
      'claude-cli',
      'Claude Code CLI',
      'subscription_cli',
      'anthropic',
      null,
      null,
      null,
      null,
      null,
    ],
    ['opencode-cli', 'OpenCode CLI', 'subscription_cli', null, null, null, null, null, null],
  ] as const;
  const providers: MockProvider[] = specs.map(
    ([id, name, tag, brand, dayLimit, dayUsed, minuteLimit, minuteUsed, steps]) => {
      const windows: Provider['windows'] = [];
      const window = (
        metric: 'requests' | 'tokens' | 'usd',
        kind: Provider['windows'][number]['kind'],
        periodLabel: string,
        used: number,
        limit: number | null,
        resetAt: string | null,
        confidence: Provider['windows'][number]['confidence'],
      ) =>
        windows.push({
          id: `${id}-${periodLabel}`,
          scope: 'provider',
          modelRef: null,
          metric,
          kind,
          periodLabel,
          used,
          limit,
          remaining: limit === null ? null : Math.max(0, limit - used),
          resetAt,
          confidence,
        });
      if (id === 'gemini')
        window('requests', 'fixed_daily', 'per day', dayUsed, dayLimit, dailyPt, 'exact');
      if (id === 'openrouter') {
        window('requests', 'fixed_daily', 'per day', dayUsed, dayLimit, dailyUtc, 'exact');
        window('requests', 'rolling', 'per minute', minuteUsed, minuteLimit, null, 'exact');
      }
      if (id === 'cerebras') {
        window('tokens', 'fixed_daily', 'per day', 820000, 1000000, dailyUtc, 'exact');
        window('requests', 'rolling', 'per minute', minuteUsed, minuteLimit, null, 'exact');
      }
      if (id === 'groq') {
        window('requests', 'fixed_daily', 'per day', 140, 1000, dailyUtc, 'exact');
        window('tokens', 'rolling', 'per minute', 2100, 8000, null, 'exact');
        window('tokens', 'fixed_daily', 'per day', 150000, 200000, dailyUtc, 'exact');
      }
      if (id === 'nvidia') window('requests', 'rolling', 'per minute', 11, 40, null, 'estimated');
      if (id === 'mistral') {
        window('requests', 'rolling', 'per second', 0, 1, null, 'estimated');
        window('tokens', 'monthly', 'per month', 0, null, null, 'unknown');
      }
      if (id === 'opencode-go') {
        window('usd', 'dynamic', 'per 5h', 3.4, 12, null, 'exact');
        window('usd', 'weekly', 'per week', 11, 30, null, 'exact');
        window('usd', 'monthly', 'per month', 22, 60, null, 'exact');
      }
      return {
        id: id as Provider['id'],
        name,
        tag,
        kind: tag === 'subscription_cli' ? 'cli' : 'api',
        brand,
        keyStatus:
          tag === 'subscription_cli'
            ? id === 'codex-cli'
              ? 'not_applicable'
              : 'unchecked'
            : id === 'opencode-go'
              ? 'valid'
              : tag === 'paid'
                ? 'missing'
                : id === 'mistral'
                  ? 'unchecked'
                  : 'valid',
        enabled: tag === 'subscription_cli' ? true : tag === 'paid' ? false : true,
        health: id === 'cerebras' ? 'cooldown' : 'ok',
        cooldownUntil: id === 'cerebras' ? new Date(now.getTime() + 90000).toISOString() : null,
        dataUse:
          id === 'gemini'
            ? 'Free tier prompts may be used to improve Google products.'
            : id === 'mistral'
              ? 'Experiment tier data may be used for training.'
              : null,
        termsNote:
          id === 'openrouter'
            ? '1,000/day after a one-time $10 credit purchase; otherwise 50/day.'
            : id === 'groq'
              ? '8K tokens/min makes it a helper, not a main coder.'
              : id === 'opencode-zen'
                ? 'Promotional free models; may end without notice.'
                : id === 'codex-cli'
                  ? 'Uses your ChatGPT plan via the official CLI (delegation only).'
                  : null,
        signupUrl:
          id === 'gemini'
            ? 'https://aistudio.google.com/apikey'
            : id === 'openrouter'
              ? 'https://openrouter.ai/keys'
              : id === 'nvidia'
                ? 'https://build.nvidia.com'
                : null,
        docsUrl: null,
        verifiedAt: '2026-09-23',
        modelCount: 0,
        windows,
        stepsLeftToday: steps,
        ...(id === 'gemini' ? { dailyStepBudget: 104 } : {}),
        ...(id === 'openrouter' ? { dailyStepBudget: 382 } : {}),
        ...(id === 'cerebras' ? { dailyStepBudget: 120 } : {}),
        ...(id === 'groq' ? { dailyStepBudget: 50 } : {}),
      };
    },
  );

  return providers;
}
