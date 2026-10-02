# New API vs Ferry — research

Read-only research. Captured **2026-10-02**. No repository files were modified except this report.

Primary sources:
- Website: <https://www.newapi.ai/en>
- Docs: <https://docs.newapi.ai/en/docs>
- Repo: <https://github.com/QuantumNous/new-api> (upstream of this fork: <https://github.com/songquanpeng/one-api>)
- Raw source under `main` (fetched via `raw.githubusercontent.com` / GitHub contents API).
- Ferry sources: `docs/STATUS.md`, `docs/ARCHITECTURE.md`, `docs/GATEWAY.md`, `docs/PROVIDERS.md`, `packages/gateway`, `packages/providers`, `packages/router`, `packages/quota`, `packages/core`, `packages/oauth`, `packages/catalog`.

**Headline verdict.** New API is a mature, multi-tenant, self-hosted *relay/aggregation gateway*: it puts many upstream providers behind one endpoint and administers keys, users, pricing, and routing. It is **not** a free-tier-first coding router — it has no notion of free-tier discovery, quota-window learning, or auto-free chains, and it assumes the operator has lawfully provisioned paid channels. Ferry's free-first routing, quota ledger, handoff, and paid guardrails are its differentiators and largely **not present** in New API. The valuable parts for Ferry are a handful of *routing/channel* and *protocol-conversion* ideas, above all multi-key channels, model mapping, per-channel param overrides, and the four-way protocol conversion matrix. Because New API is **AGPL-3.0** and Ferry is **MIT**, none of its code is reusable in Ferry; only ideas and behavior can be copied.

---

## 1. What New API is

### 1.1 Identity and purpose
New API is "a self-hosted AI gateway for applications, agents, and teams" that connects upstream model services and exposes a consistent API, with routing, access, usage, and cost management (<https://github.com/QuantumNous/new-api#-project-description>, <https://www.newapi.ai/en>). It is a fork of One API (MIT) and is aimed at team/organization-private deployment, including public generative-AI service operators (README warning re: filing/licensing obligations). It is explicitly a multi-user SaaS-style system, not a personal coding agent.

### 1.2 Architecture and stack
- Backend: **Go + Gin**; frontend web console: **React 19 + TypeScript + Rsbuild + TanStack + Tailwind CSS 4**, with **Bun** for frontend deps (<https://github.com/QuantumNous/new-api#development-and-extensions>). An **Electron** desktop wrapper exists in `electron/`.
- Persistence: **SQLite / MySQL ≥ 5.7.8 / PostgreSQL ≥ 9.6**; optional **Redis** for shared rate limits/caching; optional separate log DB incl. **ClickHouse** (`LOG_SQL_DSN`). Single-node default uses SQLite out of the box (<https://github.com/QuantumNous/new-api#storage-and-configuration>).
- **RelayKit** (`relaykit/`, a separate Go module, Go ≥ 1.25.1) owns protocol DTOs and request/response/stream conversion between OpenAI Chat, OpenAI Responses, Claude Messages, and Gemini. It intentionally contains no HTTP server, upstream sending, channel selection, auth, billing, or DB (<https://raw.githubusercontent.com/QuantumNous/new-api/main/relaykit/README.md>).
- Backend layout (README): `router/`, `middleware/`, `controller/` = HTTP/access/handlers; `relay/` = upstream adapters and request routing; `service/`, `model/` = business logic and persistence; `plugins/tasks/` = JS task plugins.

### 1.3 License (exact)
- Repository license: **GNU Affero General Public License v3.0 (AGPL-3.0)** — the `LICENSE` file is the verbatim AGPLv3 text (<https://raw.githubusercontent.com/QuantumNous/new-api/main/LICENSE>).
- **Additional terms under AGPLv3 Section 7** apply (README "📜 License"): modified versions must preserve the attribution notice `Frontend design and development by New API contributors.` in legal/about/footer/attribution locations, and any modified version presenting a UI must keep a visible link to <https://github.com/QuantumNous/new-api>. The upstream One API base is MIT. The project offers commercial licensing to organizations that cannot accept AGPLv3 (`support@quantumnous.com`).
- **Reuse implication for Ferry: ideas only, not code.** Ferry is MIT (`package.json` `"license": "MIT"`, root `LICENSE`). Copying any New API/RelayKit source into Ferry would make the combined work AGPL-3.0 (and network-source obligations under §13 would attach to Ferry's Gateway, which is served over a local network interface). Reimplementing behavior from the docs/source is the only safe path. All ranked ideas below are therefore **idea-only**.

### 1.4 Maturity (captured 2026-10-02)
- **~49.2k stars, ~11.8k forks, 6,474 commits, 736 open issues, 619 open PRs** (GitHub repo page). The marketing site says "40K+ Stars / 30+ Model Providers / 500+ Releases".
- **Release cadence is very high**: latest `v1.0.0-rc.41` published 2026-09-30; `v1.0.0-rc.40` 2026-09-21; `v1.0.0-rc.39` 2026-09-20 (GitHub Releases API). Multiple releases per week in active periods. Still named `1.0.0-rc.*` (not GA).
- Active translation/documentation and a plugin marketplace; continued shipping of new channels and Responses/WebSocket work (release notes).

---

## 2. Feature-by-feature comparison vs Ferry

Legend: **✅ has** · **🟡 partial** · **❌ missing**. Ferry citations are `file:line`; New API citations are paths/URLs.

### 2.1 Core comparison

| Capability | Ferry | New API | Notes |
|---|---|---|---|
| **Provider/channel coverage** | 🟡 29 live catalog providers + native Anthropic/OpenAI/OpenRouter (`packages/providers/src/index.ts:112-138`, catalog `limits/*.yaml`) | ✅ ~40 `relay/channel/*` adapters + task plugins (`relay/relay_adaptor.go`) | New API has far more *native* protocols and regional/paid providers. See 2.2. |
| **Format conversion matrix** | 🟡 OpenAI Chat + Anthropic Messages inbound only; **text only**, multimodal rejected (`packages/gateway/src/index.ts` blocks image/audio/video/file ~L231-232); OpenAI+Anthropic SSE | ✅ any-to-any among OpenAI Chat, OpenAI Responses, Claude Messages, Gemini; requests + non-stream + incremental stream (`relaykit/README.md` support matrix) | New API quality-rated `Good/Fair/Discouraged`; tool/reasoning/multimodal/usage mapping. |
| **Fallback / retry / priority / weights** | 🟡 scored candidate ranking + deterministic Auto-Free chain + resilience ledger (`packages/router/src/index.ts:338-499`, `auto-free-chain.ts`, `resilience.ts`); one fast retry only (`onStepError` L750-757). No user-facing priority/weight. | ✅ explicit per-channel **Priority** (higher wins) and **Weight** (random among equal priority); configurable retries + cross-group retry; channel affinity (`model/channel.go` `Priority`/`Weight`; `service/channel_select.go`; `middleware/distributor.go`) | Ferry's ranking is adaptive but has no weight/priority knobs. |
| **Channel health / auto-disable + re-enable** | 🟡 derived `health`/`cooldown`, circuit breaker (cockatiel), model retirement, manual enable/disable, hourly re-probe (`packages/quota/src/engine.ts:603-668`, `packages/router/src/techniques.ts:136-154`, `packages/core/src/domains/providers.ts`), **no `autoDisable` flag** | ✅ per-channel `AutoBan`, global auto-disable toggle, disable by status code + keyword list, auto re-enable (`model/channel.go` `AutoBan`/`GetAutoBan`; `service/channel.go` `ShouldDisableChannel`/`ShouldEnableChannel`/`DisableChannel`/`EnableChannel`) | Ferry has no explicit per-provider auto-disable toggle. |
| **Rate limiting** | 🟡 gateway key requests/min only (`packages/gateway/src/index.ts` `rateLimit`); provider quota windows (requests/tokens/USD/credits, TPM) in quota engine (`packages/quota/src/engine.ts`) | ✅ model/user/group request limits, total vs *successful* counts, Redis or in-memory token bucket (`middleware/rate-limit.go`, `middleware/model-rate-limit.go`) | New API counts successful requests separately; Ferry doesn't limit gateway tokens/concurrency. |
| **Usage / cost accounting** | ✅ `UsageRecord`, quota ledger, windows, USD estimates, spend caps (`packages/quota`, `packages/router/src/index.ts:244-300`) | ✅ per-token/user/channel quota, pre-consume + post-settle, cache billing ratio, expression-based/tiered pricing, logs (`service/billing.go`, `billing_session.go`, `billing_usage.go`; `model/log.go`; `model/model_pricing_config.go`) | Different goals; New API is billing-grade multi-tenant. |
| **Model aliasing / redirect** | 🟡 capability aliases + `ferry/*` profile aliases only; no upstream redirect table (`packages/core/src/gateway.ts` `profileId`; catalog aliases) | ✅ per-channel **Model Mapping** (client model → upstream model), **Status Code Mapping**, **Param Override**, **Header Override** (`model/channel.go` `ModelMapping`, `StatusCodeMapping`, `GetModelMapping`, `GetStatusCodeMapping`, `ParamOverride`, `HeaderOverride`; docs channel page) | New API redirects are per-channel JSON; Ferry routes `provider/model` pass-through. |
| **Caching** | 🟡 captures `cachedInputTokens` (`packages/providers/src/index.ts:432-462`), routing `cacheAffinity`; no gateway response cache | ✅ channel affinity (sticky upstream), prompt-cache billing ratio, optional Redis cache; `service/channel_affinity.go`; docs feature #20 | New API prices cache hits; Ferry records them but doesn't price them. |
| **Streaming edge cases** | 🟡 OpenAI SSE + Anthropic SSE; error chunk/event mid-stream; **no fallback after first output** (`packages/core/src/gateway.ts:334-335`, `docs/GATEWAY.md:79`) | ✅ stateful stream conversion, `FinalizeStreamResponse` to flush terminals/usage, Responses WebSocket, reasoning-part splitting (`relaykit/README.md`; `relay/responses_websocket.go`; release notes) | RelayKit handles cross-protocol stream state Ferry has no equivalent for. |
| **Multi-key per provider (rotation)** | ❌ exactly one secret per provider id, PK `id` (`packages/storage/src/schema.ts:10-15`; `packages/secrets`) | ✅ Multi-Key mode, round-robin or weighted-random, per-key status + disable/re-enable (`model/channel.go` `ChannelInfo`, `GetNextEnabledKey`, `handlerMultiKeyUpdate`; docs channel page) | One of the biggest concrete gaps; directly relevant to free tiers. |
| **Codex `/v1/responses` relay** | ❌ explicitly not implemented (`docs/GATEWAY.md:59`, `docs/STATUS.md:61`) | ✅ Codex channel relays `/v1/responses` (+ `/responses/compact`, alpha search) to `chatgpt.com/backend-api/codex`, with OAuth token refresh (`relay/channel/codex/adaptor.go`; `service/codex_oauth.go`, `codex_credential_refresh*.go`) | New API also relays generic OpenAI `/v1/responses` (`relay/responses_handler.go`, `relay/channel/openai/relay_responses.go`). |
| **Gemini / Claude native endpoints** | 🟡 Anthropic `/v1/messages` native inbound (`packages/gateway/src/index.ts`); Gemini only as OpenAI-compatible *upstream* (`providers/index.ts:113,183`); no `/v1beta` route | ✅ native Claude Messages and native Gemini `generateContent`/`streamGenerateContent` (`relay/claude_handler.go`, `relay/gemini_handler.go`, `relay/channel/gemini/`) | Ferry has no native Gemini inbound. |
| **Unified request normalization** | 🟡 Gateway→AI-SDK message/tool mapping (`packages/core/src/gateway.ts:29-78`), tool-call ID normalization per target (`packages/router/src/index.ts:930-952`) | ✅ RelayKit DTOs + converter IDs/quality/steps/usage (`relaykit/README.md`) | Structural, not behavioral. |
| **Channel test / health probe** | ✅ `probe` with model discovery, quota parse, skipped-model list (`packages/providers/src/index.ts:974-1361`) | ✅ single + test-all channel tests, response-time tracking (`controller/channel*.go`; `model/channel.go` `ResponseTime`/`TestTime`; docs channel page) | Comparable. |
| **Model catalog / pricing table** | ✅ `models.snapshot.json`, LiteLLM/OpenRouter price snapshots, quality priors (`packages/catalog/data/...`) | ✅ DB pricing config + upstream sync with added/changed/deleted preview (`model/model_pricing_config.go`, `model/model_metadata_sync.go`; docs model page) | New API syncs upstream model lists in the admin UI. |
| **Extensions / plugins** | ✅ MCP servers + skills (`packages/extensions`) | ✅ JS task plugins (`plugins/tasks`, `pkg/jsplugin`), plugin marketplace, advanced-custom channel | Different extension model (media tasks vs agent tools). |

### 2.2 Provider/protocol coverage Ferry lacks

From `relay/relay_adaptor.go` (`GetAdaptor`) and `relay/channel/` directory listing, New API has native adapters for: OpenAI, Claude/Anthropic, **Gemini**, **AWS Bedrock**, **Vertex AI**, Azure-style (via OpenAI/advanced-custom), **Alibaba Qianwen/DashScope (`ali`)**, Baidu, Baidu V2, Tencent Hunyuan, **Volcengine/Doubao**, **Moonshot/Kimi**, **MiniMax**, **Zhipu GLM + GLM-4V**, **Lingyiwanwu**, **SiliconFlow**, xAI, **Cohere**, **Perplexity**, Dify, **Ollama**, Replicate, Jina, Cloudflare, Mistral, DeepSeek, OpenRouter, Xinference, MokaAI, Coze, Jimeng, iFlytek (xunfei), PaLM, new-api/sub2api/submodel, advanced-custom, plus task plugins (Midjourney/Suno/Sora/Kling/Vidu/Veo/Seedream/Doubao video via `plugins/tasks`).

Ferry's live catalog covers: anthropic, anyapi, cerebras, cloudflare-workers-ai, deepinfra, deepseek, fireworks, gemini, groq, huggingface, hyperbolic, kilo, llm7, mistral, nebius, novita, nvidia, openai, opencode-go, opencode, openrouter, ovhcloud, sambanova, scaleway, stepfun, together, tokenrouter, vercel-ai-gateway, zai-glm (`packages/catalog/data/limits/*.yaml`). Subscription OAuth: Anthropic Claude Pro/Max, ChatGPT, GitHub Copilot, Kimi Code, Meta Muse, xAI Grok; OpenRouter PKCE (`docs/PROVIDERS.md:28-32`).

**Channels present in New API but absent in Ferry** (relevance to free-tier aggregation noted, but current free-tier availability was **not** verified in this task): native **Gemini** protocol; **Ollama** (local, free); **SiliconFlow** (free model tier historically); **Zhipu GLM**, **Moonshot/Kimi**, **Alibaba Qwen**, **MiniMax**, **Lingyiwanwu**; **Perplexity**; **Cohere**; **Replicate**; **Dify**; **AWS Bedrock**, **Vertex AI**, **Azure OpenAI**; **xAI native API** (Ferry only has xAI via OAuth). Some are paid/enterprise/region-locked; treat this as coverage of *protocols*, not as a claim of free quota.

**Protocols Ferry lacks inbound**: OpenAI `/v1/responses` (Codex), native Gemini `/v1beta/models/{model}:generateContent` and `:streamGenerateContent`, `/v1/completions`, `/v1/embeddings`, `/v1/rerank`, audio/image/speech, Realtime/Responses WebSocket, Ollama NDJSON (`docs/GATEWAY.md:59`; `relay/` handlers; `relaykit/README.md`).

---

## 3. Ranked ideas worth adapting (max 10)

All are **idea-only** (AGPL vs MIT). "Where in Ferry" names the package/module that would own it.

1. **Multi-key channels with per-key health and rotation** — *Effort L*
   - What: a single logical provider can hold N keys; select round-robin or weighted-random; disable a failing key individually and auto re-enable it; only disable the whole channel when all keys fail.
   - New API: `model/channel.go` (`ChannelInfo.IsMultiKey`, `MultiKeyMode`, `MultiKeyStatusList/DisabledReason/Time`, `MultiKeyPollingIndex`, `GetNextEnabledKey`, `handlerMultiKeyUpdate`) and `mapping`/docs channel page.
   - Why Ferry: free tiers are usually per-account/per-key; multiple keys multiply usable capacity, and per-key cooldown prevents one dead key from retiring a provider.
   - Ferry home: `packages/secrets` + `packages/storage` (schema change: keys table keyed by `(providerId, keyIndex)` rather than PK `id` today, `packages/storage/src/schema.ts:10-15`), selection in `packages/providers/src/index.ts` and `packages/router`. UI in `packages/ui`/Providers screen.

2. **Cross-protocol conversion matrix incl. `/v1/responses` and native Gemini inbound** — *Effort L*
   - What: any-to-any conversion among OpenAI Chat, OpenAI Responses, Claude Messages, Gemini; requests, non-stream responses, and incremental streams with a required finalize step.
   - New API: `relaykit/` (module docs and support matrix; `relayconvert`, `dto`, `reasonmap`) and `relay/responses_handler.go`, `relay/gemini_handler.go`, `relay/claude_handler.go`.
   - Why Ferry: closes the documented `/v1/responses` gap and lets clients that speak Responses/Gemini use Ferry's free-tier routing; today Ferry accepts only OpenAI Chat + Anthropic and rejects multimodal (`packages/gateway/src/index.ts`).
   - Ferry home: `packages/gateway` (new conversion layer) + `packages/core/src/gateway.ts`.

3. **Codex `/v1/responses` relay with subscription OAuth refresh** — *Effort M*
   - What: relay Responses requests to the Codex backend with the required headers, default `instructions`, `store:false`, and token refresh.
   - New API: `relay/channel/codex/adaptor.go` (paths `/backend-api/codex/responses*`, `chatgpt-account-id`, `originator`), `service/codex_oauth.go`, `service/codex_credential_refresh*.go`, `service/codex_wham_usage.go`.
   - Why Ferry: Ferry already has Codex OAuth (delegation + `packages/oauth`) but not the Responses endpoint; this lets Codex CLI/clients use Ferry routing and fixes a known gap (`docs/STATUS.md:61`).
   - Ferry home: `packages/gateway` + `packages/oauth` + `packages/providers`.

4. **Per-channel model mapping / redirect** — *Effort M*
   - What: map a client-requested model name to the upstream model name for that provider (JSON table), per channel.
   - New API: `model/channel.go` (`ModelMapping`, `GetModelMapping`; `StatusCodeMapping`, `GetStatusCodeMapping`), docs channel page ("Model Mapping").
   - Why Ferry: free tiers expose provider-specific IDs (e.g. a `gpt-oss-120b` alias across Groq/Cerebras/SambaNova); a mapping layer makes profile aliases portable and lets Ferry route a logical model to whichever free provider has capacity.
   - Ferry home: `packages/catalog` (data) + `packages/router` (resolution) + `packages/gateway` (client-facing alias), replacing today's pass-through in `packages/core/src/gateway.ts`.

5. **Per-provider parameter/header/status overrides** — *Effort S/M*
   - What: force-strip or force-set request params, add upstream headers, and remap upstream status codes per provider.
   - New API: `model/channel.go` (`ParamOverride`, `HeaderOverride`, `GetParamOverride`, `GetHeaderOverride`, `StatusCodeMapping`, `ValidateSettings`), `relay/param_override_error.go`.
   - Why Ferry: free/experimental endpoints often reject params (e.g. `temperature`, tools) or return nonstandard codes; overrides avoid bespoke adapter code and let weak providers participate in routing.
   - Ferry home: `packages/providers/src/index.ts` (`streamProviderChat` request shaping) + provider config in `packages/catalog`.

6. **Explicit channel priority + weight knobs** — *Effort S*
   - What: user-configurable integer priority (higher selected first) and weight (random among equal priority), layered on top of Ferry's computed score.
   - New API: `model/channel.go` (`Priority`, `Weight`, `GetPriority`, `GetWeight`), `service/channel_select.go`, `middleware/distributor.go`.
   - Why Ferry: lets users pin a preferred free provider or randomize across a pool without changing adaptive scoring; today there is no user knob (`packages/router/src/index.ts:445-457` is fully computed).
   - Ferry home: `packages/router` (`scoreModels` tie-breakers) + provider/profile settings in `packages/core/src/domains`.

7. **Explicit auto-disable/re-enable policy per provider** — *Effort S*
   - What: per-provider `autoDisable` toggle + global enable, disable by classified error/status/keyword, automatic re-enable on a successful probe.
   - New API: `service/channel.go` (`ShouldDisableChannel`, `ShouldEnableChannel`, `DisableChannel`, `EnableChannel`; `AutomaticDisableChannelEnabled`, `AutomaticEnableChannelEnabled`, `AutomaticDisableKeywords`), `model/channel.go` (`AutoBan`).
   - Why Ferry: Ferry derives cooldowns but has no explicit, auditable per-provider policy; free-tier endpoints fail in provider-specific ways, and a keyword/status list plus a visible toggle is clearer than implicit exclusion.
   - Ferry home: `packages/router/src/resilience.ts` + `packages/core/src/domains/providers.ts` + a settings field.

8. **Generalized channel/session affinity** — *Effort S*
   - What: stick a session to a concrete upstream channel (not just a model), with a strict/soft mode, to improve cache hits and provider-side session stability.
   - New API: `service/channel_affinity.go`, affinity hooks in `service/channel_select.go` (`GetPreferredChannelByAffinity`, `MarkChannelAffinityUsed`, `ShouldKeepChannelAffinityOnChannelDisabled`).
   - Why Ferry: Ferry already has sticky sessions (`packages/core/src/gateway.ts:102,296-299`, `packages/router/src/techniques.ts` StickySessionLedger) but keyed by model, not provider account; affinity to a key/account can reduce rate-limit spread and improve prompt-cache hits.
   - Ferry home: `packages/router/src/techniques.ts` + `packages/core/src/gateway.ts`.

9. **Cache-hit accounting ratio** — *Effort S/M*
   - What: weight cached input tokens (prompt cache ) at a configurable ratio when estimating cost and quota consumption.
   - New API: docs Features #20 (Prompt Cache Ratio, per-channel 0-1, OpenAI/Azure/DeepSeek/Claude), `service/billing*.go`, `model/model_pricing_config.go`.
   - Why Ferry: Ferry already records `cachedInputTokens` (`packages/providers/src/index.ts:432-462`) but prices all input equally (`estimateSpend`, `packages/router/src/index.ts:246-265`); free-tier budgets stretch further when cache hits are priced correctly.
   - Ferry home: `packages/router` (`estimateSpend`) + `packages/quota` + `packages/catalog` pricing fields.

10. **Per-gateway-key token/request budgets with success-only counting** — *Effort M*
    - What: enforce token-per-minute/day and concurrent-request caps per gateway key, and count *successful* requests separately from total.
    - New API: `middleware/model-rate-limit.go` (total vs success counts, Redis or in-memory token bucket), `middleware/rate-limit.go`.
    - Why Ferry: gateway keys currently limit requests/min only (`packages/gateway/src/index.ts` `rateLimit`); token budgets protect scarce free-tier TPM and avoid burning provider capacity on failing client retries.
    - Ferry home: `packages/gateway` (`authenticateGatewayKey`/rate state) + `packages/core/src/gateway.ts`.

---

## 4. Things NOT worth copying

One line each — multi-tenant SaaS/billing/admin features irrelevant to a single-user desktop app.

- User accounts, groups, Casbin RBAC, OAuth/OIDC login, passkeys, 2FA, Telegram login (`model/authz_role.go`, `model/casbin_rule.go`, docs user/group pages).
- Payments/redemption: Epay, redemption codes, subscriptions, internal balance/enterprise accounting (`service/epay.go`, docs redemption/subscription pages).
- Multi-node scale-out infrastructure: MySQL/PostgreSQL main DB, mandatory shared Redis, ClickHouse log DB (`README` storage table) — Ferry is single-user SQLite.
- Admin web console, dashboards, audit logs, i18n, plugin marketplace (`web/`, `model/audit_log.go`) — Ferry ships its own Electron UI.
- Media/task endpoints and task plugins: images, audio, speech, embeddings, rerank, Midjourney/Suno/Sora/Kling/video (`relay/*_handler.go`, `plugins/tasks`) — outside Ferry's coding-agent scope.
- Revenue/ops machinery: model-square storefront, notify-root-user, check-in (`model/checkin.go`, `service/notify-limit.go`).
- Email binding / login verification / account security flows (`service/email_binding.go`, `service/login_verification.go`).
- New API's *distribution* model itself (pre-provisioned paid channels, groups, billing multipliers) — Ferry's value is discovering and surviving free quotas, which New API does not attempt.
- Direct code reuse of any kind: AGPL-3.0 + §7 attribution/UI-link terms are incompatible with Ferry's MIT licensing.

---

## 5. Unverified / caveats

- Star/fork/commit/issue counts and release dates are a point-in-time scrape (2026-10-02) and change constantly.
- I did not execute New API; all behavior claims come from its docs, README, release notes, and source reads.
- Provider coverage is inferred from `relay/channel/` directory names and `GetAdaptor`; I did not read every adapter's model list or protocol details.
- "Free-tier relevance" of New API providers is general knowledge, **not** verified in this task; New API itself has no free-tier concept.
- I did not verify the exact defaults of `RetryTimes`, `AutomaticDisableKeywords`, or prompt-cache ratio values — only that the mechanisms and setting names exist (`service/channel_select.go`, `service/channel.go`, docs features #20).
- Ferry line numbers are from current `main` at the time of reading and may drift.
- License analysis is engineering guidance, not legal advice. Because Ferry's Gateway is network-served, incorporating AGPL code would trigger AGPL §13 source-offer obligations; do not copy code.
