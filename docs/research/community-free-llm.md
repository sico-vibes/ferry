# R-community — how the community gets free hosted LLM capacity for agents/coding

**Scope:** hosted/free-tier APIs, free CLI tiers, free gateways/routers, promos and credits.
**Excluded by request:** local hosting and everything that implies a GPU (Ollama, LM Studio,
llama.cpp, quantization). Where a community answer is local-only it is labelled and not counted.
**Method:** desk research over 2025-2026 web sources (provider docs, GitHub, forums, vendor blogs)
plus Reddit-wide and per-subreddit search. **No Reddit API key and no LLM API keys were used**; many
Reddit rows therefore come from search result *snippets* rather than full thread bodies. Every row
says whether it is **first-hand** (the author ran it), **verified** (provider/GitHub-official), or
**rumor/secondary** (aggregator or marketing claim). "unknown" means no source found. Quotes are ≤15
words and attributed. Dates are the source's own dates. This file is docs-only; no `src/` change.

---

## Plain-English summary (10 lines)

1. In 2025-2026 the community's free coding stack converged on **Groq + NVIDIA NIM + OpenRouter free
   + a Google lane (AI Studio / Gemini CLI, now Antigravity)**, with **Cerebras** a favourite until
   its free tier became a $5 credit trial on 2026-07-21.
2. The harness matters as much as the provider: **OpenCode (+ Zen free models), Cline, Roo Code, Kilo
   Code (+ Auto Free), Aider, Qwen Code, Command Code and Freebuff** are what people actually run.
3. Almost nobody survives on one free provider; **fallback chains and free-tier routers are the norm**,
   and routers are also the biggest new supply-chain risk (malicious tool-call injection).
4. Advertised limits are routinely wrong: free "daily tokens" get replaced by credits, model catalogues
   are pruned without notice, and the binding constraint is usually **requests/day, not tokens**.
5. Free tiers pay for themselves with your data: many log prompts/completions and train on them; the
   community treats this as the real price of "free".
6. Tool-calling is the reliability cliff: free/open models fail to emit parseable tool calls far more
   often than frontier models, which is why agent users burn quota on retries.
7. Promos ("stealth" models, free Kilo/Roo/OpenCode lanes) give huge short-lived capacity but end
   without warning or public schedules.
8. Gray practices (alt-account farming, OAuth reuse, cookie web-session proxies) appeared in 2026 and
   produced real mass bans; the community now treats them as a liability, not a hack.
9. The community's most-wanted things are **predictable published limits, honest data-use labels,
   mid-task checkpoint/resume, and one endpoint that fails over across free pools**.
10. For Ferry: keep Gemini/Groq/Mistral/SambaNova/NVIDIA, **demote Cerebras**, add OpenCode Zen/Kilo/
    Roo promos as `caution`, warn on routers and gray auth, and default to data-use-safe free lanes.

---

## 0. Community map (which subreddits exist and were used)

Verified by search hits in this research unless marked. Case is as observed.

| Subreddit | Status | What it contributes |
|---|---|---|
| `r/opencodeCLI`, `r/opencode` | exists | OpenCode Zen free models, free-provider setups, NVIDIA NIM TUI |
| `r/RooCode` | exists | Roo Code Cloud free promos, tool-calling quality |
| `r/CLine` | exists | free-model tool-call failures, Cline free promos |
| `r/kilocode` | exists | Kilo free models / Auto Free, free-period endings |
| `r/aider` | exists | "Unofficial main subreddit of aider" (r/aider sidebar) |
| `r/vibecoding` | exists | "best free setup" threads, free-coding-models TUI |
| `r/ChatGPTCoding` | exists | Aider/Cline/Roo free-model comparisons |
| `r/AI_Agents` | exists | "Free-Tier AI Stack for 2026", free API requests |
| `r/LLMDevs` | exists | "Free Model List (API Keys)", router-security paper, router launches |
| `r/GeminiAI` | exists | free-tier cuts, Gemini CLI retirement, Antigravity limits |
| `r/GoogleGeminiAI` | exists | Gemini feature/limits posts |
| `r/google_antigravity`, `r/GoogleAntigravityIDE` | exists (discovered) | Antigravity free tier, Google AI Pro pricing |
| `r/openrouter` | exists | free-model daily limits, `$10 → 1000 RPD` |
| `r/LocalLLaMA` | exists | used **only** for free hosted-API/router threads |
| `r/selfhosted`, `r/SelfHostedAI` | exists | self-hosted *routers/gateways* (FreeLLMAPI, MiniRouter) |
| `r/opensource` | exists | open-source coding-agent launches |
| `r/ArtificialInteligence` (sic) | exists | LLM API price/free-tier threads |
| `r/openclaw`, `r/clawdbot`, `r/better_claw` (discovered) | exists | free-API megathreads, `$0` agent setups |
| `r/hermesagent` (discovered) | exists | "run your agent for free and not hit rate limits" |
| `r/kimi` (discovered) | exists | Kimi free-tier in Kilo/OpenCode, Kimi Code CLI |
| `r/sambanova` (discovered) | exists | SambaCloud model launches (vendor-operated) |
| `r/ZaiGLM` (discovered) | exists | GLM-on-NIM free usage |
| `r/SillyTavernAI` (discovered) | exists | OpenRouter free-limit history (roleplay-skewed) |
| `r/LocalLLM` (discovered) | exists | NIM free key usage |
| `r/groq` | **not confirmed** | searches surfaced `r/grok` (xAI) instead; treat as unknown |
| `r/ClaudeAI`, `r/cursor`, `r/OpenAI`, `r/ChatGPT` | exists but out of scope | only used where a thread is specifically about free API access |

Two discovered adjacent subs are vendor marketing (`r/sambanova`) or framework-specific
(`r/hermesagent`, `r/openclaw`); their "free tier" posts are cited as first-hand user reports only.

---

## 1. What people actually use (ranked by frequency + reported success)

Ranking is a judgement from how often a provider/tool recurs across 2026 threads and whether the
author reported it working, not a measured frequency count.

### 1.1 Free hosted providers (ranked)

| Rank | Provider | Why it recurs | Evidence / date | Confidence |
|---|---|---|---|---|
| 1 | **Groq** | Fastest free inference; explicitly ships OpenCode/Kilo/Cline/Roo/Droid guides; no card | Groq docs rate-limits/coding page; `console.groq.com/docs/rate-limits` | verified |
| 2 | **NVIDIA NIM** (`build.nvidia.com`) | 40 RPM, 100+ models, no card; community built TUIs around it | r/LLMDevs "Is build.nvidia.com unlimited?" (2026-02-16); r/opencodeCLI "I configured OpenCode to use free AI APIs from 6 providers" (2026-07-02) | first-hand |
| 3 | **OpenRouter free (`:free`)** | Widest catalogue, one key; the default first step in many guides | r/hermesagent "How to run Hermes Agent for Free" (2026-05-30): "fastest to set up, best starting point" | first-hand |
| 4 | **Google (AI Studio / Gemini free tier → Antigravity)** | Free Flash lane and (until 2026-06-18) Gemini CLI OAuth 1,000 req/day | gemini-cli quota page; morphllm "Gemini CLI stopped serving … June 18, 2026" | verified |
| 5 | **Mistral Experiment** | ~1B tok/mo reported; Codestral/Devstral coding models; phone only | `help.mistral.ai` experiment-plan article; r/AI_Agents "Free-Tier AI Stack for 2026" (2026-05-10) | verified + first-hand |
| 6 | **Cerebras** | "fastest, 1M tok/day" narrative through H1 2026, then **changed** | `cerebras.ai/pricing` (2026-09-06): "$5 in free credits"; usagepricing.com (2026-07-21) | verified |
| 7 | **SambaNova Cloud Free** | 200K tok/day, open models, fast | `docs.sambanova.ai/docs/en/models/rate-limits`; r/sambanova | verified |
| 8 | **OpenCode Zen free models** | Zero-config free lane in OpenCode; model list rotates | `opencode.ai/docs/zen`; r/opencode "What are my free options?" (2026-05-06) | verified |
| 9 | **Kilo Gateway free / `kilo-auto/free`** | ~200 req/h/IP, free promos (StepFun, LongCat 2.0) | `kilo.ai/docs/gateway/...`; Kilo blog (2026-08-21) LongCat free | verified |
| 10 | **Roo Code Cloud free** | Free promo models (grok-code-fast-1, code-supernova) | `docs.roocode.com/providers/roo-code-cloud` | verified |
| 11 | **Cloudflare Workers AI** | 10K Neurons/day, strong data policy | `developers.cloudflare.com/workers-ai/platform/pricing/` | verified |
| 12 | **LLM7.io** | 1M tok/day free token, email only | `docs.llm7.io/limits` | verified |
| 13 | **Vercel AI Gateway** | $5/mo included credits, ZDR default | `vercel.com/docs/ai-gateway/pricing` | verified |
| 14 | **Requesty free** | "200 requests per day, no credit card" | requesty.ai/free-models | verified (vendor) |
| 15 | **Cohere trial** | 1,000 calls/month but **non-commercial** | `docs.cohere.com/docs/rate-limits` | verified |

Not-provider add-ons people mention: **free CLI tiers** — GitHub Copilot Free/Pro (usage-based from
June 2026), OpenAI Codex Go ~$8/mo and promotional free-plan windows, Google Antigravity free tier.
These are *not* API keys and sit outside Ferry's Auto-Free chain (they require a vendor harness or a
subscription).

### 1.2 Tools / harnesses (ranked by how often they appear in free-capacity threads)

1. **OpenCode** — free, OSS, 75+ providers, the default BYOK harness in most 2026 "free setup" threads
   (r/opencodeCLI; r/LLMDevs "Free Model List" lists "OpenCode is a popular, free, open-source AI
   coding agent").
2. **Cline** — OSS VS Code agent, "bring your own key", free without markup (pricepertoken Cline,
   dev.to review 2026-06-02). Note community caveat: free models often unsuitable for agentic work
   (r/AI_Agents "Cline will not work well with Free models", 2025-05-13).
3. **Kilo Code** — VS Code + CLI, free models + `kilo-auto/free`; heavily promoted on Reddit
   (r/kilocode).
4. **Roo Code** — Cline fork, model-agnostic, Roo Code Cloud free promos (r/RooCode).
5. **Aider** — terminal, model-agnostic, OpenRouter free onboarding since v0.80.0 (r/ChatGPTCoding,
   2025-03-31). Still run in 2026 but **no release tagged since v0.86.1** (morphllm, 2026-05-15).
6. **Qwen Code** — CLI; the **Qwen OAuth free tier was discontinued 2026-04-15** (Qwen docs). Alive
   only as a BYOK/paid-plan harness now.
7. **Gemini CLI** — **retired 2026-06-18** for individuals/free/Pro/Ultra, replaced by **Antigravity
   CLI** (r/GeminiAI "Gemini CLI is being retired", 2026-05-19; geminicli.com plans).
8. **Command Code / Freebuff / Mimo Code / Hermes Agent / OpenClaw / Pi / Kimi CLI / Continue.dev** —
   niche but recurring; Freebuff is notable for running ads to pay for a free CLI
   (r/vibecoding "Freebuff CLI (free models)", 2026-06-25; r/AI_Agents "free cuz they run ads in
   terminal", 2026-05-12).

### 1.3 Fallback / combo setups (the actual winning pattern)

- OpenCode Zen + free NVIDIA NIM + Groq + OpenRouter (r/opencodeCLI 2026-07-02, 6-provider config).
- "Groq + Cerebras combo depending on if you prioritize throughput or latency" (r/LLMDevs "Free Model
  List", 2026-03-21 — `Frosty-Judgment-4847`).
- OpenCode as main agent (free Zen + Go) with a second provider key as overflow (r/opencodeCLI "new/.rss").
- Kilo/Aider mixed-model recipe: "Orchestrator: Gemini 2.5 Pro … Code: Mistral Codestral (free
  through Mistral)" (r/kilocode "What's the best price per value mix of models?", `Thalioden`).
- Local routers to hide failover from the agent (see 1.4).

### 1.4 Free routers / gateways (self-hosted or free tier)

| Router | What it does | Evidence / date | Note |
|---|---|---|---|
| **FreeLLMAPI** | MIT self-hosted; "18 providers, 161 models, ~1.7B tokens/month" | r/coolgithubprojects (2026-07-08); free LLM API docs | community favourite |
| **quantum-free-router** | Bifrost pre-config: Gemini + NVIDIA NIM + OpenCode Zen + Kilo, auto-failover | r/hermesagent (2026-06); r/LocalLLM (2026-06-10) | first-hand |
| **OmniRoute** | "352 providers (150+ free), 1200+ models" | awesome-model-routing list | broad but unaudited |
| **9router** | "Unlimited FREE AI coding" across Claude/Codex/Cursor… | awesome-model-routing | marketing claim; **unknown** limits |
| **LiteLLM** | Load balancing, cooldowns, fallbacks; used to front free models for Claude Code | `docs.litellm.ai/docs/routing`; NVIDIA forum user (2026-07-07) | verified OSS |
| **MiniRouter / ClawRouter / Routerly** | self-hosted free-tier aggregators | r/SelfHostedAI, r/LLMDevs (2026-03) | first-hand |
| **Kilo Gateway / OpenCode Zen** | vendor gateways with free lanes | Kilo/OpenCode docs | see §4 router warning |

### 1.5 Promo / stealth models

- Kilo: **StepFun Step 3.5/3.7 Flash** free "for a limited time" (Kilo blog 2026-04-15), **LongCat
  2.0** free (Kilo blog 2026-08-21). Stealth model **Owl Alpha** was later revealed as LongCat-2.0
  (Meituan) — a confirmed example of "stealth model" speculation (r/kilocode "Best of the current free
  models?", 2025-10-24; Kilo blog).
- OpenCode Zen: rotating free/stealth models ("Big Pickle", Nemotron, MiMo, Hy3, Ling) with **no
  published limits** and limited-time labels (`opencode.ai/docs/zen`).
- Roo Code Cloud: free **grok-code-fast-1** (ex-`roo/sonic`) and **code-supernova** during promo
  (docs.roocode.com).
- OpenRouter: recurring stealth drops (e.g. `openrouter/elephant-alpha`, `openrouter/owl-alpha`)
  tracked by community list `cyclez2000/openrouter-free-models` and `openrouter-free-model.vercel.app`.

### 1.6 Student / startup / open-source credit programs

- Anthropic **Claude for Startups**: credits + "highest rate limits" for VC/accelerator-backed
  startups (claude.com/programs/startups). **Claude for Open Source** reportedly 6 months of Max 20x
  (secondary: resourify.com, 2026-03-02 — **rumor-adjacent**).
- Anthropic **free trial** $5 on phone verification (getaiperks.com, 2026-04-26 — secondary).
- Google: **$300 Cloud** credit standard; students get Google AI Pro bundles, but the API free tier
  is the same standard one (laozhang.ai, 2026).
- NVIDIA NIM: **no credit program** — free tier is rate-limited, and NVIDIA moderators state there is
  "no official way to … receive a rate limit increase on that same tier" (NVIDIA Developer Forums,
  2026-07-07).
- **Aggregator-sourced credit claims are frequently inflated.** Example: r/AI_Agents "Free-Tier AI
  Stack for 2026" (2026-05-10) claims "Gemini: Access 1.5B tokens/day" and "xAI Grok: Spend just $5
  and unlock $150/month" — both **unverified/marketing**; do not treat as reference numbers.

---

## 2. Real limits in practice vs advertised (dated)

Free tiers changed constantly in 2025-2026. Where official and community numbers differ, both are
given with dates.

### 2.1 Headline changes (timeline)

| Date | Change | Source | Class |
|---|---|---|---|
| 2025-09 | GitHub Models began retiring (fully retired 2026-07-30) | `docs.github.com/en/github-models/about-github-models` | verified |
| 2026-03 | Chutes free ended | OmniRoute FREE_TIERS refresh | secondary |
| 2026-04-15 | **Qwen OAuth free tier discontinued** | Qwen Code docs `docs/users/configuration/auth.md` | verified |
| 2026-06-18 | **Gemini CLI stopped serving free/Pro/Ultra individual accounts** → Antigravity CLI | geminicli.com; r/GeminiAI (2026-05-19) | verified |
| 2026-07-21 | **Cerebras free tier → $5 one-time Free Trial**, verified payment method required, expires 30 days | usagepricing.com; `cerebras.ai/pricing` | verified |
| 2026-08-17 | ZAI GLM 4.7 removed from Cerebras public rate card | usagepricing.com | verified |
| 2026-05-20 | Google cut Gemini free/prompt limits (community "up to 60%") | r/GeminiAI "The new limits are an absolute scam" / "Gemini just reduced prompt limits" | first-hand |
| 2026-09-03 | Gemini 3.8 Flash free tier = **20 RPD**; Flash-Lite 500 RPD | discuss.ai.google.dev thread 180609 | first-hand (dev forum) |

### 2.2 Provider-by-provider reality

**OpenRouter free (`:free`)**
- Official: 20 RPM; daily cap is tiered by credits bought (docs render the exact numbers as variables);
  making extra keys/accounts does **not** raise limits ("we govern capacity globally") —
  `openrouter.ai/docs/api/reference/limits`.
- Community (2025-2026): "50 requests per day" default → "$10 … 1000 requests/day" (r/openrouter
  "How does $10 OpenRouter work?", 2026-04-03). Aggregators in Aug/Sep 2026 show **200 RPD**
  (costgoat "OpenRouter Free Models", Sep 2026; freellmapi). **Verdict:** numbers moved repeatedly;
  treat as 20 RPM + a daily cap in the hundreds once verified ($10 threshold).
- Advertised "$0" has a hidden catch: free endpoints "can log prompts" and some are "only free to
  collect your prompts for training purposes" (r/openrouter "New to Openrouter, are free models truly
  free?", 2026-04-08).

**Groq**
- Official per-model free plan: e.g. `openai/gpt-oss-120b` 30 RPM / 1,000 RPD / 8K TPM / 200K TPD
  (`console.groq.com/docs/rate-limits`).
- Widely repeated "14,400 RPD" figure appears in secondary sources; measured reality is that **TPM is
  the ceiling** — "6,000 TPM on the small Llama" (ianlpaterson.com, 2026-05-31). Groq itself now
  publishes different TPM than that snapshot.
- r/better_claw `ShabzSparq` (2026): "By early afternoon, I hit the token wall."

**NVIDIA NIM**
- Free tier = **40 RPM**, no card; token/daily cap **not published**; context capped per model (e.g.
  Nemotron-3-Nano 131K, not 1M) (r/LLMDevs 2026-02-16).
- Reality for agents: "40 RPM runs out in 2-3 minutes during interactive sessions" (NVIDIA Developer
  Forums, 2026-05-11). Moderator: no free-tier RPM increase, deploy/pay for more (2026-07-07).

**Cerebras**
- Third-party pages still advertise "1,000,000 free tokens/day, no credit card"
  (pricepertoken.com/endpoints/cerebras/free) — **stale**. Cerebras' own pricing (verified 2026-09-06)
  says "$5 in free credits after making an account", credits expire 30 days after grant and require a
  verified payment method. OmniRoute issue #11773: "discontinued its free tier … expire after 30 days."

**Google / Gemini**
- API free tier is **per-model**: "Gemini Pro and flash-lite came back quota-zero on my keys" —
  `ianlpaterson.com` (2026-05-31). Flash-Lite historically high RPD; Flash low RPD.
- Gemini CLI free OAuth used to give 1,000 req/day across the model family; that path is gone.
- Dev-forum: "Gemini 3.8 Flash Free Tier 20 RPD Is Too Limited for Practical Evaluation" (2026-09-03).

**Mistral**
- Experiment plan: no card but **phone required**; documented limits are RPS/TPM/monthly; a secondary
  source estimates ~1 RPS and ~1B tokens/month (`help.mistral.ai`). Free tier is "intended for
  evaluation"; may be used to improve models unless opted out.

**SambaNova**
- Free: per-model **20 RPM / 20 RPD / 200K tokens/day** (`docs.sambanova.ai`). Build note: the 20 RPD
  cap binds long before tokens; a 2025 user reported "hit the free rate-limit after 3 messages"
  (r/singularity, 2025-02-14).

**OpenCode Zen**
- Official: free models are "available … for a limited time", no published limits, free lane rotates.
- Community/aggregator: `deepseek-v4-flash-free` at **20 RPM, 200 RPD** (freellmapi, 2026-09-24);
  third-party mirror claims **100 req/day** (opencode.asia — **unverified, not official**).
- First-hand failure: paid users still hit `FreeUsageLimitError` because the limiter is IP-based —
  GitHub `anomalyco/opencode` issues **#33318** (2026-06-22) and **#32971** (2026-06-19): "having a
  balance, it would be great if the balance is used against it."

**Kilo Gateway**
- ~**200 requests/hour per IP** for free models, anonymous allowed (`kilo.ai/docs/gateway/...`;
  freellm.net Kilo row). Free models and `kilo-auto/free` "may route your requests to providers that
  log prompts and outputs" (Kilo docs).
- Promo expiry is real: r/kilocode (2026) reported a model returning `404 "The free period of this
  model ended. Please use Kilo Auto Free to continue"`.

**Roo Code Cloud**
- Free is "available during promotional period only" and "prompts and completions are logged for model
  improvement" (`docs.roocode.com/providers/roo-code-cloud`). No published numeric limits.

**Cline**
- The extension is free/BYOK with no markup; "free models" are **limited-time promotions** for
  account holders (`docs.cline.bot/getting-started/free-models`). No standing free inference.

---

## 3. Pain points + workarounds

**P1. Rate limit mid-task.** The single most-reported problem.
- NVIDIA forum (2026-05-11): "I consistently hit 429 errors mid-session"; agents need "20-50 rapid calls".
- Workaround: multi-provider fallback routers. `quantum-free-router` author (r/hermesagent, 2026):
  "When one provider 429s, it automatically falls to the next. Your agent never sees the failure."
- Workaround: mode separation — use the free tier for planning/one-file edits, paid/strong model only
  to unblock. r/AI_Agents `anmarsalt` (2026): "you cannot keep using top-tier models for every task."

**P2. Tool-call failures on free models.** The reliability cliff.
- r/CLine "Cline API Error" (2025-12): "the model failed to generate valid output or returned tool
  calls that Cline cannot process."
- r/CLine "Cline tried to use write_to_file without value" (2026): "all top-tier paid models don't
  create a file with this error. However, free ones do."
- r/LocalLLaMA "Cline + Qwen3-Coder tool calling fix" (2025-09-17): needed a wrapper to translate
  formats.
- Workaround: native tool-calling APIs (Cline v3.35 migration), wrappers/proxies, prompt rules
  ("I edited the rules to give a guide to any model how to use the tools", r/CLine 2026).
- Measured cost of bad tool calls (Fireworks blog, 2026-05-20): Gemini 2.5 Flash had an **18.6% parse
  retry rate** vs Kimi K2.5 0.0%, GLM-5 0.6%, MiniMax M2.5 1.6% — "execution tax" matters more than
  headline coding score (`fireworks.ai/blog/agent-execution-tax`).

**P3. Silent deprecations / rotating catalogues.**
- Cerebras "pruned its free catalog … one day the call worked, the next it returned a 404"
  (ianlpaterson.com, 2026-05-31).
- OpenRouter free DeepSeek V4 Flash later "no longer free" (freellmrouter.com, last free 2026-05-31).
- Workaround: live model discovery, per-provider health checks, date-stamped catalogs
  (`cyclez2000/openrouter-free-models` daily update issues), and never hard-coding one free model.

**P4. "Free" that is really a trial or a promo.**
- r/better_claw `ShabzSparq` (2026): "Together.ai. $5 signup credit. Not a free tier. A trial."
- Kilo/OpenCode/Roo free lanes end without schedule.

**P5. Data use / training and privacy.**
- r/AI_Agents `please-dont-deploy` (2026): "free is not actually free in most cases… They are learning
  from your data. We use OpenRouter and our project is MIT/FOSS. Still using free models seems risky."
- Roo Code docs: prompts/completions logged for model improvement. Kilo Auto-Free may route to
  logging providers. OpenCode Zen stealth models may train; NVIDIA endpoints "trial use only — do not
  submit personal or confidential data" (OpenCode Zen docs).
- Broader 2026 concern: GitHub Copilot announced it would train on interaction data from Free/Pro/Pro+
  from 2026-04-24 unless opted out; OpenAI Codex on individual plans may train unless opted out
  (arize.com blog, 2026-08-20). Workaround: privacy-mode/opt-out, self-hosted router with `data_collection:
  "deny"`, or don't send secrets (Kilo docs recommend adding `data_collection: "deny"` to narrow providers).

**P6. OpenCode Zen's free limiter is IP-based even for paying users** (GitHub #33318/#32971) — a
workaround-shaped trap; the "fix" is a non-issue for Ferry (Ferry is not a gateway) but is a warning
that "free lane" and "paid balance" state can be conflated.

**P7. Quality gap vs paid for real repo work.**
- Real-SWE benchmark (thenewstack.io, 2026-09-14): the best agent still failed **>60%** of private-repo
  tasks. The New Stack headline: "AI's best coding agent fails 60% of the time."
- r/vibecoding `the_mosthated` (2026): free tiers handled single-file edits/refactors but not
  "reasoning over a large codebase at once."

---

## 4. Gray / risky practices and consequences

**These are documented for Ferry's warnings. They are never recommended and must not be implemented.**

**4.1 Account farming / multiple free accounts.**
- r/codex (2026-03-22) comment: "I can now easily switch between multiple free accounts and can
  basically Codex for free with no limits" — a public boast of the practice.
- OpenRouter explicitly neutralises it: "Making additional accounts or API keys will not affect your
  rate limits, as we govern capacity globally" (`openrouter.ai/docs/api/reference/limits`).
- OpenAI and others treat account farming/sharing as a ban trigger (dicloak.com guide, 2026-06-23):
  "Account farming, making batches of accounts on the same network, almost always ends in bans."

**4.2 OAuth reuse / piggybacking a subscription or free CLI login (the big 2026 ban wave).**
- Gemini CLI's own FAQ: "Using third-party software … to harvest or piggyback on Gemini CLI's OAuth
  authentication … direct violation" and "may be grounds for immediate suspension"
  (`geminicli.com/docs/resources/faq`).
- Google AI Developers Forum (2026-03-12): "Got banned from Antigravity for using OpenCode … This
  service has been disabled in this account for violation of Terms of Service."
- Consequences were real and hit **paying** users: a Google rep posted "We are currently rolling out a
  system-wide automated unban for all affected accounts" (forum, 2026-03-16); a paying Pro/Ultra user
  reported suspension with no third-party tool used, likely IP/region false-positive (GitHub
  `google-gemini/gemini-cli` issue #25685, 2026-04-20).
- Anthropic-side guidance: third-party apps using Claude subscription OAuth are "not permitted for
  third-party developers — use Anthropic API" (bswen.com, 2026-03-19).

**4.3 Web-session / cookie proxies.**
- e.g. `cyberanrhy/gemini-claude-web2api` — "OpenAI-compatible proxy for Gemini and Claude Web APIs …
  via cookie auth — no API key". This converts a consumer web session into an API. Vendor ToS treat
  this as unauthorised; sessions break on CAPTCHA/re-auth and accounts get flagged.
- OpenRouter/router catalogues list "Web cookie" wrappers as a category — the same ToS risk
  (`free-providers.md` §"Relays, scrapers").

**4.4 Sharing keys / public relay gateways.**
- Promo aggregators ("$200 free AgentRouter credits", r/LLM "Free $200 credits on agentrouter",
  2025-10-23) mix referral spam, expiry, and unclear data handling. Treat as **unknown** and do not
  route proprietary code there.

**4.5 The new-supply-chain risk: free routers themselves.**
- Paper "Your Agent Is Mine: Measuring Malicious Intermediary Attacks on the LLM Supply Chain"
  (UC Santa Barbara + Fuzzland), summarised in r/LLMDevs (2026): researchers bought **28 paid and 400
  free routers**; "9 were actively injecting malicious code, 17 stole AWS credentials, 1 drained a
  crypto wallet" (r/LLMDevs, 2026; helpnetsecurity.com, 2026-04-16). **Any third-party gateway in the
  request path can rewrite tool calls.**
- Consequence for Ferry: route only to first-party provider APIs or a gateway the user explicitly
  trusts; never silently insert a random free router.

---

## 5. Community-rated best free hosted models for coding with tools

Community signal here is thinner and noisier than provider signal. Treat rankings as directional.

**5.1 Models the community rates for free/cheap agentic coding (2026)**

| Model | Where it's free | Community signal | Confidence |
|---|---|---|---|
| **DeepSeek V4 Flash** | OpenCode Zen free (limited), NVIDIA NIM, Qwen/other hosts | r/openrouter "among free models" threads; freellmapi "strongest free models" | first-hand |
| **GLM 5.x / GLM 5.2 (free)** | OpenRouter `z-ai/glm-5.2:free`, Kilo, OpenCode Zen | r/opencodeCLI (2026-01-13): "while it's available for free, GLM 4.7 is the best option" | first-hand |
| **MiniMax M3 / M2.5** | OpenRouter `:free`, Kilo, OpenCode Zen | r/opencodeCLI "GLM5 and Minimax 2.5 free right now on zen. Both are great" (2026-02-23) | first-hand |
| **StepFun Step 3.5/3.7 Flash** | Kilo free promo | r/kilocode: "Stepfun is the fast workhorse. Good enough, it's so fast" | first-hand |
| **NVIDIA Nemotron 3 (Super/Ultra)** | NVIDIA NIM, Kilo, OpenRouter `:free` | r/openclaw "Recommended Free Models … NVIDIA | High … agent-centric" (2026-05-03) | first-hand |
| **Poolside Laguna M.1 / S / XS** | OpenRouter `:free` | r/openrouter "the most coherent IMO: poolside/laguna-m.1:free" (2026-05-26) | first-hand |
| **Gemma 4 31B (free)** | OpenRouter `:free` | lmmarketcap free-model #1 by composite score (2026-09-07) | secondary |
| **Qwen3 Coder** | OpenRouter `:free` (historically) | r/openclaw "Excellent for complex agent workflows" (2026-05-03); now often paid/deprecated | first-hand |
| **gpt-oss-120b / 20b** | Groq, NVIDIA, Cloudflare, Ollama Cloud, OpenRouter | Broadly the safest "reliable tool use" free option | verified + first-hand |
| **Kimi K2.5 / K2.6** | Promos (OpenCode Zen, NVIDIA, Kilo) | r/kimi "used kimi k2.5 with kilo code and loved it (when it was free)" | first-hand |
| **LongCat 2.0** | Kilo free promo | r/kilocode/Kilo blog; a 1.6T MoE "built specifically for agentic coding" | verified (vendor) |

Rumored/uncertain: stealth models (Owl Alpha → later confirmed LongCat 2.0; "Elephant Alpha"; "Polaris
Alpha") are treated by the community as free capacity but with unknown provenance until revealed.

**5.2 Community lists, spreadsheets and leaderboards (dated)**

| Resource | What | Date |
|---|---|---|
| r/LLMDevs "Free Model List (API Keys)" | Permanent free tiers only, no trials | 2026-03-21 |
| r/LLM "Awesome Free Models (API Keys)" | Same list, cross-posted | 2026-03-21 |
| r/AI_Agents "Here is the current Free-Tier AI Stack for 2026" | Survey-style, **includes inflated claims** | 2026-05-10 |
| r/better_claw "Every free LLM provider, ranked by how fast the free tier actually runs out" | First-hand burn-down test at ~800-1200 req/day | 2026 |
| r/openclaw "Free LLM APIs (April 2026 Update)" | 214-item free API list | 2026-04 |
| `github.com/open-free-llm-api/awesome-freellm-apis` | 134+/454+ free APIs, machine-readable, daily sync | 2026-09-06 |
| `freellm.net` / freellmapihub.com | Dated provider free-tier verification ("verified 2026-08-02") | 2026 |
| `github.com/nejib1/Free-LLM` | 34+ free APIs, base URLs, synced daily | 2026 |
| `github.com/cyclez2000/openrouter-free-models` | OpenRouter free-model change feed | 2026-04 |
| `openrouter-free-model.vercel.app`, `openrouter-free.vercel.app` | OpenRouter free-model browsers | 2026 |
| `costgoat.com/pricing/openrouter-free-models` | Free-model list + quality scores | Sep 2026 |
| `lmmarketcap.com/free-ai-models`, `/leaderboards/open-llm-leaderboard` | Free-model composite rankings | 2026-09 |
| **Kilo leaderboard** (`kilo.ai/leaderboard`) | Real usage share by mode (Code/Plan/Debug) — shows free models like `longcat-2.0-free`, `laguna-s-2.1`, `step-3.7-flash` in the top slots | 2026 |
| **OpenCode Data** (`opencode.ai/data/...`) | Token usage by model/lab | 2026-09 |
| **Artificial Analysis**, LiveCodeBench Pro, MCP Atlas, SWE-bench, Terminal-Bench, Aider Polyglot (`llm-stats.com`, `vals.ai`, `pricepertoken.com`) | Capability leaderboards (not free-tier specific) | 2026 |
| **RouterArena** / LLMRouterBench | Research leaderboards for *routers* | 2026 |

Caveat the community repeats: benchmark leaders are not the same as "free models that finish tool
loops." Fireworks' execution-tax data and the Real-SWE private-repo result both say advertised coding
scores overstate agentic reliability.

---

## 6. What users wish existed for free-tier coding

Recurring wishes, with representative sources:

1. **One endpoint that transparently fails over across every free pool, with quota awareness.**
   quantum-free-router author (r/hermesagent, 2026): agents "never see the failure." r/LLMDevs
   `Frosty-Judgment-4847`: best free setup is a combo, not one provider.
2. **Predictable, published limits that don't change silently.** The Cerebras/Google/Gemini CLI
   timelines (§2.1) are the community's core complaint; the whole genre of "free API list, dated"
   repos exists to compensate.
3. **Honest data-use labels per free model** so you can choose no-training lanes. r/AI_Agents
   `please-dont-deploy`: "free is not actually free in most cases."
4. **Tool-call reliability on free models** (format repair, native tool calling, retry accounting) —
   the most common practical complaint in r/CLine.
5. **Mid-task checkpoint / resume so a 429 doesn't lose the task.** Implied by every mid-session-limit
   report; explicitly what Hermes-agent-style routers try to hide.
6. **A budget-aware planner** that routes cheap models for the bulk and reserves a strong model to
   unblock. r/kilocode `Thalioden` mixed-model recipe; r/AI_Agents `anmarsalt`.
7. **A "free lane" that is actually free**, not a promotion ending without notice — r/kilocode `404
   free period ended`; OpenCode/Roo/Kilo limited-time labels.
8. **Student/OSS/hardship programs that are real** — r/AI_Agents `dbojan76` "how to use ai for free"
   (2026-07) documents the ad-hoc $300 Cloud / trial stacking the community resorts to.

---

## Implications for Ferry (ranked)

Current deterministic Auto-Free chain (`packages/router/src/auto-free-chain.ts:9`):
`gemini → groq → cerebras → mistral → sambanova → nvidia → openrouter → kilo`.

1. **Demote `cerebras` out of the recurring-free chain (highest priority).** Its free tier became a
   $5/30-day credit trial on 2026-07-21 with a **verified payment method required**
   (usagepricing.com; `cerebras.ai/pricing`). Re-tag `credits-only / caution` and remove it from the
   default free daytime chain, or keep it only behind an explicit opt-in. This matches the correction
   already proposed in `docs/research/free-providers.md`.
2. **Keep `gemini` first but bias to high-RPD Flash-Lite-class models.** The free Flash lane now
   advertises as low as 20 RPD for 3.8 Flash (dev forum 2026-09-03) while Flash-Lite is ~500 RPD. For
   agent loops, prefer the high-RPD variant patterns in the chain and avoid models whose RPD makes a
   single task impossible.
3. **Add OpenCode Zen as a new `promo` provider lane (caution).** Free models rotate with no published
   limits (`opencode.ai/docs/zen`), and the free lane has been fingerprinted to specific tool names
   (`docs/research/free-providers.md` §7). Add it *after* the stable first-party providers, labelled
   promo, and never as the sole free path.
4. **Add NVIDIA fan-out breadth / keep `nvidia` early for tool-capable models.** NIM gives 40 RPM
   across 100+ models with no card, and the community rates Nemotron/GLM/gpt-oss there for agents
   (r/opencodeCLI 2026-07-02; r/openclaw 2026-05-03). It is already in the chain — keep it and prefer
   its tool-call-capable models.
5. **Treat OpenRouter free as a fallback, not a default, unless the user has bought $10.** 20 RPM is
   fine but the default daily cap (tens) is unusable for agents; the $10 lifetime deposit lifts it to
   1,000 RPD (r/openrouter 2026-04-03; OpenRouter docs). Recommend Ferry detect credit status and
   surface it.
6. **Add Roo Code Cloud and Kilo free as optional promo providers, with data-use badges.** Roo logs
   prompts/completions for model improvement (docs.roocode.com) and Kilo Auto-Free may route to
   logging providers (kilo docs). Show a "free lane logs/trains" badge and exclude secrets.
7. **Warnings: OAuth reuse and account farming.** Add explicit UI/CLI warnings that using a Google
   Antigravity/Gemini CLI or Claude subscription OAuth from a third-party harness violates ToS and has
   caused mass suspensions even for paying users (geminicli.com FAQ; Google forum 2026-03-12; GitHub
   issue #25685). Publicly the community documents multi-account farming (r/codex 2026-03-22); Ferry
   must never implement it and should say why.
8. **Warnings: third-party free routers are a supply-chain risk.** Cite the UCSB/Fuzzland finding
   (28 paid + 400 free routers; 9 injected code; 17 stole credentials; 1 drained a wallet). Default
   Ferry routing to first-party provider endpoints; if a gateway is used, make it an explicit, named
   user choice with a warning.
9. **Default: data-use-safe free lanes and secret hygiene.** Prefer no-training providers (Groq —
   does not train on API data; Cloudflare — does not train on content; Vercel — ZDR default) and
   surface a per-provider training flag. Scrub obvious secrets from prompts on `caution` free lanes.
10. **Feature: checkpoint + resume around quota failures.** Implement the community's #1 wish: on a
    429/quota-exhausted mid-task, persist a resumable checkpoint and hand off cleanly to the next
    chain entry (the router already has cooldowns, reset hints and handoff briefings — wire checkpoint
    to quota events). This converts "agent stalls at 2pm" into "agent resumes when quota reopens."
11. **Feature: dated, self-refreshing free-tier catalog.** Free limits moved every few weeks. Keep
    the "last verified" date and a runner that re-verifies published limits quarterly, with an
    "unknown" state rather than a fabricated number. Mirror the community's dated-list discipline.
12. **Feature: per-step capability awareness already exists — extend to tool-call retry tax.** Prefer
    models with low parse-retry rates for tool-heavy steps (Fireworks execution-tax data: Gemini 2.5
    Flash 18.6% retries vs Kimi 0.0%, GLM-5 0.6%, MiniMax M2.5 1.6%). This directly reduces wasted free
    quota.

### Concrete chain recommendation (subject to re-verification)

```
gemini   (high-RPD flash-lite patterns first; keep low-RPD flash later)
groq     (qwen/gpt-oss, tool-capable)
nvidia   (tool-capable NIM models)
mistral  (codestral/devstral; caution: free-tier training)
sambanova(gpt-oss/DeepSeek; daily-request bound)
openrouter (only if credits bought; else fallback)
kilo     (promo; caution: may log)
opencode-zen (promo; caution: rotation + fingerprint)
cerebras (credits-only; opt-in, not default)
```

Rationale order = recurring free capacity × tool-call reliability × data-use safety, minus promos that
end without notice. Anything Ferry adds that is `promo`, `credits-only`, `caution`, or OAuth-based
must carry an explanatory badge and must not be presented as a stable free default.

---

## Source index (primary)

- OpenRouter limits: https://openrouter.ai/docs/api/reference/limits · https://openrouter.ai/blog/tutorials/kilo-code-openrouter/ (2026-06-17)
- Groq: https://console.groq.com/docs/rate-limits · https://console.groq.com/docs/coding-with-groq
- NVIDIA NIM: r/LLMDevs https://www.reddit.com/r/LLMDevs/comments/1r650o0/ (2026-02-16) · NVIDIA forums 2026-05-11 / 2026-07-07
- Cerebras: https://www.usagepricing.com/blueprint/activity/cerebras-2026-07-21-free-tier-credit-trial · https://cerebras.ai/pricing (2026-09-06) · https://github.com/diegosouzapw/OmniRoute/issues/11773
- Gemini CLI retirement: https://geminicli.com/plans/ · https://www.reddit.com/r/GeminiAI/comments/1ti10v6/ (2026-05-19) · morphllm "Claude Code Alternatives" (2026-05-15, updated)
- Gemini free limits: https://discuss.ai.google.dev/t/.../180609 (2026-09-03) · r/GeminiAI 1thkj1v (2026-05-20)
- Qwen Code auth: https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/auth.md
- OpenCode Zen: https://opencode.ai/docs/zen · GitHub issues #33318 (2026-06-22), #32971 (2026-06-19)
- Kilo: https://kilo.ai/docs/gateway/models-and-providers · https://blog.kilo.ai/p/longcat-20-is-free-in-kilo-for-a (2026-08-21) · r/kilocode 1sata07
- Roo Code Cloud: https://docs.roocode.com/providers/roo-code-cloud
- Cline: https://docs.cline.bot/getting-started/free-models · r/CLine 1pd8gep, 1pczyeg
- NVIDIA agent limits: https://forums.developer.nvidia.com/t/.../375953 (2026-07-07) · /369762 (2026-05-12)
- Router security: https://www.helpnetsecurity.com/2026/04/16/llm-router-security-risk-agent-commands · r/LLMDevs https://www.reddit.com/r/LLMDevs/comments/1sm6tc1/
- Free routers: r/coolgithubprojects 1ur9kdg (2026-07-08) · r/hermesagent 1u1wm1p · r/LocalLLM 1u1zv8u (2026-06-10)
- Google OAuth bans: https://geminicli.com/docs/resources/faq/ · https://discuss.ai.google.dev/t/.../131169 (2026-03-12) · https://github.com/google-gemini/gemini-cli/issues/25685 (2026-04-20)
- Cookie proxies: https://github.com/cyberanrhy/gemini-claude-web2api
- Community lists: r/LLMDevs 1s020se (2026-03-21) · r/AI_Agents 1t97zn9 (2026-05-10) · r/better_claw 1ue95bf · https://github.com/open-free-llm-api/awesome-freellm-apis (2026-09-06) · https://github.com/cyclez2000/openrouter-free-models/issues/19 (2026-04-18)
- Privacy/data use: https://arize.com/blog/ai-coding-agent-privacy (2026-08-20) · r/AI_Agents 1uld5bl
- Execution tax / real-SWE: https://fireworks.ai/blog/agent-execution-tax (2026-05-20) · https://thenewstack.io/real-swe-coding-benchmark/ (2026-09-14)
- Student/startup credits: https://claude.com/programs/startups · https://ai-credits.ai/free-api-credits

Where a source is an aggregator or marketing page it is labelled in the row. Unknowns remain "unknown."
