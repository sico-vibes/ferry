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
    ['cerebras', 'Cerebras', 'caution', null, null, null, 5, 1, 27],
    ['groq', 'Groq', 'legit', null, 1000, 140, 8000, 2100, 43],
    ['mistral', 'Mistral (Experiment)', 'legit', 'mistralai', null, null, 1, 0, null],
    ['opencode-zen', 'OpenCode Zen (free models)', 'promo', null, null, null, null, null, null],
    ['sambanova', 'SambaNova Cloud', 'legit', null, null, null, null, null, null],
    ['llm7', 'LLM7.io', 'caution', null, null, null, null, null, null],
    ['cloudflare-workers-ai', 'Cloudflare Workers AI', 'legit', null, null, null, null, null, null],
    ['kilo', 'Kilo Gateway', 'caution', null, null, null, null, null, null],
    ['vercel-ai-gateway', 'Vercel AI Gateway', 'credits', null, null, null, null, null, null],
    ['huggingface', 'Hugging Face Inference', 'credits', null, null, null, null, null, null],
    ['ovhcloud', 'OVHcloud AI Endpoints', 'legit', null, null, null, null, null, null],
    ['tokenrouter', 'TokenRouter', 'caution', null, null, null, null, null, null],
    ['anyapi', 'AnyAPI', 'caution', null, null, null, null, null, null],
    ['zai-glm', 'Z.ai GLM', 'legit', null, null, null, null, null, null],
    ['fireworks', 'Fireworks AI', 'credits', null, null, null, null, null, null],
    ['nebius', 'Nebius Token Factory', 'credits', null, null, null, null, null, null],
    ['scaleway', 'Scaleway Generative APIs', 'credits', null, null, null, null, null, null],
    ['hyperbolic', 'Hyperbolic', 'credits', null, null, null, null, null, null],
    ['deepinfra', 'DeepInfra', 'credits', null, null, null, null, null, null],
    ['novita', 'Novita AI', 'credits', null, null, null, null, null, null],
    ['together', 'Together AI', 'credits', null, null, null, null, null, null],
    ['stepfun', 'StepFun', 'credits', null, null, null, null, null, null],
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
  const optionalProviderIds = new Set([
    'llm7',
    'cloudflare-workers-ai',
    'kilo',
    'vercel-ai-gateway',
    'huggingface',
    'ovhcloud',
    'tokenrouter',
    'anyapi',
    'zai-glm',
    'fireworks',
    'nebius',
    'scaleway',
    'hyperbolic',
    'deepinfra',
    'novita',
    'together',
    'stepfun',
  ]);
  const providerLinks: Record<string, string> = {
    sambanova: 'https://cloud.sambanova.ai/',
    llm7: 'https://dash.llm7.io/',
    'cloudflare-workers-ai': 'https://dash.cloudflare.com/',
    kilo: 'https://app.kilo.ai/',
    'vercel-ai-gateway': 'https://vercel.com/dashboard',
    huggingface: 'https://huggingface.co/settings/tokens',
    ovhcloud: 'https://www.ovhcloud.com/en/public-cloud/ai-endpoints/',
    tokenrouter: 'https://www.tokenrouter.io/',
    anyapi: 'https://anyapi.ai/',
    'zai-glm': 'https://z.ai/manage-apikey/apikey-list',
    fireworks: 'https://fireworks.ai/',
    nebius: 'https://nebius.com/',
    scaleway: 'https://console.scaleway.com/',
    hyperbolic: 'https://app.hyperbolic.ai/',
    deepinfra: 'https://deepinfra.com/dash',
    novita: 'https://novita.ai/',
    together: 'https://api.together.ai/',
    stepfun: 'https://platform.stepfun.ai/',
  };
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
              : id === 'ovhcloud' || id === 'kilo'
                ? 'not_applicable'
                : tag === 'paid' || optionalProviderIds.has(id) || id in providerLinks
                  ? 'missing'
                  : id === 'mistral'
                    ? 'unchecked'
                    : 'valid',
        enabled:
          tag === 'subscription_cli'
            ? true
            : tag === 'paid' || optionalProviderIds.has(id)
              ? false
              : true,
        health: id === 'cerebras' ? 'cooldown' : 'ok',
        cooldownUntil: id === 'cerebras' ? new Date(now.getTime() + 90000).toISOString() : null,
        dataUse:
          id === 'gemini'
            ? 'Free tier prompts may be used to improve Google products.'
            : id === 'mistral'
              ? 'Experiment tier data may be used for training.'
              : id === 'sambanova'
                ? 'Customer content is processed to provide the service; query logs may improve the service.'
                : id === 'cloudflare-workers-ai'
                  ? 'Customer content is not used to train AI models without explicit consent.'
                  : id === 'vercel-ai-gateway'
                    ? 'Zero Data Retention by default; upstream provider terms may apply.'
                    : id === 'huggingface'
                      ? 'Routed requests follow the upstream provider terms.'
                      : id === 'kilo'
                        ? 'Auto Free may route to providers that log or train on prompts.'
                        : id === 'ovhcloud'
                          ? 'GDPR-compliant and hosted in France.'
                          : null,
        termsNote:
          id === 'openrouter'
            ? '1,000/day after a one-time $10 credit purchase; otherwise 50/day.'
            : id === 'groq'
              ? '8K tokens/min makes it a helper, not a main coder.'
              : id === 'opencode-zen'
                ? 'Promotional free models; may end without notice.'
                : id === 'sambanova'
                  ? 'Free tier has per-model daily request limits; RPD is the binding request cap.'
                  : id === 'llm7'
                    ? 'Resale or downstream access requires written approval; no SLA.'
                    : id === 'kilo'
                      ? 'Free-model requests are limited by IP; automatic routing may select upstream providers.'
                      : id === 'vercel-ai-gateway'
                        ? 'Monthly free credits stop applying after purchasing credits.'
                        : id === 'huggingface'
                          ? 'Monthly inference credits are small and subject to change.'
                          : id === 'ovhcloud'
                            ? 'Anonymous requests are limited to 2 per minute per IP and model.'
                            : id === 'tokenrouter'
                              ? 'Free tier is limited to 2 providers; auto-routing is paid-only.'
                              : id === 'anyapi'
                                ? 'anyToken conversion to model tokens is not published.'
                                : id === 'zai-glm'
                                  ? 'Free Flash model quotas vary by account.'
                                  : tag === 'credits'
                                    ? 'Credits or trial access are finite; not a recurring free tier.'
                                    : id === 'codex-cli'
                                      ? 'Uses your ChatGPT plan via the official CLI (delegation only).'
                                      : null,
        signupUrl:
          providerLinks[id] ??
          (id === 'gemini'
            ? 'https://aistudio.google.com/apikey'
            : id === 'openrouter'
              ? 'https://openrouter.ai/keys'
              : id === 'nvidia'
                ? 'https://build.nvidia.com'
                : null),
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
