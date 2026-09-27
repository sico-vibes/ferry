# Providers

Ferry is bring-your-own-key. Signup links and categories below are guidance; plans, availability, limits, regions, and data policies change. Desk-reviewed 2026-09-25 against [provider research](research/free-providers.md); check the linked provider page before use. Ferry does not guarantee capacity.

| Provider | Access tag | Signup / limits | Data use and notes |
|---|---|---|---|
| Anthropic | paid API; subscription OAuth | [Console](https://console.anthropic.com/); usage/rate limits vary by account and model | Review Anthropic API terms. Subscription login has suspension risk (below). |
| Cerebras | trial / credits | [Cerebras](https://cloud.cerebras.ai/); $5 trial credit, expires 30 days after verified payment method; changed 2026-07-21 | Not a recurring free tier. See current [rate limits](https://inference-docs.cerebras.ai/support/rate-limits). |
| Cloudflare Workers AI | free allowance + paid | [Dashboard](https://dash.cloudflare.com/); 10,000 neurons/day on free plan (verified 2026-09-25) | Review Cloudflare data policy; account required. |
| DeepInfra | paid / account credits | [DeepInfra](https://deepinfra.com/); no stable recurring free coding quota verified | Check model-specific prices and policy. |
| DeepSeek | paid API | [Platform](https://platform.deepseek.com/); limits vary by account/model | Review provider retention and model data policy. |
| Fireworks | promo credits / paid | [Fireworks](https://fireworks.ai/); promotional credit availability varies | Credits are not recurring free capacity. |
| Google Gemini API | free / paid | [AI Studio](https://aistudio.google.com/); per-model limits; free Flash examples include 20 RPD, Flash-Lite 500 RPD (community report, 2026-09-03; verify in console) | Unpaid-tier data may be used to improve products; do not send sensitive data. Google Gemini CLI OAuth free access ended 2026-06-18. |
| Groq | free / paid | [Groq Console](https://console.groq.com/); model-specific limits; GPT-OSS-120B example: 30 RPM, 1,000 RPD, **8K TPM**, 200K TPD (verified 2026-09-25) | Groq says API data is not used for training. TPM can be the practical bottleneck. |
| Hugging Face | credits / paid | [Hugging Face](https://huggingface.co/settings/billing); small monthly inference credits vary | Review model host data policies. |
| Kilo Gateway | promotional free models / paid | [Kilo](https://kilo.ai/); reported ~200 requests/hour/IP; not a guaranteed allowance | Limits are shared/IP-scoped and may change. |
| LLM7 | free token / paid | [LLM7](https://llm7.io/); published 1M tokens/rolling 24h and request-rate caps (verified 2026-09-25) | Personal agent use; downstream resale requires written approval per research. |
| Mistral | free Experiment / paid | [La Plateforme](https://console.mistral.ai/); Experiment limits are plan/model-specific; phone verification may be required | Free Experiment data may improve models unless opted out. |
| NVIDIA NIM | free / paid | [NVIDIA Build](https://build.nvidia.com/); 40 RPM reported; daily token ceiling not published (verified 2026-09-25) | Check each model's terms and current console quota. |
| OpenAI | paid API; subscription OAuth | [Platform](https://platform.openai.com/); account/model limits vary | Review API data controls. ChatGPT subscription OAuth is unofficial and risky. |
| OpenCode Zen | promo free models / paid | [OpenCode Zen](https://opencode.ai/zen); no stable official free quota published | **Free tier only works inside OpenCode**; using it through Ferry is unsupported and may return a free-tier-only error. |
| OpenRouter | free `:free` models / paid | [OpenRouter](https://openrouter.ai/); `:free` commonly limited to **50 requests/day** plus 20 RPM; account/tier rules vary (verified 2026-09-25) | Free endpoints may log prompts and some may use them for training. Check the routed model's policy. |
| SambaNova | free / paid | [SambaCloud](https://cloud.sambanova.ai/); published free example: 20 RPM, 20 RPD, 200K tokens/day (2026-09-25) | Provider says customer content is not used for training; query logs may improve service. RPD binds early. |
| Together AI | promo credits / paid | [Together](https://api.together.ai/); trial availability/account limits vary | Do not treat credits as recurring free capacity. |
| Vercel AI Gateway | credits / paid | [Vercel](https://vercel.com/); credit amount depends on account/plan | Requests pass through a gateway; review gateway and upstream model policies. |
| Other catalog entries | credits / paid / account-specific | Limits are provider- and model-specific; see [catalog snapshots](../packages/catalog/data/limits/) and provider console | Catalog metadata is not a promise that an account has quota. (updating) |

## Subscription OAuth

Opt-in integrations currently cover Claude Pro/Max, ChatGPT, and GitHub Copilot through pi-ai. These are unofficial clients. **A provider may suspend or ban an account for subscription use through Ferry; you accept that risk.** Prefer an API key or the provider's official CLI. Ferry requires an explicit warning acknowledgement for each login. OAuth tokens are held in the OS keyring. Subscription models are excluded from automatic routing unless explicitly enabled in Settings → Providers & Keys; manual selection remains available.

## Practices Ferry does not support

Ferry does not scrape consumer chat websites, replay browser cookies, share/rotate accounts to evade quotas, or present one person's subscription as a pooled API. These practices can violate provider terms, expose account sessions, undermine quota controls, and put accounts at risk. Use documented APIs and your own credentials.

Provider categories describe the access route, not the quality or practical capacity. Requests/day is often more informative than token totals for interactive agents. Read the detailed [free-provider research](research/free-providers.md) and [community evidence](research/community-free-llm.md) for caveats and sources.
