# Free LLM API providers — research & verification

**Last verified: 2026-09-25.** Every number below is cited to an official provider page
(pricing / rate-limit / terms) unless explicitly marked `unknown` or `secondary-source`.
No API keys were used; this is a desk review of published docs. Where a provider has no
public, stable free allowance, the honest answer is "credits-only / trial" — not "free".

Companion proposed data files: `docs/research/limits-proposed/*.yaml`. They use the same
schema as `packages/catalog/data/limits/*.yaml` (`ProviderLimitsSchema` in
`packages/catalog/src/index.ts:37`). **Nothing in `src/` or `packages/catalog/data/` was
modified.**

---

## TL;DR

- **Best genuine, recurring, no-card free coding capacity per day:** Mistral Experiment
  (~1B tok/mo, phone required), SambaNova Free (200K tok/day), LLM7 free token
  (1M tok/day), Google Gemini Flash free (250 req/day), Groq free (200K tok/day/model),
  Cloudflare Workers AI (10K neurons/day).
- **Recurring but small/uncertain:** Kilo Gateway free (200 req/h/IP), OpenCode Zen free
  (promo, no published limits), Vercel AI Gateway ($5/mo credits), Hugging Face
  ($0.10/mo credits), Cohere trial (1,000 calls/month), TokenRouter (50K routed tok/mo),
  AnyAPI (100K anyTokens/day), OVHcloud anonymous (2 req/min/IP).
- **Credits-only / trial (not recurring free):** Cerebras (**changed** — repo entry is
  stale), Fireworks ($1), Nebius ($25+$25, 90-day expiry), Scaleway (1M tokens one-time),
  Hyperbolic ($1 + free 60 RPM basic), DeepInfra, Novita, Together, StepFun.
- **Dead / not API-usable / ToS-hostile:** GitHub Models (retired 2026-07-30), Chutes free
  (ended 2026-03), Qwen Code OAuth (discontinued 2026-04-15), ZenMux free (web chat only,
  no API), Kiro (ToS bans third-party proxy/harness; accounts banned), Pollinations
  (key+Pollen required, no recurring free pool), web-cookie scrapers (ChatGPT/Gemini/Claude
  Web).
- **Important correction for the catalog:** `packages/catalog/data/limits/cerebras.yaml`
  describes a permanently recurring 1M tokens/day free tier. Cerebras' own docs now say the
  Free Trial is **$5 of credits that expire 30 days after a verified payment method is
  added, with no permanently free tier**.
  <https://inference-docs.cerebras.ai/support/rate-limits>

---

## Summary table — ranked by usable recurring coding capacity / day

Ranked by published recurring token/request allowance available to a coding agent. "unknown"
means the provider does not publish a number. Currency conversions are not applied.

| # | Provider | Recurring free allowance | Reset / window | Card? phone? | API style | Coding-agent / third-party use | Data used for training? | Verdict |
|---|----------|--------------------------|----------------|--------------|-----------|-------------------------------|-------------------------|---------|
| 1 | **Mistral AI — Experiment** | ~1B tokens/month, ~1 RPS | monthly (per plan); RPS rolling 1s | no card; **phone required** | OpenAI-compat `https://api.mistral.ai/v1` | Yes — coding models (Codestral, Devstral) included | Yes unless opted out (free tier) | **Add as free default** |
| 2 | **SambaNova Cloud — Free** | 20 RPM, 20 RPD, **200K tokens/day** | daily (token-bucket) | no card | OpenAI-compat `https://api.sambanova.ai/v1` | Yes — no proxy ban found; sublicense to users allowed | Customer content not used for training; query logs may improve service | **Add as free default** |
| 3 | **LLM7.io — free token** | 1,000,000 tokens / rolling 24h; 2/s, 40/min, 100/h | rolling 24h | email; no card | OpenAI-compat `https://api.llm7.io/v1` | Resale/downstream needs written approval; personal agent use OK | Stores email only; does not sell data | **Add as optional** |
| 4 | **Google Gemini API — free tier** | Flash: 10 RPM, 250 req/day (`gemini.yaml`) | daily `America/Los_Angeles` | no card (region-gated) | Google + OpenAI-compat surface | Yes — Pi/Groq docs ship agent integrations | Yes on unpaid tier | **Keep (already in catalog)** |
| 5 | **GroqCloud — Free plan** | gpt-oss-120b: 30 RPM, 1K RPD, 8K TPM, 200K TPD (per model) | rolling + daily UTC | no card | OpenAI-compat `https://api.groq.com/openai/v1` | Yes — Groq documents OpenCode/Kilo/Cline/Roo | No (Groq does not train on API data) | **Keep (already in catalog)** |
| 6 | **Cloudflare Workers AI — Free** | 10,000 Neurons/day; text-gen 300 RPM | daily 00:00 UTC | Cloudflare account; no card for Free plan | REST + OpenAI-compat AI Gateway | Yes — generic inference API | No — "does not use your Customer Content to train" | **Add as optional** |
| 7 | **OpenCode Zen — free models** | 9 promo free models, **no published limits** | unknown | OpenCode account; no card for free lane | OpenAI/Anthropic-compat `https://opencode.ai/zen/v1` | **Flag:** no-lock-in stated, but free lane fingerprints tool list (`bash/edit/glob/grep/read`) | Promo/stealth models may train; NVIDIA endpoints trial-only | **Add as promo** |
| 8 | **Kilo Gateway — free models** | 200 requests/hour **per IP** (anonymous or authed) | rolling 1h | none for free models | OpenAI-compat `https://api.kilo.ai/api/gateway` | Yes — designed for Kilo, works for any OpenAI client | Auto-Free may route to providers that log/train | **Add as optional** |
| 9 | **Vercel AI Gateway — free tier** | $5/month credits; free-tier model subset | monthly | Vercel account; no card | OpenAI-compat `https://ai-gateway.vercel.sh/v1` | Yes | ZDR by default; no prompt training | **Add as optional** |
| 10 | **Hugging Face Inference Providers** | $0.10/month credits (free user) | monthly | HF account; no card | OpenAI-compat `https://router.huggingface.co/v1` | Yes | Per upstream provider terms | **Add as optional (tiny)** |
| 11 | **OVHcloud AI Endpoints — anonymous** | 2 requests/min/IP/model (no key) | rolling 1m | none (anonymous) | OpenAI-compat `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` | Yes | GDPR; EU-hosted | **Add as optional (tiny)** |
| 12 | **TokenRouter — Free** | 50,000 routed tokens/month; 2 providers | monthly | account; card not stated | OpenAI-compat `https://api.tokenrouter.com/v1` | Yes | unknown | **Add as optional (small)** |
| 13 | **AnyAPI — Free** | 100,000 anyTokens/calendar day | daily 00:00 UTC | account; no card stated | OpenAI-compat | Yes | unknown | **Add as optional (unit unclear)** |
| 14 | **Cohere — trial key** | 20 req/min/model; **1,000 calls/month** | monthly | no card | Cohere + OpenAI-compat | **Flag: trial keys "not permitted for production or commercial purposes"** | De-identified inputs may be used for training | **Add as caution, not default** |
| — | **Cerebras — Free Trial** | **$5 credits, expire 30 days** (no recurring free tier) | one-time, 30-day expiry | **verified payment method required** | OpenAI-compat `https://api.cerebras.ai/v1` | Yes | Subject to Cerebras terms | **Correct catalog: credits-only** |
| — | **Fireworks AI** | $1 starter credits | one-time | card to add credits; 10 RPM without payment | OpenAI-compat | Yes | Pay-as-you-go terms | **Skip (trial only)** |
| — | **Nebius Token Factory / AI Studio** | Builder: $25 + $25 (second after ~30 days), max $50; 90-day expiry | one-time | email verify; no card for credit | OpenAI-compat | Yes | unknown | **Skip / optional trial** |
| — | **Scaleway Generative APIs** | 1,000,000 tokens one-time; €100 with Business account | one-time | card/KYC for official limits | OpenAI-compat `https://api.scaleway.ai/v1` | Yes | EU/FR hosting | **Skip (one-time)** |
| — | **Hyperbolic** | $1 after phone verify; Basic tier 60 req/min | one-time credit | phone for $1; $5+ for Pro | OpenAI-compat `https://api.hyperbolic.xyz/v1` | Yes | "Zero Data Retention" | **Skip / optional trial** |
| — | **DeepInfra** | none (200 concurrent/model); card required | n/a | **card required** | OpenAI + Anthropic-compat | Yes | unknown | **Skip** |
| — | **Novita AI** | trial voucher (~$0.50 secondary); T1 tier; some $0 models | unknown | account | OpenAI-compat | Yes | unknown | **Skip / optional** |
| — | **Together AI** | dynamic per-model limits; no published free pool | dynamic | card for credits | OpenAI-compat | Yes | Pay-as-you-go terms | **Skip** |
| — | **StepFun** | none on API (V0 tier 5 concurrency/10 RPM needs balance) | n/a | account | OpenAI + Anthropic-compat | Yes | unknown | **Skip** |
| — | **ZenMux** | Free plan = 5 Flows/5h, **Studio Chat only, no API** | 5h rolling | account | OpenAI/Anthropic/Vertex | **No API on free plan** | unknown | **Skip (free tier not API-usable)** |

Notes on the table's honesty:
- "Coding-agent use allowed" is a **terms** question, not a technical one. Where the
  provider's ToS was not read end-to-end, the cell says so or is conservative.
- Request-rate limits and token budgets are usually **per organization**, not per agent.
- Some numbers (Mistral's 1B/mo, AnyAPI's anyToken→token rate) are approximations that the
  provider itself does not publish as a single canonical figure; they are marked as such.

---

## Provider notes (status, limits, signup, terms, data, API, models, headers, recommendation)

### 1. Mistral AI — Experiment plan — `alive / free`
- **Limits:** Free mode is the default; three independent limits: Requests per second,
  Tokens per minute, Tokens per month. A secondary source estimates ~1 RPS and ~1B
  tokens/month; the exact thresholds are only shown on the org's Limits page.
  <https://help.mistral.ai/en/articles/698531-why-am-i-hitting-api-rate-limits-and-how-do-i-increase-them>
- **Signup:** "All you need is a verified phone number (one phone number per plan). No
  credit card is required."
  <https://help.mistral.ai/en/articles/455206-how-can-i-try-the-api-for-free-with-the-experiment-plan>
- **Third-party use:** No prohibition found; Devstral/Codestral are marketed for coding
  agents. Free tier is documented as "intended for evaluation and prototyping"; production
  requires Scale. <https://help.mistral.ai/en/articles/424390-how-do-api-rate-limits-work-and-how-do-i-increase-them>
- **Data:** Free/unpaid usage may be used to improve models unless opted out
  (secondary source, `freellms.org`). Official privacy default: not confirmed here.
- **API:** OpenAI-compatible `https://api.mistral.ai/v1`; list models via `GET /v1/models`.
- **Headers:** `X-RateLimit-Remaining` (docs Known limitations). 429 on exceed.
  <https://docs.mistral.ai/resources/known-limitations>
- **Recommendation:** Add as free default — best published recurring capacity for a coding
  agent; keep the existing `caution` tag until the data-training opt-out is confirmed.

### 2. SambaNova Cloud — `alive / free`
- **Limits (Free Tier, no payment method):** per model **20 RPM, 20 RPD,
  200,000 tokens/day**; production models include `DeepSeek-V3.1`,
  `Meta-Llama-3.3-70B-Instruct`, `gpt-oss-120b`; preview: `DeepSeek-V3.2`,
  `gemma-4-31B-it`.
  <https://docs.sambanova.ai/docs/en/models/rate-limits>
  <https://cloud.sambanova.ai/plans>
- **Build note:** one busy minute can exhaust the 20 RPD — the daily request cap is the
  binding constraint, not tokens.
- **Signup:** no card required for the Free Tier (defined by absence of a payment method).
- **Third-party use:** allowed; the license explicitly permits sublicensing to Users.
  <https://sambanova.ai/cloud-end-user-license-agreement>
- **Data:** Customer Content processed "solely to the extent necessary to provide the
  Service … and for no other purposes"; query logs (Service Usage Data) may improve the
  service. No prompt-training clause found.
- **API:** OpenAI-compatible `https://api.sambanova.ai/v1`; models via `GET /v1/models`.
- **Headers:** `x-ratelimit-limit-requests`, `-remaining-requests`, `-reset-requests`
  (RPM) and `…-day` variants (RPD), documented on the rate-limits page.
- **Recommendation:** Add as free default (strong for bulk/day, poor for interactive bursts).

### 3. LLM7.io — `alive / free (donation-backed)`
- **Limits:** Anonymous: 500K tokens/24h, 1/s, 10/min, 60/h. **Free token (email):
  1,000,000 tokens/rolling 24h**, 2/s, 40/min, 100/h. Pro $12/mo higher.
  <https://docs.llm7.io/limits>
  (The project's own `TERMS.md` quotes 60/min & 250/h for free tokens; the docs page quotes
  40/min & 100/h. Treat the docs page as authoritative and expect drift.)
  <https://raw.githubusercontent.com/chigwell/llm7.io/main/TERMS.md>
- **Signup:** email at `dash.llm7.io`/`token.llm7.io`; no card.
- **Third-party use:** resale/embedded/downstream access requires written approval
  (`support@llm7.io`); ordinary personal coding-agent use is fine. Multi-account abuse
  bans.
- **Data:** stores email + minimal metadata for token issuance/abuse prevention; "We do not
  sell personal data." <https://llm7.io/>
- **API:** OpenAI-compatible `https://api.llm7.io/v1`; models via Models API.
- **Headers:** not documented.
- **Recommendation:** Add as optional. Small independent operator, no SLA; good fallback.

### 4. Google Gemini API — free tier — `alive / free`
- **Limits:** Flash-class only on the free tier; Pro is not free. Catalog currently records
  Flash: 10 RPM, 250 req/day, reset `America/Los_Angeles`.
  <https://ai.google.dev/gemini-api/docs/rate-limits>
- **Data:** "Requests may be used to improve Google products on unpaid tier" (catalog note;
  official policy page).
- **API:** Google GenAI + OpenAI-compatible endpoint; models via `GET /v1beta/models`.
- **Headers/errors:** 429 carries `RetryInfo`; the catalog uses parser
  `gemini_retry_info`.
- **Recommendation:** Keep. Refresh numbers each quarter — Google changes free tiers often.

### 5. GroqCloud — free plan — `alive / free`
- **Limits (Free plan, per model):** `openai/gpt-oss-120b` and `gpt-oss-20b`:
  30 RPM, 1,000 RPD, 8K TPM, 200K TPD; `qwen/qwen3.8-27b` same; Whisper 20 RPM.
  <https://console.groq.com/docs/rate-limits>
- **Signup:** account at console.groq.com; no card.
- **Third-party use:** explicitly supported — Groq ships integration guides for OpenCode,
  Kilo Code, Cline, Roo Code, Factory Droid.
  <https://console.groq.com/docs/coding-with-groq>
- **Data:** Groq states it does not train on customer API data (`/docs/your-data`).
- **Headers:** `retry-after`, `x-ratelimit-limit-requests` (RPD),
  `x-ratelimit-limit-tokens` (TPM), and remaining/reset variants — documented.
- **Recommendation:** Keep; strong interactive coding tier.

### 6. Cloudflare Workers AI — free allocation — `alive / freemium`
- **Limits:** **10,000 Neurons/day** on both Workers Free and Paid, reset 00:00 UTC;
  $0.011 / 1,000 Neurons above. Text Generation 300 RPM default; paid-only frontier models
  (Kimi K2.6/2.7, GLM 5.2/5.3, DeepSeek V4 Flash/Pro) are 20 RPM (50 with AI Gateway
  credits) and require Workers Paid / prepaid credits.
  <https://developers.cloudflare.com/workers-ai/platform/pricing/>
  <https://developers.cloudflare.com/workers-ai/platform/limits/>
- **Signup:** Cloudflare account; Free plan needs no card. Paid models do.
- **Third-party use:** generic inference API; no proxy restriction found.
- **Data:** "Cloudflare does not use your Customer Content to (1) train any AI models made
  available on Workers AI or (2) improve any Cloudflare or third-party services, and would
  not do so unless we received your explicit consent."
  <https://developers.cloudflare.com/workers-ai/platform/data-usage/>
- **API:** native Workers AI REST + OpenAI-compatible via AI Gateway; models via
  `GET /accounts/{id}/ai/models/search`.
- **Recommendation:** Add as optional. 10K Neurons is modest (roughly a few hundred K tokens
  on small models), but the data policy is excellent.

### 7. OpenCode Zen — free promo models — `promo / alive`
- **Free models:** Big Pickle, Space Bunny Free, MiMo-V2.5/V2.6-Flash Free,
  Ling 3.0 Flash Fin Free, Nemotron 3 Ultra/3.5 Lightning Free, Muse Spark 1.3
  Contributor Free, Jev 1.13 Free. **No published rate/token limits.**
  <https://opencode.ai/docs/zen/>
- **Signup:** OpenCode account; free lane works anonymously, paid models need billing.
- **Third-party use — FLAG:** OpenCode's own docs state "no lock-in … use it with any other
  coding agent," **but** pi-free's verified notes show the free-tier lane is sent with an
  anonymous `public` bearer and Zen **fingerprints the request's tool list** (must include
  lowercase `bash`, `edit`, `glob`, `grep`, `read`). Account-key free-tier requests are
  rejected upstream (`403 Model access is disabled`). So the free tier is de-facto
  usable only from agents that emit that exact tool surface.
  <https://github.com/apmantza/pi-free/blob/master/docs/providers.md>
- **Data:** zero-retention for most, **except the free stealth/promo models**, which may use
  data to improve the model; NVIDIA endpoints are "trial use only — do not submit personal
  or confidential data." Muse Spark Contributor Free trains future Meta models.
- **API:** OpenAI/Anthropic-compatible `https://opencode.ai/zen/v1`; models via
  `GET /zen/v1/models`.
- **Recommendation:** Add as `promo`, not a default. Honest label: "free models exist, limits
  unknown, harness fingerprint required."

### 8. Kilo (Kilo Code) Gateway — free models — `alive / freemium`
- **Limits:** All free-model requests (anonymous or authenticated) are rate-limited **by IP:
  200 requests/hour**; 429 returned. Paid traffic not gateway-limited.
  <https://kilo.ai/docs/gateway/usage-and-billing>
- **Free model IDs:** `stepfun/step-3.7-flash:free`, `poolside/laguna-s-2.1:free`,
  `poolside/laguna-xs-2.1:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`,
  `tencent/hy3:free`, `openrouter/free`; `kilo-auto/free` auto-routes.
  <https://kilo.ai/docs/gateway/models-and-providers>
- **Signup:** none for free models (public catalog, anonymous allowed).
- **Third-party use:** OpenAI-compatible; models endpoint needs no auth. NVIDIA free
  endpoints are "trial use only — do not submit personal or confidential data." Auto Free
  "may route your requests to providers that log prompts and outputs and use them to improve
  their services."
- **API:** `https://api.kilo.ai/api/gateway`; models via `GET /models` (no auth).
- **Recommendation:** Add as optional. Good breadth, but free traffic may be logged/trained —
  mark `caution` for sensitive code.

### 9. Vercel AI Gateway — free tier — `alive / credits-recurring`
- **Limits:** Free tier = monthly included credit (**$5/month**, per Vercel's comparison
  page) plus a subset of free-tier models; per-model rate limits lower than paid; 429 on
  exceed. Once you buy credits you move to paid and the monthly free credit stops.
  <https://vercel.com/docs/ai-gateway/pricing>
  <https://vercel.com/docs/ai-gateway/rate-limits>
  <https://vercel.com/i/vercel-ai-gateway-vs-cloudflare-ai-gateway>
- **Signup:** Vercel account; no card for free tier.
- **Third-party use:** yes — OpenAI Chat Completions, Responses, Anthropic Messages,
  OpenResponses surfaces all supported.
- **Data:** ZDR by default; prompts/outputs permanently deleted after request; "Disallow
  Prompt Training" per request is free on all users.
  <https://vercel.com/docs/ai-gateway/security-and-compliance>
- **API:** `https://ai-gateway.vercel.sh/v1`; models via `/ai-gateway/models`.
- **Recommendation:** Add as optional. $5/mo is enough to be a useful fallback lane.

### 10. Hugging Face Inference Providers — `alive / credits-recurring`
- **Limits:** Free users get **$0.10/month** credits (subject to change); PRO $2.00/month;
  Team/Enterprise $2/seat/month. Pay-as-you-go requires purchasing credits. No provider
  markup.
  <https://huggingface.co/docs/inference-providers/pricing>
- **Signup:** HF account; no card for free credits.
- **Third-party use:** yes — OpenAI SDK against `https://router.huggingface.co/v1`.
- **Data:** governed by the routed upstream provider's terms.
- **API:** `https://router.huggingface.co/v1`; models via HF Hub / `/v1/models`.
- **Recommendation:** Add as optional; effectively a micro-budget, not a daily driver.

### 11. OVHcloud AI Endpoints — anonymous free tier — `alive / free`
- **Limits:** Anonymous: **2 requests/min per IP per model**; authenticated with API key:
  400 requests/min per Public Cloud project per model. 429 on exceed.
  <https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-getting-started>
  <https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-troubleshooting.md>
- **Signup:** anonymous needs nothing; API keys require a Public Cloud project **with a
  payment method** (Discovery-mode projects cannot use the service).
- **Third-party use:** yes — OpenAI-compatible; no usage limits beyond rate/payload.
- **Data:** GDPR / EU (France) hosted; "data privacy as a top priority."
- **API:** OpenAI-compatible `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1`.
- **Recommendation:** Add as optional (tiny). 2 RPM is fine as a last-resort fallback.

### 12. TokenRouter — `alive / freemium`
- **Limits:** Free plan: **50,000 routed tokens/month**, limited to 2 providers, playground,
  built-in routing, OpenAI SDK compatible; `auto` routing is paid-only (free returns
  `403 auto_routing_unavailable`).
  <https://tokenrouter.io/pricing>
  <https://www.tokenrouter.io/docs/models>
- **Ambiguity:** there are two similarly named products (`tokenrouter.io` subscription
  gateway vs `tokenrouter.com` multi-model PAYG). The free 50K/month figure is the `.io`
  one. Confirm which one the catalog means before adding.
- **API:** OpenAI-compatible `https://api.tokenrouter.com/v1` (`.com`) / docs on `.io`.
- **Recommendation:** Add as optional small, after disambiguating the two brands.

### 13. AnyAPI — Free plan — `alive / free`
- **Limits:** Free plan: **up to 100,000 anyTokens per calendar day**, reset 00:00 UTC,
  non-carryover; one account per person; extras may be rate-limited at any time.
  <https://anyapi.ai/terms-of-service>
- **Caveat:** `anyToken` is a proprietary billing abstraction, not a raw token; the
  conversion to model tokens is intentionally unpubished. So the real daily token budget is
  `unknown`.
- **Signup:** account; no card stated.
- **Third-party use:** yes — OpenAI-compatible, 400+ models.
- **Data:** ToS does not publish a training policy; mark `unknown`.
- **Recommendation:** Add as optional with the unit caveat; not a trustworthy default.

### 14. Cohere — trial key — `alive / trial`
- **Limits:** Trial keys: 20 req/min/model on Chat/Command; **1,000 API calls/month** overall;
  Embed 2,000 inputs/min; Rerank 10 req/min.
  <https://docs.cohere.com/docs/rate-limits>
- **Signup:** Cohere account; no card for a trial key.
- **Third-party use — FLAG:** "API calls made from a Trial API key are free. However, trial
  keys are rate limited and **are not permitted to be used for production or commercial
  purposes**." A coding agent used for work is arguably commercial use.
  <https://cohere.com/pricing>
- **Data:** "De-identified data from the use of Cohere models on Cohere-hosted environments
  (e.g. user inputs) may be used in limited circumstances where permitted by user controls
  and Cohere's relevant terms of service."
  <https://docs.cohere.com/docs/command-a-plus>
- **API:** Cohere v2 + OpenAI-compatible SDK; models via `GET /v1/models`.
- **Recommendation:** Add as `caution`, never a default; the monthly 1,000-call cap kills it
  for agents anyway.

### 15. Cerebras Inference — `alive / credits-only (CORRECTION)`
- **Current docs:** "New accounts receive **$5 in free credits after adding a verified
  payment method**. These credits expire 30 days after they're granted… **Is there a
  permanently free tier? No.**"
  <https://inference-docs.cerebras.ai/support/rate-limits>
- **Free Trial rate limits** (while credits last): `gpt-oss-120b` and `qwen-3.8-27b`:
  5 RPM, 30K uncached TPM, 90K total TPM, 1M TPH, 1M TPD. Developer (PAYG): 1K RPM,
  1M/3M TPM, no hourly/daily caps.
- **Impact:** `packages/catalog/data/limits/cerebras.yaml` currently tags Cerebras `legit`
  with a recurring 1M tokens/day. That is no longer accurate and should become
  `credits-only` / `caution`, or `dead` once credits are exhausted. A proposed file is
  provided.
- **Data:** subject to Cerebras terms; not reviewed here.
- **Recommendation:** Correct the catalog; do not count as free daytime capacity.

### 16. Other trial/credits-only providers (short)
- **Fireworks AI** — $1 starter credits; 10 RPM with no payment method, 6,000 RPM with
  payment and credits. No permanently free models.
  <https://docs.fireworks.ai/guides/quotas_usage/account-quotas>
  <https://fireworks.ai/pricing>
- **Nebius Builder** — $25 AI Cloud + $25 Token Factory + $25 Tavily on registration, a
  second $25+$25 after ~30 days, max $50/$50, **expire 90 days**, one account/verified email.
  <https://nebius.com/builders-terms-and-conditions>
- **Scaleway Generative APIs** — 1,000,000 tokens free (one-time; 60 min audio), plus €100
  with a Business account; card/KYC needed for official rate limits; TPM/QPM/concurrency
  with `x-ratelimit-*` headers.
  <https://www.scaleway.com/en/docs/generative-apis/faq.md>
  <https://www.scaleway.com/en/docs/generative-apis/reference-content/rate-limits.md>
- **Hyperbolic** — $1 promo after phone verification; Basic tier 60 req/min, Pro (≥$5) 600
  req/min; per-IP 600 req/min; "Zero Data Retention."
  <https://www.hyperbolic.ai/docs/inference/performance-limits>
  <https://hyperbolic.ai/docs/general/billing-payments>
- **DeepInfra** — no free tier; 200 concurrent requests/model; "You have to add a card or
  pre-pay or you won't be able to use our services."
  <https://deepinfra.com/pricing> <https://docs.deepinfra.com/account/rate-limits>
- **Novita AI** — default tier for new users; LLM RPM/TPM is tier-based and only rendered
  dynamically; sandbox gets $100 promo credits; ~$0.50 signup voucher reported by secondary
  sources (unverified). <https://novita.ai/docs/guides/llm-rate-limits>
  <https://docs.novita.ai/guides/sandbox-pricing>
- **Together AI** — dynamic per-model rate limits, no fixed free pool published; response
  headers carry the live limits; 429/503 behavior documented.
  <https://docs.together.ai/docs/serverless/rate-limits>
- **StepFun** — no free API tier; V0 ($0 top-up) = 5 concurrency / 10 RPM / 5M TPM. Step Plan
  is paid. <https://platform.stepfun.ai/docs/en/pricing/details>
- **ZenMux** — Free plan = 5 Flows / 5 hours in Studio Chat, **"no API Request access."**
  API requires Starter $20/mo. <https://zenmux.ai/docs/guide/subscription.html>

---

## Relays, scrapers, and dead providers that routers (OmniRoute / 9router) count

These appear in routing catalogs but are **not** providers with a stable, first-party free
tier. Treat them as `skip` for a shipping default; several are outright ToS risks.

| Provider counted by routers | Classification | Why / evidence |
|---|---|---|
| **Kiro AI** | **Dead for routers (ToS ban)** | "Kiro's ToS also prohibits third-party proxy/harness use"; accounts reported banned. <https://github.com/diegosouzapw/OmniRoute/discussions/9216> |
| **Qwen Code (OAuth free)** | **Dead** | "Qwen OAuth free tier was discontinued on 2026-04-15." (OmniRoute provider reference) |
| **GitHub Models** | **Dead** | "As of July 30, 2026, GitHub Models has been fully retired." <https://docs.github.com/en/github-models/about-github-models> |
| **Chutes free** | **Dead** | Free access ended 2026-03 (already recorded in `dead-chutes.yaml`). |
| **Gemini CLI** | **Dead** | Already recorded in `dead-gemini-cli.yaml`. |
| **Pollinations** | **Relay / no recurring free pool** | Now requires an API key (`enter.pollinations.ai`); free usage = quest-earned Pollen, not a predictable allowance. <https://gen.pollinations.ai/docs> |
| **LongCat** | **Relay / KYC trial** | Claimed "10M tokens one-time, requires KYC" by OmniRoute; no official number verified. |
| **AgentRouter** | **Relay / unverified** | Markets "$100 free credits"; no first-party docs reviewed → `unknown`. |
| **OpenGateway / B.AI / Routeway / FastRouter** | **Relay gateways** | Proxy other providers; free entries are promotional and change without notice (pi-free paid/trial list). |
| **OrcaRouter / Xkiro / AnyRouter / Naga.ai / Nano-GPT / Zuki** | **Relay aggregators** | `:free` model IDs exist but quotas are account/plan-gated or unpublished; no stable free pool. |
| **Qoder** | **Free but app-only** | Basic Community tier is free inside Qoder's own client; no documented API free tier for third-party agents. |
| **ChatGPT Web / Gemini Web / Claude Web (cookie)** | **Scraper (ToS risk)** | OmniRoute's "Web cookie" category wraps vendor web apps; violates vendor ToS and is unstable. |
| **"OpenCode Free — unlimited, no auth"** (router marketing) | **Mislabel** | The real thing is OpenCode Zen's promo free models with unknown limits; not unlimited. |
| **"Qwen unlimited no auth"** (router marketing) | **Dead/mislabel** | OAuth free tier gone; API is paid via DashScope/OpenRouter. |

---

## Catalog recommendations (actionable)

1. **Correct `cerebras.yaml`** — retag from `legit` recurring-1M/day to `caution`
   credits-only ($5 / 30 days). Remove the recurring daily windows or mark them trial-only.
   Proposed replacement in `limits-proposed/cerebras.yaml`.
2. **Add strong recurring free entries** as proposed files: `sambanova`,
   `cloudflare-workers-ai`, `llm7`, `vercel-ai-gateway`, `huggingface`,
   `opencode-zen` (promo), `kilo`, `tokenrouter`, `anyapi`, `ovhcloud`.
3. **Add a `mistral` data-training caveat** rather than changing limits.
4. **Do not add**: DeepInfra, Fireworks, Nebius, Scaleway, Hyperbolic, Novita, Together,
   StepFun, ZenMux, Pollinations, Kiro — trial/credits-only, app-only, or ToS-hostile.
5. **Keep** existing `groq`, `gemini`, `openrouter`, `nvidia`, `mistral` entries but
   re-verify quarterly; free tiers move fast.

---

## Sources (official unless noted)

- Cloudflare Workers AI pricing/limits/data: https://developers.cloudflare.com/workers-ai/platform/pricing/ · https://developers.cloudflare.com/workers-ai/platform/limits/ · https://developers.cloudflare.com/workers-ai/platform/data-usage/
- SambaNova rate limits/plans/ToS: https://docs.sambanova.ai/docs/en/models/rate-limits · https://cloud.sambanova.ai/plans · https://sambanova.ai/cloud-end-user-license-agreement
- Hugging Face Inference Providers pricing: https://huggingface.co/docs/inference-providers/pricing
- Z.ai pricing: https://docs.z.ai/guides/overview/pricing
- Ollama pricing/data: https://ollama.com/pricing
- Cohere rate limits/pricing/model card: https://docs.cohere.com/docs/rate-limits · https://cohere.com/pricing · https://docs.cohere.com/docs/command-a-plus
- Vercel AI Gateway pricing/rate limits/security: https://vercel.com/docs/ai-gateway/pricing · https://vercel.com/docs/ai-gateway/rate-limits · https://vercel.com/docs/ai-gateway/security-and-compliance
- GitHub Models retirement: https://docs.github.com/en/github-models/about-github-models
- Kilo Gateway: https://kilo.ai/docs/gateway/models-and-providers · https://kilo.ai/docs/gateway/usage-and-billing · https://kilo.ai/docs/getting-started/using-kilo-for-free
- LLM7 docs/terms: https://docs.llm7.io/limits · https://llm7.io/ · https://raw.githubusercontent.com/chigwell/llm7.io/main/TERMS.md
- Pollinations: https://gen.pollinations.ai/docs
- DeepInfra: https://deepinfra.com/pricing · https://docs.deepinfra.com/account/rate-limits
- Novita: https://novita.ai/docs/guides/llm-rate-limits · https://docs.novita.ai/guides/sandbox-pricing
- ZenMux: https://zenmux.ai/docs/guide/subscription.html
- StepFun: https://platform.stepfun.ai/docs/en/pricing/details
- TokenRouter: https://tokenrouter.io/pricing · https://www.tokenrouter.io/docs/models
- AnyAPI: https://anyapi.ai/terms-of-service
- Together: https://docs.together.ai/docs/serverless/rate-limits
- Fireworks: https://docs.fireworks.ai/guides/quotas_usage/account-quotas · https://fireworks.ai/pricing
- Nebius: https://nebius.com/builders-terms-and-conditions
- Scaleway: https://www.scaleway.com/en/docs/generative-apis/faq.md · https://www.scaleway.com/en/docs/generative-apis/reference-content/rate-limits.md
- OVHcloud: https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-getting-started · https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-troubleshooting.md
- Hyperbolic: https://www.hyperbolic.ai/docs/inference/performance-limits · https://hyperbolic.ai/docs/general/billing-payments
- Groq: https://console.groq.com/docs/rate-limits · https://console.groq.com/docs/coding-with-groq
- Cerebras: https://inference-docs.cerebras.ai/support/rate-limits
- Mistral: https://help.mistral.ai/en/articles/455206-how-can-i-try-the-api-for-free-with-the-experiment-plan · https://help.mistral.ai/en/articles/698531-why-am-i-hitting-api-rate-limits-and-how-do-i-increase-them · https://docs.mistral.ai/resources/known-limitations
- OpenCode Zen: https://opencode.ai/docs/zen/
- Secondary (candidate mining, not cited for numbers unless stated): https://github.com/apmantza/pi-free/blob/master/docs/providers.md (MIT) · OmniRoute provider reference and discussions (diegosouzapw/OmniRoute)
