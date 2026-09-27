# FreeLLMAPI — router + hosted service research

**Research date: 2026-09-27.** Sources: repo `tashfeenahmed/freellmapi` (default branch `main`, commit `a0befbc`), website `freellmapi.co` (home, pricing, faq, about, terms, privacy, blog), GitHub issues API, Reddit, X, YouTube, and third-party review sites. Every claim is cited to a URL or `file:line`. Marketing-only claims are marked **claimed**; things I could not establish are **unknown**.

---

## 10-line plain-English summary

1. **What they offer:** an open-source, self-hosted, single-user OpenAI-compatible gateway ("router") that stacks the free tiers of ~34 providers behind one local `/v1` endpoint, plus a paid **data subscription** to keep its model catalog live.
2. **One key vs BYOK:** strictly **BYOK, local**. You add your own provider keys; they are AES-256-GCM encrypted in *your* SQLite DB. The "one key" is only a local `freellmapi-…` bearer token your apps use against your own machine — no pooled provider accounts, no resale.
3. **Why paid plans exist:** the *software* is free forever (MIT); the **catalog data** (which models are free this week, quotas, quirks) is the product. $19/yr or $49 lifetime buys same-day catalog updates instead of a ~30-day-delayed free snapshot. Nothing about routing is paywalled.
4. **Data handling:** prompts/completions/keys never touch their servers (privacy policy); only purchase records, license last-seen, and the signed catalog feed do. Processors: Stripe/Link, Resend, Cloudflare, Oracle Cloud, Hetzner.
5. **Legitimacy:** real, substantial, actively developed repo (~29k stars, 806 commits, 13 open issues); seller is **Neu Software LLC**; domain is young (registered 2026-06-10); no status page; **all sales final / non-refundable**.
6. **What users report:** basically **no independent paid-user evidence** found. Promotion is heavy self-posting + SEO + influencer/affiliate content; the one "team" Reddit post reads like marketing. No scam reports, but no verified refunds/support/uptime reports either.
7. **The 7.4B headline is marketing:** it is the *sum of declared per-model free-tier budgets* in the catalog, and grew 1.3B → 1.7B → 4B → 7.4B as providers were added; it counts promos/credits/trials and is not a measured allowance.
8. **Engineering is genuinely good:** Thompson-sampling reliability, four-window quota ledger with in-flight leases, cooldown provenance + probe recovery, sticky sessions, tool-rejection deferral, model-retirement corroboration.
9. **License:** MIT (root `LICENSE`), so Ferry may legally reuse the ideas/code with attribution.
10. **Verdict for Ferry:** borrow the *designs* (sticky sessions, Beta-posterior reliability with decay, headroom ramp, cooldown provenance, leases, model retirement) — do **not** copy the token headline or its catalog-counting optimism, and do not adopt a mandatory remote catalog as a core dependency.

---

## Part 1 — The hosted service (freellmapi.co)

### 1. What exactly do they sell?

Freellmapi.co sells **one thing: a "Premium" live model-catalog subscription**. It does *not* sell inference or API keys.

- Free tier: "The router is free forever — open source, self-hosted, no credit card." (https://freellmapi.co/pricing)
- Annual: **$19/year**, auto-renewing, tax included. Lifetime: **$49 once**, non-transferable, non-renewing. (https://freellmapi.co/pricing; https://freellmapi.co/terms §2)
- What Premium adds, per the pricing comparison table: "Model catalog — Free: Monthly snapshot, ~30 days behind | Premium: Live — updates the moment we ship them." Routing, failover, quota tracking and local key storage are "Included" on both. (https://freellmapi.co/pricing)
- The free-vs-premium delta is quantified as "**303 models ahead of free today**" (**claimed**, home page) and "a model joins [the free snapshot] 30 days after it lands in the live feed" (`README.md` "Premium (live catalog)").
- Terms §1: "Premium is a data subscription. A license key switches your FreeLLMAPI installation from the free catalog to the live catalog feed." (https://freellmapi.co/terms)
- There is **no usage quota, seat count, or inference allowance** tied to the plan; "One `fla_` key covers every router you run: desktop, homelab, Raspberry Pi." (README, "Premium")
- Payment: Stripe Managed Payments with **Link.com as merchant of record**; a "legacy USD checkout" exists where "Neu Software LLC is the seller." (https://freellmapi.co/terms §2)

### 2. One API key for all models? BYOK or pooled?

**BYOK, entirely local; there is no pooled provider key.** The "one key" is a local unified bearer token.

- "Provider keys are AES-256-GCM encrypted in SQLite and decrypted in-memory per request; your apps only ever see a single unified `freellmapi-…` bearer token." (README, "Features — Encrypted keys, one token out")
- "FreeLLMAPI is local-first and single-user by design. Your provider keys stay in your SQLite database, encrypted at rest, and requests go from your machine to the upstream providers you enabled." (README, "Works with OpenAI-compatible clients")
- "The catalog server never sees your prompts, completions, or provider keys — the router stays fully self-hosted either way." (README, "Premium (live catalog)")
- Architecture confirms the flow: "An Express proxy exposes `/v1/chat/completions` … the router selects the best healthy model … decrypts its upstream key in memory, and streams the response back." (`docs/en/architecture/00-high-level-index.md`)
- The only server-side artifacts are the **signed catalog feed** and **license validation** at `https://api.freellmapi.co` (`docs/en/architecture/05-catalog-sync.md` §3, §14: `CATALOG_BASE_URL` default `https://api.freellmapi.co`).

Therefore the "whose accounts / how many / ToS violation" concern **does not apply as written in the brief**: there is no pooling, no resale of provider quota, and the project explicitly instructs one account per provider. However, the project *itself* flags that a **single-user proxy in front of each provider is a ToS gray area**, reviewed provider-by-provider (May 2026):

| Provider | FreeLLMAPI's own verdict | Note |
|---|---|---|
| Cohere | ❌ Avoid | "Terms §14 still forbids *'personal, family or household purposes.'*" |
| Google Gemini | ⚠️ Caution | March 2026 ToS narrows scope to "professional or business purposes, not for consumer use." |
| NVIDIA NIM | ⚠️ Caution | Trial ToS §1.2/§1.4 "evaluation only, not production." |
| GitHub Models | ⚠️ Caution | Free tier scoped to "experimentation"/"prototyping." |
| Cloudflare, Z.ai | ⚠️ Ambiguous/Caution | general agreements / anti-traffic-redirect clause. |
| Groq, Cerebras, Mistral, OpenRouter, Zhipu, Ollama, OVH, AI Horde | ✅ Likely OK | wording permits personal/private single-user proxy. |

(Source: `docs/en/architecture/00-high-level-index.md` §"Terms of Service review"; rules of thumb: "one account per provider, no reselling, no sharing your endpoint with other humans, don't hammer a free tier as a paid production backend.")

**Why paid plans exist if the underlying tiers are free:** the $19/$49 is *not* a markup on free tiers — it funds maintaining the catalog data and delivers it live. "Premium exists because the free-tier landscape shifts weekly — it funds the catalog work and delivers it to you live instead of on a 30-day delay." (https://freellmapi.co/pricing). The repo says the same: "Premium is only the live feed, and it's what funds the daily model testing and catalog maintenance that keeps the catalog working." (README, "Premium")

### 3. Data handling

Privacy policy (https://freellmapi.co/privacy) states:

- "Your prompts, completions, and provider API keys are stored and processed locally on your device and are sent only to the AI providers you configure. They are never transmitted to, stored by, or visible to Neu Software LLC."
- Collected: purchase records (checkout email, license key, plan, billing status, Stripe IDs), license last-seen timestamps, cookieless Umami analytics on the website, and routine short-lived server logs (IP, user agent, path).
- Not collected: "No prompts, completions, model outputs, or provider API keys, ever." No ad trackers or cross-site cookies; card details handled by Stripe/Link.
- Processors: Stripe/Link, **Resend** (email), **Cloudflare** (hosting/DNS), **Oracle Cloud** (catalog + license server), **Hetzner** (self-hosted analytics).
- Retention: purchase/license records kept while a license can be active + tax/accounting requirements; server logs "kept for days, not months."
- No training on user data is claimed (nothing is collected to train on; upstream provider training is governed by each provider).

**Retention/logging inside the product** (relevant because Ferry is an agent emitting code): the router persists analytics and a **server log table** locally — `server_logs (level, source, provider, model, event, request_id, message)` (warn/error only) per `docs/en/architecture/02-quota-and-cooldown-engine.md` §9. Error bodies are **not** stored: "Only the number is kept — never the body — so nothing extra reaches logs or attempt traces." (`docs/en/providers/02-quotas-and-cooldowns.md` §"Back-off from headers and error bodies"). Response caching and idempotency store response bodies in the *local* DB (`docs/en/architecture/04-degraded-mode-and-failover.md` §10).

**Jurisdiction:** the seller is "**Neu Software LLC**" (https://freellmapi.co/terms §9, https://freellmapi.co/privacy). The **state/country of incorporation is unknown** — no jurisdiction or registered address is published; only an email (`support@freellmapi.co`). Managed checkout routes through Stripe/Link; legacy checkout names Neu Software LLC as seller. Governance law/venue is not stated. **unknown.**

### 4. Reliability / legitimacy signals

- **Repo scale (real):** ~29k stars, 4k forks, 806 commits, 13 open issues (GitHub repo page, fetched 2026-09-27). Active daily-ish merges; latest release PR `v0.12.0` merged 2026-09-24 (#1326).
- **Company:** Neu Software LLC (per terms/privacy). No public registry footprint verified; **unknown** where it is registered.
- **Uptime / status page:** **no status page found**; no published uptime or SLA. The only "status" link on GitHub is GitHub's own status. Terms §6 disclaims all warranties and says the catalog "is provided 'as is'."
- **Refunds:** **none, by policy.** Terms §4: "all purchases are final and non-refundable, except where a refund is required by applicable law," with an EU/UK withdrawal-waiver clause. Cancelling stops renewal but does not refund. Keys deactivate if a purchase is charged back.
- **Support:** email only (`support@freellmapi.co`); no ticket system or SLA.
- **Domain age:** `freellmapi.co` WHOIS registration 2026-06-10; Scamadviser rates it "Very Likely Safe / legit and reliable" but notes it is "(very) young" and low-ranked. (https://www.scamadviser.com/check-website/freellmapi.co)

### 5. What people say — especially after paying

**Summary: almost no independent, verifiable post-payment reports exist.** The signal is dominated by the author's own posts and SEO/affiliate content.

Verified / attributable:
- Author's own launch posts (self-promotion) on multiple subreddits: r/SelfHostedAI ("I made FreeLLMAPI that stacks the official free tiers of 18 LLM providers (161 models, ~1.7B tokens/month combined)", Jul 8 2026), r/LLMDevs, r/coolgithubprojects, r/LLM ("Has automatic fallback and Thompson Sampling", Jun 20 2026), r/Agentic_Marketing. These are author posts, not user reviews.
- Author on X (@tashfene): promotional posts describing FreeLLMAPI as an "open-source proxy," including "claude code stops hitting your monthly cap because every prompt routes through the 16 free pools." (https://x.com/tashfene)
- A third-party X post, likely affiliate/marketing: "34 free ai plans stacked into 7.4 billion tokens a month. it's called freellmapi." (https://x.com/DuncanRogoff/status/2093746016700743856)
- Influencer YouTube coverage: "4 Billion Free LLM Tokens… One API (FreeLLMAPI)" (Aug 20 2026) — a walkthrough, not an independent reliability test.
- Third-party write-ups: buildmvpfast.com hands-on (Jun 14 2026) — notes the headline was "~1.7B … 16 providers" then, and the real caveats ("your output quality has a time of day"); opentools.ai directory blurb; SourceForge mirror review page (no substantive reviews surfaced).

**Suspicious / likely astroturf (treat as marketing, not evidence):**
- r/smallbusiness "FreeLLMAPI gave my team one AI entry point before I had…" reads as a vendor-shaped narrative (mentions deploying via "Codex or Cursor," compares to "Portkey … more polished and commercial"), posted to a business subreddit with an SEO cadence. (https://www.reddit.com/r/smallbusiness/comments/1uln1qy/)
- r/learnmachinelearning comment "Try freellmapi.co (best in 2026)" — bare recommendation, no usage detail.

**Not found:** no Reddit/HN/x thread with a **paid** customer describing reliability, rate limits, support, refunds, or a ban; no HN submission or comment thread; no bbb/Trustpilot entity for FreeLLMAPI/Neu Software LLC; no scam accusation either. **The post-payment experience is effectively unverified — unknown.** (Searches performed: `site:reddit.com freellmapi`, `"freellmapi" Hacker News OR LocalLLaMA OR ChatGPTCoding`, `freellmapi legit or scam … complaint`, on 2026-09-27.)

**Caveat on testimonials:** the headline figures in third-party content vary wildly over time (1.3B → 1.7B → 4B → 7.4B; 16 → 18 → 27 → 34 providers), which is itself evidence that the number is a marketing aggregate rather than a measured service level (see §6).

---

## Part 2 — The open-source repo

### 6. Architecture, providers, limits data, and the 7.4B figure

**Architecture** (source: `docs/en/architecture/00-high-level-index.md`; `README.md`):

- Express proxy on `:3001` exposing `/v1/chat/completions`, `/v1/responses`, `/v1/messages` (Anthropic), `/v1/completions`, `/v1/embeddings`, `/v1/models`, plus images/video/speech/transcriptions and native Gemini `/v1beta` and Ollama NDJSON emulation.
- Components: `server/src/services/router.ts` (pick), `server/src/services/scoring.ts` (bandit math), `server/src/services/ratelimit.ts` (quota ledger), `server/src/services/health.ts` (key probes), `server/src/providers/*.ts` (one adapter per provider), `client/` (React dashboard), SQLite via `better-sqlite3` with AES-256-GCM envelope encryption.
- `server/src/lib/tool-call-rescue.ts` rescues plain-text tool calls into real `tool_calls`; tool requests only route to models declaring tool support.
- Desktop app (Electron), Docker image, CLI (`npx freellmapi setup-*`), and an MCP server on `/mcp`.

**Provider list and counts:**

- Website: "**605 models across 34 providers**" (**claimed**, https://freellmapi.co/). README: "34 free LLM providers. 635 free model endpoints" and "**474 model families**, 635 free provider/model endpoints (584 chat, 41 embeddings, 7 transcription, 3 video)" (**claimed**).
- The code's provider union is larger than the headline: `shared/types.ts` declares **45 platform members**, of which **43 are registered adapters + `custom`** (=44 registry entries), plus `sambanova` retained-but-unregistered (retired June 2026). (`docs/en/providers/01-supported-platforms.md` §Catalog)
- Named built-ins (from the same doc): Google Gemini, Groq, Cerebras, ElectronHub, Experiential Labs, Sail Research, B.AI, AnyAPI, AMD Radeon, NVIDIA NIM, Mistral, OpenRouter, GitHub Models, Cohere, Cloudflare Workers AI, Zhipu/Z.ai, Ollama Cloud, Kilo, Pollinations, LLM7, Hugging Face, OpenCode Zen, OVHcloud, Agnes AI, Reka, SiliconFlow, Routeway, BazaarLink, AINative, Aion Labs, Requesty, NavyAI, NaraRouter, SEA-LION, OrcaRouter, UnoRouter, xKiro, ModelScope, Baidu Qianfan, Volcengine Ark, LongCat, iFlytek Spark, AI Horde, + `custom`. Keyless: `kilo`, `ovh`, `aihorde`.
- Notable mismatches vs Ferry's own research: FreeLLMAPI still lists **GitHub Models** as a caution-tier platform and **Cohere** as "avoid" even after Ferry recorded GitHub Models as retired 2026-07-30 (`packages/catalog/data/limits/dead-github-models.yaml`) — a churn/timeliness gap in the catalog. It also carries many **relay gateways with unpublished limits** (OrcaRouter "intentionally unpublished limits," xKiro, UnoRouter, Routeway "~5 rpm observed vs 20 documented") that Ferry's `docs/research/free-providers.md:361–369` classifies as unverified relays.

**How limits data is maintained — static file vs live:**

- The **baseline** is bundled DB **migrations** (static), and a signed remote **catalog** supplies deltas. `docs/en/architecture/05-catalog-sync.md` §1, §11: "Bundled migrations remain the baseline"; the hosted catalog is "the live source of truth."
- Sync runs **twice daily (12h)** plus on boot: fetch `/v1/latest`, verify an **Ed25519 signature against a pinned public key**, apply **transactionally**, guarded by `MIN_CATALOG_VERSION` so a stale snapshot cannot roll back a newer binary. (§3, §5, §10)
- **Two tiers** (§1): free installs get a **monthly** snapshot (~30 days); Premium gets the **live** feed. §6: models older than 30 days from `generatedAt` are excluded from the live tier.
- User state is protected: catalog `enabled:false` force-disables, but `enabled:true` never re-enables a model the user disabled; user rows and tombstones win. (§4)
- Limits are additionally **learned from provider error bodies at runtime**: `parseProviderLimit()` / `learnLimitFromError()` "only tightens" (fills NULL or lowers) a model's TPM/TPD/etc. (`docs/en/architecture/02-quota-and-cooldown-engine.md` §5).
- The published catalog is built from the live DB by `server/src/scripts/export-catalog.ts` ("every model and its resolved quirks come straight out of the same SQLite DB the router uses"), output JSON is signed separately.

**The "~7.4B tokens/month" figure — how computed, and is it inflated?**

- The repo gives **no script or formula that computes it**. `export-catalog.ts` emits per-model `monthlyTokenBudget` (a *label*, e.g. `"1M"`, `"2x"`) and `limits {rpm,rpd,tpm,tpd}`, but never sums them; the headline lives only in prose/website copy.
- The README frames it as an **aggregate of *listed* free-tier capacity**: "they add up to roughly **7.4 billion tokens per month** of working inference capacity" and later "roughly 7.4 billion tokens per month of **listed free-tier capacity**." (README, "Why this exists" / "Premium"). The website hedges: "Within provider free allowances. Availability varies; promotions are temporary." (https://freellmapi.co/)
- The figure has **grown with the catalog, not with measured throughput**: early repo mirrors show "~1.3 billion" (11 providers) and "~1.7B … 16 providers"; a cached site description showed "340+ models across 27 providers, ~4 billion free tokens per month"; current is 7.4B / 34 providers. (E.g. `github.com/Ahmed-M-Abdelkader/freellmapi`, `github.com/alankolett/freellmapi`, https://www.scamadviser.com/check-website/freellmapi.co)
- **It counts non-recurring and promo capacity.** The catalog explicitly includes credit/trial gateways — ElectronHub ($0.25 shared weekly credits), Experiential Labs (500 shared monthly credits), Sail ($5/month while a payment method is attached), B.AI "0-credit promo," Reka (prepaid credits), NVIDIA (evaluation-only) — and passes promos through (`docs/en/providers/04-recurring-credit-gateways.md`; `docs/en/providers/01-supported-platforms.md`). Ferry's own `docs/research/free-providers.md:25–37` warns exactly against counting these.
- **Verdict: inflated / optimistic as a service-level number.** It is best read as "the sum of every catalog row's declared best-case monthly budget, including trials, credits and temporary promos, before any routing failure" — not as "\~7.4B usable tokens/month." The project is candid about the ceiling elsewhere: "what you don't get is *sustained* access … Budget for capacity and uptime, not for a capability limit" (`docs/en/architecture/00-high-level-index.md` §"Limitations"). The 30-day age gate is a reasonable staleness control, but it does not make credits recurring.

### 7. Routing internals

All from `docs/en/architecture/01-routing-and-bandit-scoring.md` (sources `server/src/services/router.ts`, `server/src/services/scoring.ts`) unless noted.

**(a) The 6 strategies.** Weights `(reliability, speed, intelligence)`; `base = w_rel·rel + w_speed·speed + w_intel·intel`, then `effective = base × headroomFactor × rateLimitFactor`.

| Strategy | Reliability | Speed | Intelligence |
|---|---|---|---|
| `balanced` (default) | 0.50 | 0.25 | 0.25 |
| `smartest` | 0.35 | 0.10 | 0.55 |
| `fastest` | 0.35 | 0.55 | 0.10 |
| `reliable` | 0.70 | 0.15 | 0.15 |
| `custom` | user-tuned, normalized | | |
| `priority` | manual order + 429 penalty | | |

(`§12`. There is a **separate** `KeySelectionStrategy` enum — `auto` | `least-remaining` — deliberately decoupled from the model strategy, `§8`, `§12`.)

**(b) Per-key RPM/RPD/TPM/TPD tracking.** A persistent ledger keyed `(platform, model, key)`, sliding minute for RPM/TPM and **UTC-day boundaries** for RPD/TPD, backed by a `rate_limit_usage` event table; plus **provider-wide pools** (OpenRouter `::free`, Google `::project`, NVIDIA `:credit-pool`, Groq `::account`, etc.). Also **in-flight leases** (`acquireLease`/`releaseLease`) so N concurrent requests cannot each read the same pre-check and collectively exceed a cap. Quotas are *learned* from error bodies (only tightened). (`docs/en/architecture/02-quota-and-cooldown-engine.md` §2, §5.)

**(c) Live speed/capability/reliability scores.**
- **Reliability** = Thompson sampling from Beta posteriors over decay-weighted success/failure counts: 7-day window, **2-day half-life** (`weight = 0.5^(age_days/2)`), `α = successes + community_successes + 1`, `β = failures + community_failures + 1`; live routing samples `Beta(α,β)`, dashboard shows `α/(α+β)`. **Persisted** via analytics buckets; **decay** via the half-life. Timeouts count as reliability failures. An opt-in community prior (capped at 50 effective samples) and an opt-in 10% exploration floor exist. (`§3`)
- **Speed** = `0.6·throughputScore + 0.4·ttfbScore`, `throughputScore = 1 - exp(-tok/s/60)`, TTFB linear ramp 300ms→1.0 … 5000ms→0.0; no samples ⇒ prior 0.6; timeouts contribute zero tokens but full wall-clock to the denominator. Every 10 min, models with ≥20 samples have observed speed written back to the catalog `speed_rank` scale. (`§4`)
- **Intelligence** = `tierValue*1000 - sqrt(rank)*31` (Frontier/Large/Medium/Small), min-max normalized across the chain. (`§5`)
- **Capability** gating: vision, tools, sticky, group, `response_format` filters are applied in `routeRequest`; tool-carrying requests are steered and observed (see (f)).
- **Guardrails (never reorder good models, only demote):** headroom factor over `monthly_token_budget × usableKeyCount`; rate-limit penalty factor `1 - (penalty/10)*0.6`; **rate-window headroom factor** from live RPD/TPD/RPM/TPM utilization (5s memoized snapshot); combined as `min(monthlyHeadroom, windowHeadroom)`. Optional **peak-hours** reweighting moves 60% of the speed weight onto reliability during operator-declared peaks (opt-in, off by default). (`§6`)
- **Per-key** selection: `keyScore = 0.75·keyReliability + 0.25·keySpeed`, falling back to round-robin below 2 measured keys. (`§8`)

**(d) Sticky sessions (30 min).** "Key = SHA-1(first user message [:: strategyKey]), TTL 30 min. Prevents mid-conversation model switches → hallucination spike." With session-affine reasoning-trace memory to restore `reasoning_content` stripped by clients on replay. (`§10`)

**(e) Failover triggers.** A shared `lib/fallback-loop.ts` drives all surfaces: **max 20 retries**, **wall-clock budget default 45s**, mid-attempt **hedging** via `abortInFlight()` (an `AbortController`) once the budget expires, and an optional circuit breaker (`max_consecutive_upstream_fails`, default off ⇒ 503 `upstream_unhealthy`). Failure classification (`docs/en/architecture/01-...md` §9; `04-degraded-mode-and-failover.md` §5):

| Error | Skip scope | Cooldown | Penalty |
|---|---|---|---|
| 401 invalid key | key | 5 min (health cycle) | no |
| 402 payment required | key, all models of platform | 24 h | no |
| 403 model forbidden | model | 24 h | no |
| 429 daily exhausted | model+key | until UTC midnight / Retry-After | heavy (3) |
| 429 transient (rpm/tpm) | key | 90 s / escalation ladder | light (1) |
| 5xx / timeout / transport | platform | 90 s / ladder | light (1) |
| empty completion (reasoning) | key | exempt (streak ≤3) | no |
| context too large / `response_format` ignored / invalid tool args | model/key | — | no |

Cooldowns carry a **source** (`heuristic` | `authoritative` | `credit` | `tier`); escalation ladder 2 min → 10 min → 1 h → 24 h; unknown-limit guesses capped at 10 min; local endpoints capped at 5 s; a **cooldown-probe** job (60 s) re-validates keys and clears *heuristic* cooldowns early (never `authoritative`/`credit`/`tier`). Degraded-mode state machine flips off bandit exploration when the healthy-provider ratio stays <0.5 (`04-...md` §1). (`docs/en/architecture/02-...md` §4, §6.)

**(f) Tool-calling capability handling.** Declared `supports_tools` is checked at route time; where models emit tool calls as plain text, `tool-call-rescue.ts` repairs them. Observed rejections are remembered by `server/src/lib/tool-capability.ts`: **3 distinct requests** rejecting a tool-carrying request within 1 h ⇒ the model is **benched for tool requests for 6 h** (`TOOL_REJECTION_LIMIT = 3`, `TOOL_BENCH_MS = 6h`) — a soft preference, "never a filter" (still tried last), cleared on a successful tool call. This directly addresses FreeLLMAPI's own bug #1230 (Auto mode "walks the same dead chain on every tool request").

**(g) Model churn handling.**
- **Signed catalog sync** (twice daily) adds/removes models, adjusts quotas, ships quirks; model-age gate (30 days) for the free tier; tombstones preserve user deletions. (`05-catalog-sync.md`)
- **Auto-retirement** (`server/src/services/model-retirement.ts`): a definitive end-of-life response disables the model immediately; a "probable" one requires **2 distinct requests within 1 h** before acting (`RETIREMENT_CONFIRMATIONS_REQUIRED = 2`), reversible by the user or by a later catalog listing. (Issue #634 context: NVIDIA 410 "end of life.")
- **Unified model groups** collapse the same logical model across providers into one `/v1/models` entry and fail over strictly within the group (`match_tier` prevents silent substitution). (`01-...md` §11; `server/src/services/model-listing.ts`)

### 8. Known issues where it breaks (GitHub issues)

GitHub issues API, `state=all`, fetched 2026-09-27: the first 100 entries = **29 issues + 71 PRs**; repo page shows **13 open issues** total. Genuine bug/failure reports (verified from the API bodies):

- **#1334 (open)** — Gemini `400 … GenerateContentRequest.tools[0] … missing field` with Claude Code: nested tool-array schemas Claude Code emits are forwarded to Gemini without sanitization. Agent + tool-schema seam.
- **#1248 (closed)** — Sail: every request with tools fails `400 … not supported with completion_window=asap`; all listed Sail models affected. (Native-provider seam.)
- **#1239 (closed)** — "All rejected … stopped early: retry time budget 45s exceeded"; unstable results, tool calling across MCPs rarely works.
- **#1277 (closed)** — (translated) "failures are terminal, cannot fall back to other models" — a reported chain-not-falling-back complaint.
- **#1270 (closed)** — desktop "Update available" for untagged commits with no installer.
- **#1250 (closed)** — desktop web UI inaccessible; first-run account prompt not shown.
- **#1249 (closed)** — OpenCode free models unusable ("only inside OpenCode"), which the project then disabled in the catalog (403 FreeTierError).
- **#1298 (closed)** — Septor Labs & CLōD key validation 403 (Cloudflare bot challenge).
- **#1327 (open)** — licensed install reports Speechify key "no models in your current catalog yet" (the 30-day catalog lag biting a paying user).
- **#1230 (closed)** — Auto mode "hangs" when quota is exhausted and requires manual disable.

A large fraction of the tracker is **non-English/empty spam issues** (#1313, #1315, #1304, #1294, #1289, #1300…), so issue-count signals are noisy. PR titles show 29 bug-fix PRs in the sampled window, with recurring seams around **keyless/custom auth** (#1331/#1332), **quota sharing** (#1328), and **catalog lag** (#1329/#1327). (Full list: `github.com/tashfeenahmed/freellmapi/issues`.)

### 9. License — what Ferry can reuse

Root `LICENSE` is the standard **MIT License, Copyright (c) 2026 Tashfeen Ahmed** (`LICENSE`; also `cli/LICENSE`). MIT permits copying, modification, and reuse **with attribution and the license text**. There is no `enterprise/`-style carve-out, and (unlike Ferry's notes on Mirrowel) no LGPL library inside. **Ferry may reuse the limits/provider data and the scoring code under MIT, with attribution.** The *catalog data served by freellmapi.co* is a separate paid data product — do not scrape `/v1/latest`; derive any catalog from the MIT repo and public provider docs.

---

## Part 3 — For Ferry

### 10. Comparison and concrete recommendations

**Basis:** Ferry's router is `packages/router/src/index.ts` (`scoreModels` :273–399, weights :349–359, `onStepError` :620–627, `BUILTIN_PROFILES` :136–177, `buildBriefing` :651–728); Ferry has *already* adopted several ideas from `docs/research/routing-comparison.md` §12 — `packages/router/src/index.ts:23–36` re-exports `classifyProviderError`, `ResilienceLedger`, `reorderByCapabilities` from `./resilience.js`, and `StepError.kind` (:600–614) already carries `rate_limit`, `quota_exhausted`, `auth`, `model_not_found`, `tools_unsupported`, `context_overflow`, `content_filter`, `timeout`, `request_scoped_client`, `stream_failure`. Ferry's catalog is `packages/catalog/data/limits/*.yaml` (schema `packages/catalog/src/index.ts:37`) + `packages/catalog/data/models.snapshot.json`. FreeLLMAPI is **not** covered by `routing-comparison.md` (it is a new entrant relative to that doc).

**What FreeLLMAPI has that Ferry's catalog lacks (verified-free + coding-capable only):** very little of the *good* stuff. Ferry already carries the strong recurring tiers — `google/gemini`, `groq`, `mistral`, `cloudflare-workers-ai`, `sambanova`, `llm7`, `huggingface`, `kilo`, `opencode`, `openrouter`, `ovhcloud`, `nvidia`, `cerebras` (corrected), `vercel-ai-gateway`, `tokenrouter`, `anyapi`. FreeLLMAPI's *extra* providers are mostly weaker or riskier:

| FreeLLMAPI provider | Ferry status | Assessment |
|---|---|---|
| Cohere (trial) | absent | FreeLLMAPI's own ToS review says **❌ Avoid** ("no personal/household"). Skip. |
| Ollama Cloud (free plan) | absent | Plausibly free (1 concurrent, 5-h sessions); Ferry has no `ollama-cloud.yaml`. Worth a verified look, but 1 concurrent is poor for agents. |
| AI Horde (keyless) | absent | No tools, queue-based, no streaming — not coding-capable. Skip for the agent lane. |
| ModelScope / Qianfan / Volcengine / LongCat / iFlytek | absent | China real-name/KYC gates; recurring but not reliably accessible. Optional only. |
| Requesty / NavyAI / Nara / SEA-LION / OrcaRouter / UnoRouter / xKiro / AINative / Aion | absent | Relay gateways with **unpublished/observed-lower limits**; Ferry's `free-providers.md:361–369` already classifies these `skip/unknown`. Do not add as defaults. |
| ElectronHub / Experiential / Sail / B.AI / Agnes / Reka / SiliconFlow / Routeway | mixed | Credits/promos, not recurring free. FreeLLMAPI counts them in its token total; Ferry should not. |
| GitHub Models | Ferry marks **dead** (`dead-github-models.yaml`) | FreeLLMAPI still lists it caution-tier — evidence FreeLLMAPI's catalog is not always fresher. |

So the value is **not the provider list; it is the routing engineering**. Ranked, concrete recommendations:

1. **Adopt sticky sessions (30 min, keyed by first-message hash).** FreeLLMAPI `01-...md` §10: SHA-1(first user message `[:: strategyKey]`), 30-min TTL, to stop mid-conversation model switches causing hallucination spikes, plus reasoning-trace restoration. Ferry's `scoreModels` already gives a small `affinity` term (:347–348) but has no cross-request stickiness. Ferries as a `previousModelRef`/session pin in `@ferry/router`. **High value, low risk.**
2. **Adopt decay-weighted Beta-posterior reliability (Thompson sampling).** Replace/augment Ferry's coarse `success` ratio (`index.ts:332–335`) with `α = successes + 1`, `β = failures + 1`, 7-day window, **2-day half-life**, sampling `Beta(α,β)` at route time and `α/(α+β)` for the dashboard (`01-...md` §3). This is strictly better exploration than a point estimate and is the single biggest quality upgrade available. **High value, medium effort** (needs persisted per-model/per-key outcome buckets in `@ferry/storage`).
3. **Adopt per-key/per-model quota *leases* (in-flight reservations) and provider-wide pools.** FreeLLMAPI `02-...md` §2: `acquireLease/releaseLease` close the check-then-act race when N concurrent requests share a key; provider-wide pools stop `(models × rpd)` fan-out 429s. Ferry's `CapacityView.tokensPerMinuteRemaining` (`index.ts:39–47`) is read-only and has no in-flight reservation. **High value for parallel agent steps.**
4. **Adopt cooldown *provenance* + probe recovery.** Tag each cooldown `heuristic|authoritative|credit|tier` and only early-probe the heuristic ones (FreeLLMAPI `02-...md` §4, §6). This is the clean fix for the "blacked out for hours" class already documented in `routing-comparison.md` §12 items 2–4 and §13; Ferry's `ResilienceLedger` likely needs the provenance dimension. **High value.**
5. **Adopt the headroom *ramp* guardrail (graded demotion, not binary).** FreeLLMAPI `01-...md` §6: `factor = floor + (1-floor)·(remaining/rampStart)`, defaults rampStart 0.2 / floor 0.1, applied to both monthly budget and live RPD/TPD/RPM/TPM utilization, combined as `min(...)` (never the product). Ferry hard-filters on TPM/context (`index.ts:327–330, 442–497`) but does not *demote* a model approaching its cap — so it stays #1 until the request that 429s. **Medium-high value, small effort.**
6. **Adopt observed tool-rejection deferral.** FreeLLMAPI `tool-capability.ts`: 3 tool-request rejections in 1 h ⇒ defer the model for tool requests 6 h, cleared on success — a *soft* preference, never a hard filter. Ferry currently *drops* tool-less models at `index.ts:307,444–445`; `routing-comparison.md` §12 item 6 already argues for reorder-not-drop. FreeLLMAPI gives the exact "observed, not declared" mechanism. **Medium value.**
7. **Adopt model-retirement corroboration.** FreeLLMAPI `model-retirement.ts`: definitive EOL ⇒ disable; probable ⇒ require 2 distinct requests in 1 h; reversible. Complements `routing-comparison.md` §12 item 7 (lifecycle) with a concrete, false-positive-resistant rule. **Medium value.**
8. **Consider (optional) peak-hours reweighting and observed-speed writeback.** Both are opt-in and well-argued (`01-...md` §4, §6), but they add clock-dependent behavior; keep off by default like FreeLLMAPI does. **Low-medium value.**
9. **Prompt compression** (dedup, tool-output filter, stale-context trim, fail-open) exists as a whole sub-system (`docs/en/compression/01-compression-pipeline.md`) — relevant to Ferry's optimizer package; study, don't port blindly. **Low-medium value.**

**Ideas to explicitly avoid:**

- **The "~7.4B tokens/month" headline and any catalog-row token summing.** It counts promos/credits/trials and grew with provider count (1.3B→7.4B). Ferry's `docs/research/free-providers.md:25–37, 342–345` already warns against this; `routing-comparison.md` §13 explicitly lists "Fabricating a token headline" as an idea to avoid. Keep Ferry's honest catalog.
- **Counting relay gateways with unpublished limits toward "free capacity"** (OrcaRouter/UnoRouter/xKiro/etc.). FreeLLMAPI does; Ferry's existing classification says no.
- **A mandatory hosted/signed catalog as a core routing dependency.** FreeLLMAPI's premium value *is* the remote catalog; Ferry is local-first (`AGENTS.md`, `ARCHITECTURE.md`) and must not make routing depend on a vendor feed. A signed, optional, self-hostable catalog is fine (FreeLLMAPI itself supports `CATALOG_BASE_URL`/`CATALOG_PUBKEY` overrides — `05-catalog-sync.md` §3).
- **Multi-account/provider pooling.** FreeLLMAPI *doesn't* do this — good — and Ferry must not either (`routing-comparison.md` §13; `AGENTS.md`).
- **Treating catalog staleness (`enabled:false` etc.) as authoritative without a user override.** FreeLLMAPI's rules (force-disable, never re-enable user-disabled, tombstones) are actually a *good* pattern to copy; the anti-pattern is the reverse (silently re-enabling or deleting user state). Adopt the safeguards.

**Bottom line for Ferry:** FreeLLMAPI is a strong *design reference* and MIT-licensed, but it is **not** a source of new verified free capacity, and its headline metric is marketing. Ferry should mine `server/src/services/scoring.ts`, `ratelimit.ts`, and `model-retirement.ts`/`tool-capability.ts` for the six mechanisms above (sticky sessions, bandit reliability, leases+pools, cooldown provenance, headroom ramp, observed tool/retirement signals), and ignore the provider-count and token-count claims.

---

## Citation index

**Website / hosted service**
- https://freellmapi.co/ (home: 605 models/34 providers/7.4B; premium pitch)
- https://freellmapi.co/pricing · https://freellmapi.co/faq · https://freellmapi.co/about · https://freellmapi.co/blog
- https://freellmapi.co/terms (Neu Software LLC; $19/$49; non-refundable; Link merchant of record)
- https://freellmapi.co/privacy (local-only prompts/keys; processors)
- https://www.scamadviser.com/check-website/freellmapi.co (domain age 2026-06-10; cached older copy "27 providers, ~4 billion")

**Repo `github.com/tashfeenahmed/freellmapi` (main, a0befbc)**
- `README.md` · `LICENSE` · `shared/types.ts`
- `docs/en/architecture/00-high-level-index.md` (overview, limitations, ToS review)
- `docs/en/architecture/01-routing-and-bandit-scoring.md` (strategies, scoring, sticky, fallback, tools)
- `docs/en/architecture/02-quota-and-cooldown-engine.md` (windows, leases, cooldown ladder, limit learning, probe)
- `docs/en/architecture/04-degraded-mode-and-failover.md` (degraded mode, retry budget, classification)
- `docs/en/architecture/05-catalog-sync.md` (signed catalog, tiers, age gate, application rules)
- `docs/en/providers/01-supported-platforms.md` (45-member union, 43 adapters, per-provider notes)
- `docs/en/providers/02-quotas-and-cooldowns.md` (windows, pools, back-off parsing)
- `docs/en/providers/04-recurring-credit-gateways.md` (ElectronHub/Experiential credit pools)
- `server/src/scripts/export-catalog.ts` · `server/src/services/model-retirement.ts`
- `server/src/lib/tool-capability.ts` · `server/src/services/model-listing.ts`
- Issues: `https://github.com/tashfeenahmed/freellmapi/issues` (29 issues / 71 PRs in first 100; 13 open)

**Third-party / social (news & post-payment signal)**
- Reddit: r/SelfHostedAI post (author, 18 providers/1.7B, 2026-07-08); r/smallbusiness "FreeLLMAPI gave my team…" (likely marketing); r/LLMDevs; r/coolgithubprojects; r/LLM; r/learnmachinelearning comment.
- X: https://x.com/tashfene (author) · https://x.com/DuncanRogoff/status/2093746016700743856 (affiliate-style)
- YouTube: "4 Billion Free LLM Tokens… One API (FreeLLMAPI)" (2026-08-20)
- buildmvpfast.com blog (hands-on, 2026-06-14) · opentools.ai directory blurb · SourceForge mirror reviews (none substantive)

**Ferry (local)**
- `packages/router/src/index.ts:23–36, 136–177, 273–399, 600–627, 651–728`
- `packages/router/src/resilience.ts` (via re-exports at `index.ts:23–36`)
- `packages/catalog/data/limits/*.yaml` (+ `dead-*.yaml`) · `packages/catalog/src/index.ts:37` · `packages/catalog/data/models.snapshot.json`
- `docs/research/free-providers.md:25–37, 46–71, 342–369` · `docs/research/routing-comparison.md:1019–1154`
