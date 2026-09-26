# Routing comparison — how other routers survive free-provider chaos

**Research date: 2026-09-26.** Every claim below is referenced to source read from GitHub
at the ref named in each section (`file:line`); inline links use that ref. Claims that come
only from a README, website, or docs page are marked **claimed**. Anything I could not
determine from code or published docs is marked **unknown**. No API keys were used and no
network calls were made from Ferry code — this is a desk review plus direct source reading.

This document answers, per project, nine questions:

1. model list / churn handling; 2. capability detection; 3. error classification;
4. fallback chain; 5. quota tracking; 6. health checks / recovery; 7. agent integration;
8. known failure reports; 9. license.

It closes with **What Ferry should adopt** and a short **avoid** list.

Repo refs read (except where noted, default branch as of 2026-09-26):

| Project | Repo | Ref read | Language | Stars | License |
|---|---|---|---|---|---|
| LiteLLM Router | `BerriAI/litellm` | `main` | Python | ~59.7k | MIT **except** `enterprise/` (see §9) |
| Portkey AI Gateway | `Portkey-AI/gateway` | `main` | TypeScript | ~13.1k | MIT |
| claude-code-router (CCR) | `musistudio/claude-code-router` | `main` | TypeScript | ~37.4k | MIT |
| CodeRouter | `zephel01/CodeRouter` | `main` | Python | ~49 | MIT |
| LLM-API-Key-Proxy | `Mirrowel/LLM-API-Key-Proxy` | `main` | Python | ~556 | split: rotator_library LGPL-3.0-only / proxy_app MIT |
| OmniRoute | `diegosouzapw/OmniRoute` | `release/v3.8.51` (default) | TypeScript | ~70.4k | MIT |
| 9router | `decolua/9router` | `master` | JavaScript | ~29.8k | MIT |
| pi-free | `apmantza/pi-free` | `master` | TypeScript | ~140 | MIT |
| Kilo Code | `Kilo-Org/kilocode` | `main` | TypeScript | — | MIT |
| RouteLLM | `lm-sys/RouteLLM` | `main` | Python | ~5.4k | Apache-2.0 |
| Not Diamond (RoRF) | closed API; `notdiamond` docs + RoRF blog | docs | — | — | closed API; RoRF OSS |

> "CodeRouter" is ambiguous. There are at least three projects with that name. This report
> treats **`zephel01/CodeRouter`** as the intended target (a Claude-Code-facing local-first
> fallback router, MIT, on PyPI as `coderouter-cli`), because it is the one that solves
> provider/fallback routing. `Code-Router/CodeRouter` (a 1-star agent orchestrator, "route
> each coding task to an agent/model") and `LanceZPF/agent-as-a-router` (research code for
> ACRouter) are noted only in §11.

Ferry's own router (for the mapping in the final section): `packages/router/src/index.ts`
— `scoreModels` (:235–315) with weights at :290–297, hard filters at :242–274,
`onStepError` (:389–403) allowing one fast retry only for `rate_limit` with
`retryAfterSeconds <= 10`, `shouldSwitchBeforeStep` (:368–387), and handoff briefing
(:427–504). Engine flow is documented in `docs/ARCHITECTURE.md:32–44`.

---

## 0. The shape of the problem (what every project converges on)

Across all ten routers the same three layers recur, and every real failure report is a bug
in the seams between them:

1. **Per-request attempt / retry** — retry the same target a bounded number of times
   (idle timeout, backoff, `Retry-After`).
2. **Per-key or per-model cooldown** — disable the credential/model that just failed,
   scoped so sibling models/keys keep working.
3. **Per-provider health / circuit breaker** — stop sending *any* traffic to a provider
   that is failing repeatedly, then probe it back to life.

OmniRoute states this explicitly as its "3-layer resilience model"
(`docs/architecture/RESILIENCE_GUIDE.md:9–15`), and it is the only project that names the
layers and keeps them separate. The rest implement some subset.

The recurring hard parts are: **distinguishing a rate-limit 429 from a quota-exhausted
429**, **not locking a whole connection when only one model is bad**, **switching after a
stream has already started**, and **noticing that a "successful" 200 is actually an empty
or error shell**. Sections below show how each project handles (or ignores) those.

---

## 1. LiteLLM Router (`BerriAI/litellm`)

LiteLLM is the reference implementation for the "user-defined fallback + cooldown" model.
It is a proxy/SDK for many providers; the client does the tool loop.

### 1.1 Model list / churn
- Models are **config-defined deployments** (`model_list`) plus a **static shipped price
  catalog**, `litellm/model_prices_and_context_window_backup.json` (regenerated from
  `model_prices_and_context_window.json`). There is no periodic live `/models` discovery:
  the catalog is a data file, and capability data is unioned per model group at runtime in
  `Router.get_model_group_info` — `router.py:10850–10939`.
- Retired / 404 handling is **operational, not registry-driven**: a 404 is classified so it
  can cool the deployment down — `_is_cooldown_required` returns `True` for `408 or 404`
  (`router_utils/cooldown_handlers.py:255–256`), and `RetryPolicy.NotFoundErrorRetries`
  is consulted first for any 404 in `get_retry_from_policy.py:32–34,58–66`. LiteLLM does
  **not** know that a model id was retired; it just backs off when the provider 404s.

### 1.2 Capability detection / when tools are unsupported
- Per-deployment `model_info` carries `supports_vision`, `supports_function_calling`,
  `supports_parallel_function_calling`, `max_input_tokens`, etc.; these are merged into a
  model-group view at `router.py:10894–10939`.
- Context-window filtering is opt-in: `enable_pre_call_checks` is documented as
  "Filter out deployments which are outside context window limits for a given prompt"
  (`router.py:852`, field at :912). When the flag is off there is no capability gate.
- **There is no automatic reroute when tools are required but the model lacks them.**
  Content-policy and context-overflow are special-cased into dedicated fallback lists
  (§1.4); "tools unsupported" is not. The provider error passes through.

### 1.3 Error classification, retries, cooldowns
- `_is_cooldown_required` (`cooldown_handlers.py:218–268`): cools down on `429`, `401`,
  `408`, `404`; **does not** cool down on other 4xx; cools down on everything else (500+).
  A literal string check exempts `APIConnectionError` (:235–239).
- `_should_cooldown_deployment` (`:330–424`) is the v2 decision: cooldown when a 429 from a
  multi-deployment group arrives, or when the per-minute failure fraction exceeds
  `DEFAULT_FAILURE_THRESHOLD_PERCENT` (0.5) with at least
  `DEFAULT_FAILURE_THRESHOLD_MINIMUM_REQUESTS` (5) requests, or when
  `litellm._should_retry(status)` is `False`. There is a deliberate safety net that avoids
  cooling a single-deployment model group (:357–361, 400–409). Constants:
  `litellm/constants.py` — `DEFAULT_COOLDOWN_TIME_SECONDS = int(os.getenv(..., 5))` (:79),
  `DEFAULT_FAILURE_THRESHOLD_PERCENT` (:73–74), `DEFAULT_FAILURE_THRESHOLD_MINIMUM_REQUESTS`
  (:136–137). **Default cooldown is 5 seconds.**
- Per-exception retry counts: `RetryPolicy` fields resolved by MRO in
  `get_retry_from_policy.py:19–66` (`RateLimitErrorRetries`, `AuthenticationErrorRetries`,
  `NotFoundErrorRetries`, `DefaultRetries`, …). Deployment-level `allowed_fails_policy`
  can override per exception type (`cooldown_handlers.py:103–215`).
- Cooldown store is `CooldownCache` over a `DualCache` (memory + optional Redis), key
  `deployment:{id}:cooldown`, TTL = cooldown time (`cooldown_cache.py:96–157`). Counters
  (`deployment:{id}:allowed_fails`) are fleet-wide in Redis with a local fallback
  (`cooldown_handlers.py:561–622`).
- Status → exception mapping is centralized: `litellm_core_utils/exception_mapping_utils.py`
  `case 429 → RateLimitError`, `case 5xx`, `status_code < 500 → BadRequestError`, else
  `APIError` (:2283–2346).

### 1.4 Fallback chain
- Three separate user-defined lists: `fallbacks`, `context_window_fallbacks`,
  `content_policy_fallbacks` (`router.py:794–796,1100–1111`). Resolution keys on the routed
  model group with exact → stripped → provider-prefixed → generic `"*"` matching
  (`router_utils/fallback_event_handlers.py:441–479`).
- On failure, `async_function_with_fallbacks_common_utils` (`router.py:7222–7489`) chooses:
  order-based fallback levels first (deployment `order`; :7266–7320), then
  `ContextWindowExceededError` → `context_window_fallbacks` (:7356–7388),
  `ContentPolicyViolationError` → `content_policy_fallbacks` (:7389–7420), then the general
  `fallbacks` chain (:7421–7462). Bounded by `max_fallbacks` and `fallback_depth`
  (:7259–7262); a per-request `disable_fallbacks` opts out (:7521–7522).
- **Mid-stream fallback is supported.** `MidStreamFallbackControls` carries
  `fallbacks`, `context_window_fallbacks`, `content_policy_fallbacks`, `num_retries`,
  `model_group_retry_policy` across a streaming attempt's re-entry, and
  `mid_stream_fallback_hop_kwargs` builds the kwargs a failed stream re-enters the chain
  with; `attempted_targets` prevents retrying an already-tried target
  (`fallback_event_handlers.py:307–362`). Re-entry call sites are in `router.py` at
  :5409 and :5724.

### 1.5 Quota tracking
- RPM/TPM are tracked via Redis counters in the routing strategies: e.g.
  `router_strategy/lowest_tpm_rpm_v2.py:62–137` increments `{model}:{deployment}:rpm:{minute}`
  and rejects a deployment over its `rpm` limit. Pre-call model-rate-limit checks live in
  `router_utils/pre_call_checks/model_rate_limit_check.py`. Budgets/spend caps are tracked by
  `router_strategy/budget_limiter.py`; these are LiteLLM-side counters, not provider-header
  parsed quotas.

### 1.6 Health checks / recovery
- `proxy/health_check.py` probes each deployment (`_run_model_health_check` :518,
  bounded-concurrency runner :543, `_perform_health_check` :583–659) and produces
  `healthy_endpoints` / `unhealthy_endpoints` plus `exceptions_by_model_id` "for cooldown
  integration" (:625–628). `build_deployment_health_states` (:662–697) feeds the router's
  `DeploymentHealthCache`.
- Cooldown recovery is lazy: an entry is considered active until
  `timestamp + cooldown_time` passes; the in-memory TTL is corrected against Redis on read
  (`cooldown_cache.py:135–157`). There is no background "defrost" task; the next request
  simply finds the entry expired.

### 1.7 Agent integration
Proxy/SDK only (OpenAI-compatible). The agent/tool loop lives in the client; LiteLLM does
not call tools or reroute on tool-call failures (beyond content/context special cases).

### 1.8 Known failure modes
- **Documented limitation, adaptive router v0** (`router_strategy/adaptive_router/README.md:72–88`):
  "Latency is not in the score", "Hard sample cap at 200", "Signals are regex + tool-call
  only", "Bandit-delta mapping is unvalidated".
- The 5-second default cooldown is short enough that a provider with a multi-minute window
  can be re-hammered; the per-minute failure-rate logic
  (`cooldown_handlers.py:380–409`) is what prevents permanent retry storms, and it needs
  ≥5 requests in the minute to trigger.
- Illuminating issues (search `repo:BerriAI/litellm is:issue fallback` returns ~348):
  [#8842](https://github.com/BerriAI/litellm/issues/8842) (router callbacks not fired on
  async completion), [#22667](https://github.com/BerriAI/litellm/issues/22667) (OpenRouter
  model IDs stop working after a release — the churn class). These show that "seamless"
  breaks at the catalog/observability seam, not at the retry seam.

### 1.9 License
Custom top-level `LICENSE`: content under `enterprise/` is under `enterprise/LICENSE`;
everything else is MIT. Safe to reuse the MIT portions (router/cooldown/fallback code) with
attribution; do **not** copy `enterprise/`.

---

## 2. Portkey AI Gateway (`Portkey-AI/gateway`)

Portkey is a config-driven OpenAI-compatible gateway. It is **stateless across requests**:
it has retry and fallback *per request*, but no cross-request cooldown or health ledger in
the open-source gateway.

### 2.1 Model list / churn
- No model registry. Providers are configured by the caller (headers/body) or hosted config.
  `src/providers/openrouter/index.ts` is a thin pass-through. Retired-model handling is
  **none** beyond whatever the provider returns; a 404 propagates unless the caller's
  `retry.onStatusCodes` includes it (it does not by default; §2.3).

### 2.2 Capability detection
- None in the gateway. There is no tools/vision/context gate. (OpenRouter's
  `require_parameters` is an OpenRouter feature, not Portkey's.) Unsupported parameters are
  passed through.

### 2.3 Error classification, retries
- Default retriable statuses: `RETRY_STATUS_CODES = [429, 500, 502, 503, 504]`
  (`src/globals.ts:38`). Retry is `async-retry` with `randomize: false`
  (`src/handlers/retryHandler.ts:174–180`); only statuses in the request's
  `retry.onStatusCodes` (type at `src/types/requestBody.ts:9–14`) are retried, and
  `retry.useRetryAfterHeader` makes a 429 honor `Retry-After`/`x-ratelimit-reset*`
  (`POSSIBLE_RETRY_STATUS_HEADERS`, `globals.ts:7`). The honored delay is capped by
  `MAX_RETRY_LIMIT_MS = 60 * 1000` (`globals.ts:5`), and the remaining budget is tracked
  across attempts (`retryHandler.ts:84,128–152`). Non-retriable statuses `bail()` out
  immediately (:157–164).
- Timeout is per request: an `AbortController` maps to a synthesized `408`
  (`retryHandler.ts:4–47`). Transport errors become `503`/`500` responses (:182–212).
- **No cross-request cooldown.** The only circuit breaker is per-request config
  (`cbConfig`) handled in `handlerUtils.ts:792–800`.

### 2.4 Fallback chain
- Four strategies (`src/types/requestBody.ts:22–26,232–236`): `single`, `fallback`,
  `loadbalance`, `conditional`. Dispatch is a switch in `handlerUtils.ts:662–831`:
  - `fallback` walks `targets` in order; it **stops** when `onStatusCodes` says the status
    is acceptable, or when no `onStatusCodes` and the response is ok, or on a gateway
    exception header (`:676–689`).
  - `loadbalance` picks weighted-random with a default weight of 1 (`:693–723`).
  - `conditional` evaluates caller-supplied JSON-Logic-ish queries with `$eq/$gt/$in/$regex/
    $and/$or` against metadata/params/path (`src/services/conditionalRouter.ts:32–155`).
- Fallback is decided **before** the body is streamed; mid-stream failures are handled by
  the stream handler and surfaced, not re-routed (no model-switch-after-first-byte path in
  the OSS code read).

### 2.5 Quota tracking
- A per-key **token-bucket rate limiter** in Redis via a Lua script
  (`src/shared/services/cache/utils/rateLimiter.ts:5–82`, `checkRateLimit` :141–172). This
  is a caller-configured limiter, not provider-header quota parsing.

### 2.6 Health checks / recovery
- None global. Circuit-breaker behavior exists only where the caller attaches `cbConfig`
  to a target (`handlerUtils.ts:792–800`). No background probes, no provider registry.

### 2.7 Agent integration
Proxy only; the client keeps the tool loop.

### 2.8 Known failure modes
- [Issue #722](https://github.com/Portkey-AI/gateway/issues/722) "Gateway error when
  processing non-200 model response" and
  [#1047](https://github.com/Portkey-AI/gateway/issues/1047) (AWS Bedrock validation
  exception not handled) show the failure mode of a *pass-through* design: provider-specific
  error shapes leak through until explicitly normalized. A search for
  `fallback infinite loop` returned 0 issues — the per-request design is simple enough that
  it has few fallback-specific bug reports, but it also has no cross-request memory.

### 2.9 License
MIT (`LICENSE`).

---

## 3. claude-code-router / CCR (`musistudio/claude-code-router`)

CCR is the closest architectural peer to Ferry in the "local gateway in front of coding
agents" sense. It is a proxy with a management UI, and it has a genuinely clean
**failure classifier** separated from the retry policy.

### 3.1 Model list / churn
- Models are **config-defined per provider** (`provider.models`). The gateway's
  `/models` and `/v1/models` endpoint serves a "Claude Code discoverable" model list built
  from that config (`packages/core/src/gateway/features/model-discovery.ts:23–25`, build at
  :507–573). A model catalog with limits/1M-context flags is read from
  `gateway/model-catalog.ts` (`readCatalogCapability`, `modelCatalogMaxInputTokens`).
- Retired/unconfigured models are surfaced as **compile diagnostics**: when a fallback model
  is not configured, `config-compiler.ts:252–272` emits
  `fallback-model-not-configured` and filters it out of the chain. 404/410 at request time
  flow through the failure classifier (§3.3), not a lifecycle registry.

### 3.2 Capability detection
- Provider capability routing rewrites the model/provider selector for the wire protocol
  in `gateway/upstream/executor.ts:32–115` (`applyProviderCapabilityRouting`), using
  normalized provider capabilities and per-protocol selectors
  (`providerCapabilityForClientProtocol`, :232–246). The model catalog supplies context
  limits and the 1M-context suffix (`model-discovery.ts:483–487`).
- There is **no tools/vision gate that reroutes**: tool strictness and protocol adaptation
  happen in `gateway/core-runtime/responses-tool-strictness.ts` and the protocol adapter.
  Unsupported capabilities produce a request-shape rewrite or an upstream error, not a
  capability-based switch.

### 3.3 Error classification, retries, cooldowns
- **Classifier** (`routing/failure-classifier.ts:10–31`):
  `429 → "rate-limit"`, `408/409 → "retryable"`, `>=500 → "server"`, else `"client"`.
  `shouldFallback` is `statusCode >= 400` when the fallback mode is `"model-chain"`,
  otherwise only `retryable|rate-limit|server`.
- **Retry delays** (`gateway/upstream/retry-policy.ts:5–53`): prefer `Retry-After`
  (seconds or HTTP-date) clamped to `1..60_000 ms`; otherwise exponential
  `1_000 * 2^n` capped at `30_000 ms`.
- **Credential cooldown** (`providers/credential-pool.ts:16,57–64`): a fixed
  `providerCredentialCooldownMs = 60_000`; `401/403/429/5xx` set the cooldown; any
  `2xx–4xx` except `401/403/429` increments window counters and clears the cooldown.
- **Per-credential limit windows** (`gateway/limits/window-limiter.ts:13–30`): `requests/
  rpm/rph/rpd`, `tpm/tph/tpd`, `ipm/iph/ipd`, `quota`. `estimateLimitUsage` estimates
  input tokens as `chars/4` plus a max-output guess (:52–82). `providerCredentialLimitState`
  blocks when `counter + requested > limit` (:19–37). A `0.8` spillover threshold exists
  (`executor.ts:27`).

### 3.4 Fallback chain
- User-defined `Router.fallback` with `mode: "model-chain"` and an ordered `models` list;
  `config-compiler.ts:36,53–65` validates it. The chain is materialized into attempts by
  `buildUpstreamAttempts` → `createRouteExecutionPlan` (`executor.ts:1063–1085`), and
  `fetchUpstreamWithFallback` iterates it (`executor.ts:282–592`): on a fallback-eligible
  status it records the failed attempt, applies `recordProviderCredentialOutcome`, waits the
  retry delay, and `continue`s to the next attempt (:479–514); network errors fall through
  the same loop (:539–586). Provider/credential selection among a provider's credentials is
  sorted by candidates (`selectProviderCredentials`/`sortProviderCredentialCandidates`,
  :999–1062).
- Capability routing can rewrite each attempt's model/provider for the protocol
  (`executor.ts:159–231`).
- **Mid-stream**: fallback happens at fetch time, before the body is consumed. Once a
  `2xx` response is returned, the streaming path takes over; the executor's abort handling
  (`:1194`) and `route-trace` observe it, but I found **no model switch after the first byte**
  (unknown whether any downstream recovery exists). Treat CCR as pre-stream fallback only.

### 3.5 Quota tracking
- Per-credential windows as in §3.3 (counters + estimates). No provider-header quota parser
  was found in the files read. The management UI surfaces request/token/cost estimates from
  `observability/route-trace.ts`.

### 3.6 Health / recovery
- Credential cooldowns are the only health state; they clear on a successful call
  (`credential-pool.ts:57–64`). No background probe in the files read.

### 3.7 Agent integration
Agent-aware at the edges: it ships profiles/launchers for Claude Code, Codex, Kimi, and a
local OpenCode free-tier provider whose request fingerprint matters
(`agents/local-providers/opencode-freetier.ts:161,224`). The gateway itself is a proxy; the
agent loop stays in the client.

### 3.8 Known failure modes
- Historical feature requests confirm fallback was initially missing:
  [#275 "Please add a fallback model option with customizable retries"](https://github.com/musistudio/claude-code-router/issues/275)
  and [#208 "支持轮询或者fallback"](https://github.com/musistudio/claude-code-router/issues/208)
  (both still open). This is the class of gap Ferry must not ship.
- The `0.8` spillover and the fixed 60 s credential cooldown mean a credential-wide 429 is
  handled per credential, which is correct, but a provider-wide 429 without per-credential
  scoping can still rotate through the whole pool before backing off.

### 3.9 License
MIT (`LICENSE`, copyright 2025 musistudio).

---

## 4. CodeRouter (`zephel01/CodeRouter`)

CodeRouter is the most directly relevant project for *agent-aware* free-tier routing: it
sits in front of Claude Code, repairs local-model tool calls, and keeps a runtime
health/drift state per provider. It is Python + 5 runtime deps.

### 4.1 Model list / churn
- Models come from `~/.coderouter/providers.yaml` (per provider `kind`, `base_url`,
  `model`) — config, not live discovery. A bundled **capability registry** YAML
  (`coderouter/data/model-capabilities.yaml`) supplies per-family capability flags and is
  overridable by `~/.coderouter/...` (`config/capability_registry.py:1–44`). Precedence:
  `providers.yaml capabilities.*` > user registry > bundled registry > unset
  (`capability_registry.py:14–21`). There is no `/models` polling loop; `coderouter doctor`
  probes a model on demand (`doctor.py`).
- Retired models: `model not found`/`does not exist`/`unknown model` are treated as
  *unavailable* and, because `AdapterError.retryable` defaults `True`, the chain moves on
  (`routing/modelFamilyFallback`-equivalent logic lives in `doctor.py` + adapters). There is
  no vendor retirement calendar.

### 4.2 Capability detection / tool handling
- Declarative flags: `thinking`, `reasoning_passthrough`, `tools`, `max_context_tokens`,
  `claude_code_suitability` (`ok|degraded`), `tool_choice`, `cache_control`
  (`config/capability_registry.py:62–149`, schema :152–180). Matched by `fnmatch` globs
  against the model id.
- Tool handling is a **translation + repair** strategy rather than a reroute: the Anthropic
  ingress repairs JSON that small models emit as text
  (`translation/tool_repair.py`), and `capability.py` strips/emulates `tool_choice` and
  `cache_control` when the upstream does not support them (`provider_supports_tool_choice`
  :335, `emulate_tool_choice` :420, `strip_cache_control` :487). So the answer to "request
  needs tools and model doesn't support them" is: repair/emulate, otherwise the failure
  surfaces — **not** a capability-based model swap.

### 4.3 Error classification, retries, cooldowns
- `AdapterError(message, provider, status_code, retryable=True)` — default is retryable
  (`adapters/base.py:104–136`). The chain tries the next provider when
  `AdapterError(retryable=True)` (`routing/fallback.py:5–6`). A uniform 401/403 chain emits
  `chain-uniform-auth-failure` (`fallback.py:961–965`).
- There is **no fixed per-status cooldown table**. Instead:
  - **Backend health** demotes on consecutive failures (below).
  - **Adaptive** reorders by rolling latency/error observations
    (`routing/adaptive.py`).
  - **Drift** demotes a provider whose output degrades (`fallback.py:1900–2029`).
  - **Memory pressure** cools an OOM backend (`guards/memory_pressure.py`).
  - **Budget** skips providers over a monthly USD cap (`routing/budget.py`).
- Streaming retry safety is explicit: a stream failed **before any real content** is treated
  like an empty response and the next provider is tried; after content has started, a
  `MidStreamError` is raised (surfaced, not silently stitched) unless a partial-stitch action
  is configured (`fallback.py:3553–3664`, `MidStreamError` at :908–934).

### 4.4 Fallback chain
- Ordered per-profile `providers` list with a **free-only default** (`ALLOW_PAID` gate;
  paid providers skipped at `fallback.py:2146`). Auto-router picks the profile from the
  request body (`routing/auto_router.py`: image → `multi`, dense code → `coding`, else
  `writing`; six matchers including `has_tools`, `content_token_count_min` for 1M-context
  switching, `model_pattern`, `cjk_ratio_min`; first match wins, `auto_router.py:60–71,
  172–303`).
- Reordering is applied at chain-resolve time: adaptive rank first, then L5 UNHEALTHY
  demotion, then drift cooldown.
- Mid-stream: same as §4.3 — fallback only before real content; otherwise surface.

### 4.5 Quota tracking
- Cost/monthly-USD budgets per provider (`routing/budget.py`; `cost.monthly_budget_usd`),
  in-memory, UTC-month reset (documented in the project's CHANGELOG). Token estimates are
  `char/4` (`token_estimation.py`). No provider rate-limit header parsing was found.

### 4.6 Health / recovery
- `guards/backend_health.py` is a clean three-state machine: `HEALTHY → DEGRADED` at
  `threshold` consecutive failures, `→ UNHEALTHY` at `2*threshold`; **a single success snaps
  back to HEALTHY** with no debounce (`backend_health.py:99–197`). `should_skip` implements
  a half-open probe: one trial per `half_open_interval_s` while UNHEALTHY (:223–253).
  State is persisted (`save_state`/`load_state`, :259–298) minus monotonic timers.
- `guards/self_healing.py` orchestrates exclude → restart → recovery probe; `doctor.py`
  runs 7 probes; `guards/continuous_probe.py` probes in the background even when idle
  (per README/comments).

### 4.7 Agent integration
**Agent-aware.** It speaks the Anthropic Messages wire format to Claude Code, translates
OpenAI-compatible local backends, repairs tool calls, and has a tool-loop guard
(`guards/tool_loop.py`). This is the closest model to Ferry's planned `agent/` + `router/`
split.

### 4.8 Known failure modes
- Only two issues in the repo (both closed, both setup questions), so there is little
  public failure history — treat its reliability as **unproven at scale**. Its own README
  leans on `coderouter doctor` / `coderouter replay` for diagnosing "local model broke
  tool calling", which is an admission that translation/repair is the hard part.

### 4.9 License
MIT (`LICENSE`, copyright 2026 zephel01). Dependencies are 5 runtime packages, so the code
is easy to read/reuse with attribution.

---

## 5. LLM-API-Key-Proxy (`Mirrowel/LLM-API-Key-Proxy`)

This is a **credential-rotation** router, not a model-chain router: it keeps one provider
and rotates API keys/OAuth credentials, with escalating cooldowns. It is the best reference
for the per-key resilience that Ferry's `quota`/`providers` packages will need.

### 5.1 Model list / churn
- Models come from LiteLLM's provider/model definitions plus a `model_info_service`
  (`src/rotator_library/model_info_service.py`), exposed as `/v1/models` with pricing and
  capabilities (README endpoint table). Provider-specific model quirks live in provider
  classes. Retired models classify as `NOT_FOUND` (`error_handler.py`, §5.3) and cause a key
  rotation rather than a registry update.

### 5.2 Capability detection
- `model_info_service` carries context/pricing; some providers implement
  `get_model_tier_requirement(model)` to gate a *credential tier*, not a capability
  (DOCUMENTATION.md:410–415). There is no tools/vision gate; the proxy is a translator
  (OpenAI + Anthropic endpoints, `anthropic_compat/`).

### 5.3 Error classification, retries, cooldowns
- `ClassifiedError` + `ErrorType` enum: `RATE_LIMIT` (429), `AUTHENTICATION` (401/403),
  `SERVER_ERROR` (5xx), `QUOTA`, `CONTEXT_LENGTH`, `CONTENT_FILTER`, `NOT_FOUND`, `TIMEOUT`,
  `UNKNOWN` (DOCUMENTATION.md:308–324). Classification is status-first, then message
  keywords, then provider-specific `parse_quota_error` (`error_handler.py:732–846`).
- Handling policy (DOCUMENTATION.md:344–348):
  - `AUTHENTICATION` → immediate **5-minute global lockout** of the provider.
  - `RATE_LIMIT`/`QUOTA` → **escalating per-model cooldown**: README line 369 states
    `10s → 30s → 60s → 120s`.
  - `SERVER_ERROR` → retry same key up to `max_retries`, then rotate.
  - `CONTEXT_LENGTH`/`CONTENT_FILTER` → immediate failure (do not burn keys).
- Special types: `EmptyResponseError` (503, rotatable) and `TransientQuotaError`
  (bare 429 with no retry timing; treated as retryable, `error_handler.py:185–218`,
  DOCUMENTATION.md:452+).
- Retry timing is parsed from the provider: Google `ErrorInfo.quotaResetDelay`, human
  "quota will reset after 156h14m36s", `quotaValue`/`quotaId` extraction
  (`error_handler.py:27–124,506–702`). That is a notably richer reset parser than most.

### 5.4 Fallback chain
- The "chain" is the credential pool for one provider (and per-model quota groups). Selection
  is priority-tiered then load-balanced: `get_credential_priority` groups keys, tries the
  highest tier first, idle keys before busy, weighted-random via `ROTATION_TOLERANCE`
  (0 = deterministic, 3 = weighted, default) (DOCUMENTATION.md:380–438, README:461).
- **Fair-cycle rotation** ensures every credential in a tier is used at least once before any
  is reused; exhausted credentials (cooldown > `EXHAUSTION_COOLDOWN_THRESHOLD`, default
  300 s) are skipped until the whole tier exhausts or the cycle duration (default 86400 s)
  elapses (DOCUMENTATION.md:588–621).
- **Mid-stream retry is conditional**: `can_retry_stream_after_error(last_streamed_chunk,
  allow_reasoning_only_retry)` — retry is always allowed before any chunk; after that only
  if the last chunk is reasoning/thinking-only *and* the flag is on; otherwise fail closed
  (`client/stream_retry_policy.py:18–78`). This is a good, explicit answer to Ferry's
  "can we switch after tokens streamed?".

### 5.5 Quota tracking
- Window limits per credential, model, and quota group (`usage/limits/window_limits.py:38–91`,
  `usage/tracking/windows.py`), plus cooldown checks (`usage/limits/cooldowns.py:29–74`).
- **Custom caps** let an operator set a *more restrictive* per-tier/per-model cap and a
  custom cooldown mode (`quota_reset` etc.), with the invariant "custom cap ≤ actual max,
  custom cooldown ≥ natural reset" (DOCUMENTATION.md:623–657).
- Daily resets of cooldowns/usage; persistence in `usage/usage_<provider>.json`
  (README:373, DOCUMENTATION.md:620–621).

### 5.6 Health / recovery
- Cooldown expiry is the recovery mechanism (`cooldown_manager.py:20–44`,
  `usage/limits/cooldowns.py`); a successful call clears state. `background_refresher.py`
  maintains OAuth tokens. No active health probe.

### 5.7 Agent integration
Proxy only (OpenAI + Anthropic endpoints), works with Claude Code/OpenCode as a base URL
swap; tool loop client-side.

### 5.8 Known failure modes
- [#42](https://github.com/Mirrowel/LLM-API-Key-Proxy/issues/42) (Antigravity provider all
  500s) and [#37](https://github.com/Mirrowel/LLM-API-Key-Proxy/issues/37) (Antigravity 403)
  show that a provider-specific OAuth surface can defeat generic key rotation.
  [#155](https://github.com/Mirrowel/LLM-API-Key-Proxy/issues/155) (`CUSTOM_CAP` not
  honoured) is exactly the kind of quota-guard bug Ferry must test.
- The **transient-** vs **quota-** 429 distinction is handled per provider (parse retry
  timing; otherwise `TransientQuotaError`), which is the correct instinct.

### 5.9 License
Split (`LICENSE`): `src/rotator_library/` is **LGPL-3.0-only** (per-file SPDX headers and
`COPYING`/`COPYING.LESSER`); `src/proxy_app/` is **MIT**. LGPL means you may link/reuse the
library but must preserve its license and provide the library source; the MIT app portion is
freely reusable. Ferry should not copy LGPL files into an MIT/closed core without honoring
LGPL.

---

## 6. OmniRoute (`diegosouzapw/OmniRoute`)

OmniRoute is the most elaborate free-tier router found (~350 providers, ~2.5k model pairs,
formerly "combos", now "auto-combo" with 16-factor scoring). It is also the best-documented
on *why* each resilience layer exists. Its scale is a warning as much as a reference: the
codebase is enormous and its changelog is full of seam bugs.

### 6.1 Model list / churn
- Per-provider **registry modules** under
  `open-sse/config/providers/registry/<provider>/index.ts`, aggregated by
  `providerRegistry.ts` (`generateModels` :99–113, `getRegistryEntry` :187). 350+ provider
  modules, 2500+ provider-model pairs (**claimed** in README).
- **Live discovery is authoritative by default**: `providerUsesAuthoritativeLiveCatalog`
  (`providerRegistry.ts:219–233`) — "Live discovery is authoritative by default, including
  for dynamic providers." Providers with partial discovery opt out explicitly. So model
  lists are a hybrid: hardcoded catalog + live `/models` refresh.
- **Retirement handling is a first-class lifecycle module** (`open-sse/services/
  modelLifecycle.ts`): `MODEL_LIFECYCLE_RECORDS` list OpenAI shutdown dates (:78–103),
  a vendor-retired snapshot whose `status: "retired"` ids are prefix-stripped so an
  aggregator id maps to the same vendor id (:1–12, :144–177), and `isModelSelectable`
  rejects shutdown models while allowing deprecated ones until their date (:287–304).
  `rejectRetiredAutoComboCandidates` drops retired ids from auto pools (:192–197).
- 404 at request time is classified `MODEL_NOT_FOUND` so the **model** is locked out rather
  than the whole provider (`errorClassifier.ts:395–405`); 400/401 phrasing
  `"... is not supported"` is also treated as model-not-found (:407–420, :556–568) because
  otherwise auto-combo re-selected the same dead model repeatedly.
- A "Radar" signed remote catalog overlay is **claimed** (README/website) — an opt-in GET
  catalog, community catalog stays free.

### 6.2 Capability detection
- Registry entries + models.dev-synced capabilities supply context limits and modalities
  (`getModelContextLimit` in `src/lib/modelCapabilities`). The auto-combo suffix system
  (`auto/coding:fast`, `auto/vision:free`, …) filters the candidate pool by category and
  tier on demand and **fails open** if a filter matches nothing
  (`docs/routing/AUTO-COMBO.md` — claimed from docs).
- Tools: providers/models that don't support tools are filtered in the candidate pool;
  combos also have hard/soft capability caps (vision/pdf/audio/video are "hard"; search is
  "soft") and are reordered so hard-capability models float to the front without ever being
  dropped (`9router`'s identical concept; OmniRoute's equivalent is in
  `autoCombo/modePacks.ts`/`intentTaskFitnessMap.ts`). Tool-strictness is handled per
  provider in `open-sse/handlers/chatCore`.

### 6.3 Error classification, retries, cooldowns
This is OmniRoute's strongest area and it is very large; the essentials:
- `classifyProviderError(statusCode, responseBody, provider)` (`services/errorClassifier.ts:362–571`)
  returns a typed `ProviderErrorType`: `RATE_LIMITED`, `UNAUTHORIZED`, `ACCOUNT_DEACTIVATED`,
  `FORBIDDEN`, `SERVER_ERROR`, `QUOTA_EXHAUSTED`, `PROJECT_ROUTE_ERROR`, `CONTEXT_OVERFLOW`,
  `OAUTH_INVALID_TOKEN`, `EMPTY_CONTENT`, `MODEL_NOT_FOUND`, `FINGERPRINT_REJECTION`,
  `GEO_BLOCKED`, `GCP_PROJECT_REQUIRED`, `REQUEST_REJECTED`. The type list is a frozen
  contract (`ERROR_TYPE_CONTRACT`, :132–136).
- **429 rate-limit vs quota-exhausted** is separated by `src/shared/utils/classify429.ts`:
  terminal credits/billing patterns always win; a declared sub-hour `RetryInfo` window
  forces `rate_limit`; else quota keywords → `quota_exhausted`; else `rate_limit`
  (`classify429` :315–331, `QUOTA_PATTERNS` :31–149, `Retry-After` parser including
  Groq-relative `5m`/`2h` :347–377). CJK/Japanese/Korean quota phrases are included
  (:112–148) — directly relevant for GLM/Kimi/MiniMax/Qwen free tiers.
- **Embedded rules** (`open-sse/config/errorConfig.ts`): `ERROR_RULES` walks text rules
  first, then status (`findMatchingErrorRule` :233–235); backoff `base 1000 * 2^level` capped
  at `2 min` with `maxLevel 15` (:59–63, `calculateBackoffCooldown` :217–221). Cooldown
  constants (`COOLDOWN_MS`, :67–94): unauthorized/payment/notFound/rateLimit `2 min`;
  transient initial `5 s`; requestRejected `5 min` then `15 min`; geoBlocked/
  gcpProjectRequired `24 h`.
- **Provider profiles** (`open-sse/config/constants.ts:258–308`): OAuth vs API-key vs local
  have different transient cooldowns (5 s / 3 s / 2 s), backoff ceilings (8/5/3),
  circuit-breaker thresholds (8/12/2), degradation thresholds, provider-failure windows
  (15 min / 30 min / 5 min) and provider cooldowns (5 min / 10 min / 1 min). All overridable
  via `OMNIROUTE_*` env vars.
- **Backoff steps** for per-model lockouts: `BACKOFF_STEPS_MS = [60s,120s,300s,600s,1200s]`
  (`constants.ts:233–234`).
- **Upstream status restatement** corrects gateways that report quota exhaustion with 403/400
  before classification (`docs/architecture/RESILIENCE_GUIDE.md:446–500`,
  `config/upstreamStatusRestatement.ts`), and permanent errors are excluded via
  `excludeMarkers` so they are never retried forever.

### 6.4 Fallback chain
- **Combos** (persisted, user-defined, with 19 strategies) and **auto-combo** (zero-config,
  `model: "auto"`). Strategies include `priority`, `round-robin`, `weighted`, `fill-first`,
  `p2c`, `least-used`, `cost-optimized`, `reset-aware`, `reset-window`, `headroom`,
  `context-optimized`, `cache-optimized`, `lkgp` (last-known-good path), `fusion`,
  `pipeline`, and `auto` (`docs/routing/AUTO-COMBO.md` — docs/claimed, strategy values also
  in `src/shared/constants/routingStrategies.ts`).
- Auto-combo scores every `(provider, model, connection)` with a **16-factor** weighted
  scorer (`services/autoCombo/scoring.ts:62–107` defaults sum to 1: health .1605, quota
  .1429, cost .1429, latency .1143, plus taskFit/stability/tier/affinity/quality/reliability;
  `calculateScore` :160–186, `calculateFactors` :309–354). It computes pool maxima once to
  avoid O(n²) (`computePoolMaxima` :278–288).
- **Fusion**: fan out to a panel, then a judge synthesizes; quorum-grace with
  `minPanel 2`, `stragglerGraceMs 8000`, `panelHardTimeoutMs 90000` (9router has the same
  feature; OmniRoute documents it). 0 answers → 503, 1 → direct.
- **Mid-stream** is explicitly handled: a 750 ms opening holdback (opt-in) allows an early
  truncation to be retried before any byte reaches the client; once committed, only a
  "safe mid-stream continuation contract" can stitch a suffix; a throughput watchdog aborts
  a stream that is producing <4 useful bytes/s over a 30 s window after a 30 s warmup
  (`constants.ts:354–406`, `RESILIENCE_GUIDE.md:421–442`). `EARLY_RETRY_MAX=4`,
  `EMPTY_TURN_RETRY_MAX=4`, `MIN_CONTINUATION_OVERLAP_CHARS=8`.
- **Self-healing** (`services/autoCombo/selfHealing.ts`): score <0.2 excludes a provider for
  5 min escalating to 30 min; re-admit at score ≥0.3; >50% circuits OPEN puts the engine in
  "incident mode" (exploitation only); HALF_OPEN allows a probe.

### 6.5 Quota tracking
- Per-provider **quota fetchers** registered in `services/quotaPreflight.ts` /
  `quotaMonitor.ts` (e.g. `openrouterQuotaFetcher.ts`, `codexQuotaFetcher.ts`,
  `grokCliQuotaFetcher.ts`, `deepseekQuotaFetcher.ts`, `freeModelQuotaFetcher.ts`, plus
  Tavily/Context7/etc.).
- Adaptive polling: `NORMAL 60s → CRITICAL 15s → EXHAUSTED`, warn at 80 % used, exhaustion
  at 95 %, alerts deduped per session for 5 min (`services/quotaMonitor.ts:21–25`).
- Reset parsing is a dedicated module (`services/quotaResetParsing.ts`,
  `services/retryAfterJson.ts`, `services/dailyQuotaReset.ts`).
- `services/autoCombo/quotaScoring` and `combo/quotaExhaustion*.ts` feed quota into routing.

### 6.6 Health / recovery
- Three distinct layers, kept separate by design (`RESILIENCE_GUIDE.md:9–15`):
  1. **Provider circuit breaker** (`src/shared/utils/circuitBreaker.ts`, states
     `CLOSED→DEGRADED→OPEN→HALF_OPEN→CLOSED`, adaptive backoff escalating resetTimeout,
     per-failure-kind thresholds, DB persistence, :129–253, :498–599). Only provider-level
     statuses `[408,500,502,503,504]` trip it; 401/403/429 belong to cooldown/lockout
     (`RESILIENCE_GUIDE.md:47`).
  2. **Connection cooldown** per credential: `rateLimitedUntil`, `backoffLevel`,
     `lastErrorType`; OAuth base 5 s, API-key base 3 s; 429 prefers upstream `Retry-After`;
     anti-thundering-herd guard; terminal states `banned`/`expired`/`credits_exhausted`
     are not cooldowns (`RESILIENCE_GUIDE.md:72–109`).
  3. **Model lockout** scoped `provider+connection+model`, keyed by status: 429/403/402 lock
     the quota family, 404 locks the bare model, other statuses lock the exact tuple
     (`RESILIENCE_GUIDE.md:225–252`). Off by default, `errorCodes [403,404,429,502,503,504]`,
     base 120 s, max 30 min, exponential (`RESILIENCE_GUIDE.md:265–305`).
- **Success-decay recovery**: a success halves the model's `failureCount`
  (`Math.floor(count/2)`), deleting it at 0 — recovery is not only timer expiry
  (`RESILIENCE_GUIDE.md:290–299`).
- Optional global provider-cooldown window gate (default off) with OAuth/API-key thresholds
  10/15 failures in 15/30 min → 5/10 min cooldown
  (`RESILIENCE_GUIDE.md:53–70`).

### 6.7 Agent integration
Proxy first (one OpenAI-compatible endpoint), but agent-aware features exist: MCP server,
A2A, request fingerprints (`config/cliFingerprints.ts`, `claudeWebFingerprint.ts`), and a
free-tier refusal path keyed on the observed tool list
(`agents/local-providers/opencode-freetier.ts`; `services/opencodeFreeTierSkip.ts`). The
agent's tool loop stays in the agent.

### 6.8 Known failure modes (this is where "seamless" breaks)
The repo's own issue tracker is the richest evidence:
- [#12168 "Service temporarily unavailable: all targets were skipped by pre-dispatch
  filters"](https://github.com/diegosouzapw/OmniRoute/issues/12168) — the failure is
  *ordering*: every target had been marked cooling/skipped, so the combo had nothing to try.
- [#12954 "Weighted combo answers 404 `no_executable_targets` when every target …"](https://github.com/diegosouzapw/OmniRoute/issues/12954)
  — same class, different code path.
- [#8396 "combo fallback stays blacked out for hours after a 429 burst, past the real
  rate-limit window"](https://github.com/diegosouzapw/OmniRoute/issues/8396) — cooldown
  over-estimation, exactly the risk of a fixed table.
- [#12817 "Codex provider stays in 'cooling down' state after quota is restored — cooldown
  persists in provider_specific_data"](https://github.com/diegosouzapw/OmniRoute/issues/12817)
  — persisted cooldown not cleared on recovery.
- [#6421 "POST /v1/chat/completions returns 404 HTML for every request"](https://github.com/diegosouzapw/OmniRoute/issues/6421)
  — routing/proxy seam.
- [#10341 "[BUG] gemini 3.7 flash available in Antigravity IDE, but not accessible in
  omniroute"](https://github.com/diegosouzapw/OmniRoute/issues/10341) — catalog churn.
- [#14189 "recognize CLIProxyAPI model_cooldown 429 payloads as quota_exhausted"](https://github.com/diegosouzapw/OmniRoute/issues/14189)
  — the 429 classification seam, still being patched.
The `changelog.d/fixes/` directory alone contains dozens of named seam fixes
(e.g. `14175-codex-cooldown-recovery.md`, `14151-noauth-model-cooldown-refresh-guard.md`,
`14707-free-quota-unknown-visibility.md`, `14581-token-limit-neighbor-cooldown-lock.md`,
`14639-responses-mid-stream-continuation.md`). **Lesson for Ferry: the cooldown/health layer
must clear on success and must never be able to exclude 100 % of candidates.**

### 6.9 License
MIT (`LICENSE`, copyright 2026 diegosouzapw).

---

## 7. 9router (`decolua/9router`)

9router is the leaner sibling of OmniRoute (same concepts, much smaller code), with a very
readable config-driven error table and a capability reorder that never drops a model. Lower
overhead if Ferry wants to borrow a design rather than a codebase.

### 7.1 Model list / churn
- Per-provider **registry modules** statically imported by an auto-generated index
  (`open-sse/providers/registry/index.js:1–263`). Models are resolved by
  `open-sse/services/model.js`: `parseModel`/`resolveModelAliasFromMap`/prefix inference
  (`model.js:34–144`). No live `/models` refresh loop in the core files read; models come
  from the registry/provider config.
- Retired handling: 404 is in `ERROR_RULES` with a 2-min cooldown
  (`open-sse/config/errorConfig.js:74`), and per-model locks are written
  (`MODEL_LOCK_PREFIX`, `isModelLockActive`, `buildModelLockUpdate`,
  `open-sse/services/accountFallback.js:119–175`). No lifecycle calendar.

### 7.2 Capability detection
- `open-sse/providers/capabilities.js` supplies per-model caps.
  `detectRequiredCapabilities(body)` scans the *current user turn* for image/PDF/audio/video
  (and string data URIs) → `vision|pdf|audioInput|videoInput` (`services/combo.js:105–184`).
  `HARD_CAPS = {vision,pdf,audioInput,videoInput}` vs soft caps (search).
- `reorderByCapabilities(models, required)` stable-sorts into tier 0 (all hard+soft),
  tier 1 (all hard), tier 2 (rest) and **never drops a model** ("fallback intact",
  `combo.js:61–82`). So a request needing vision floats vision models to the front but keeps
  non-vision models as later fallbacks. This is a nicer answer than hard-filtering.

### 7.3 Error classification, retries, cooldowns
- Config-driven `ERROR_RULES` walked top-to-bottom, text rules then status rules
  (`checkFallbackError`, `accountFallback.js:23–64`; table
  `open-sse/config/errorConfig.js:59–76`). Text rules: "no credentials" 2 min, "request not
  allowed" 5 s, "improperly formed request" 2 min, then rate-limit/quota/capacity/overloaded
  use exponential backoff.
- Backoff: `BACKOFF_CONFIG = { base: 2000, max: 5*60*1000, maxLevel: 15 }`
  (`errorConfig.js:32–36`); `getQuotaCooldown(level) = min(base * 2^(level-1), max)`
  (`accountFallback.js:9–13`). `TRANSIENT_COOLDOWN_MS = 30 s` (`errorConfig.js:39`).
- **Crucially**, unmatched `4xx` (except 401/402/403/429) returns
  `{ shouldFallback: false }` so a request-scoped 400 does not cool a healthy account and
  hide the real error (`accountFallback.js:48–64`). This is the same conclusion OmniRoute
  reached (`requestScoped400.ts`, `14438-request-scoped-400-skips-account-cooldown.md`).
- Model locks are stored as flat `modelLock_<model>` fields on the connection
  (`accountFallback.js:119–175`), distinct from account `rateLimitedUntil`.

### 7.4 Fallback chain
- Combo strategies `fallback` and `round-robin` (with `comboStickyLimit`), plus `fusion`
  (`services/combo.js:200–246,280–382,547–625`). `handleComboChat` tries models in order;
  on a non-ok response it extracts error text/retryAfter, calls `checkFallbackError`, waits
  ≤5 s for transient 503/502/504, then continues; all-failed returns the last status or 503
  with the earliest `retryAfter` (`combo.js:300–382`).
- Mid-stream: the loop decides on the `Response` before streaming; no post-first-byte model
  switch was found in `chatCore.js` / `combo.js` (the streaming handler surfaces errors).

### 7.5 Quota tracking
- Per-provider usage modules (`open-sse/services/usage/*.js`, e.g. `claude.js`, `codex.js`,
  `gemini`/`google.js`, `kiro.js`, `grok-cli.js`, `opencode-zen.js`) and a dashboard quota
  page (`src/app/(dashboard)/dashboard/quota/page.js`). Header-level parsing varies per
  provider; there is no single generic header parser in the files read.

### 7.6 Health / recovery
- Per-account `rateLimitedUntil` + `backoffLevel`; a success calls `resetAccountState`
  clearing cooldown, backoff and error (`accountFallback.js:198–207`). `filterAvailableAccounts`
  skips cooling accounts; `getEarliestRateLimitedUntil` powers "reset after Xm Ys" UI.
  No background provider probe found.

### 7.7 Agent integration
Proxy; ships per-tool setup for Claude Code, Codex, Cursor, Cline, etc.
(`src/app/api/cli-tools/*`). Client keeps the tool loop.

### 7.8 Known failure modes
- [#2951 "NVIDIA multi-key pool can be exhausted by request/provider/proxy failures; …
  empty streams"](https://github.com/decolua/9router/issues/2951) — a pooled provider's keys
  all cooled from a mix of failure causes.
- [#3875 "Claude passthrough 400s on Claude Code's `diagnostics` body field, locking every
  account ('Extra inputs are not permitted')"](https://github.com/decolua/9router/issues/3875)
  — a *request-scoped* 400 caused by one client field locked all accounts. This is the exact
  bug the `shouldFallback:false` rule for unmatched 4xx prevents; it was still reported, so
  the fix is partial in the wild.
- [#1089 "Show each model's max context length and make combo rotation context-aware"](https://github.com/decolua/9router/issues/1089)
  — context-fit is not yet in the combo rotation.

### 7.9 License
MIT (`LICENSE`, copyright 2024–2026 decolua and contributors).

---

## 8. pi-free (`apmantza/pi-free`)

pi-free is an **agent extension**, not a proxy: it hooks Pi's own agent lifecycle events.
For Ferry's planned `agent-loop reroute`, it is the most directly applicable design, and its
error classifier is small enough to read end to end.

### 8.1 Model list / churn
- Providers are registered into Pi; free models are enumerated per provider. Model churn is
  handled defensively: a model that 404s/410s is blacklisted by **model id** (not provider)
  and later given another chance (§8.6). Issue
  [#421](https://github.com/apmantza/pi-free/issues/421) shows the failure mode: "12/14
  dynamic-fetch providers register 0 models without a stored credential (no anonymous/
  public-catalog fallback)". A hardcoded benchmark lookup (`getHardcodedScore`) supplies a
  coding-index quality score per model (`selection.ts:154–168`).

### 8.2 Capability detection
- pi-free delegates model metadata to Pi; the auto-fallback module itself does not gate on
  tools/vision. Its classifier comments note Pi's AssistantMessage carries no structured
  status code (issue earendil-works/pi #7234), so it classifies from `stopReason` +
  `errorMessage` text (`classifier.ts:1–26`).

### 8.3 Error classification, retries, cooldowns
- `classifyHttpStatus` (`classifier.ts:42–90`): **recoverable** = `{402,408,409,425,429,
  500,502,503,504,507,521–527,529}` (incl. Anthropic 529 Overloaded and Cloudflare 5xx);
  **unrecoverable** = `{400,401,403,404,405,406,410,415,418,422,451}` (auth, malformed,
  model gone); unknown → recoverable (over-fallback beats silent outage).
- `classifyErrorMessage` (:181–208): delegates to pi-ai's `isRetryableAssistantError` when
  loadable, and reclassifies quota/limit phrasing as **recoverable** because a *switch* can
  fix what a same-model retry cannot (the comment at :22–25 states this explicitly). Local
  fallback tables if pi-ai is unavailable (:148–164).
- `classifyAbort` (:254–261): an "aborted" run with last status ≥500 is recoverable; with
  4xx unrecoverable; with no status, treated as user-initiated.
- There is **no fixed cooldown timer**; the blacklist TTL is the recovery window (§8.6).

### 8.4 Fallback chain
- Candidate selection (`selection.ts:68–152`): scope = `provider` (default, same provider as
  the failure) | `global` | `whitelist`; exclude the failing model itself and blacklisted
  keys; sort by CI score desc, unscored last, deterministic tie-break by
  `provider/modelId`.
- Trigger point and chain mechanics: on the Pi `agent_settled` event, a pure
  `classifySettledFailure` decides if the last assistant message is an actionable failure
  (`settled-decision.ts:60–98`), then the handler blacklists the model and switches the
  default model for the next run, optionally **auto-continuing** the last prompt on the new
  model (`buildAutoContinueContent`, :111–119; `auto_continue`/`auto_continue_max` config,
  `config.ts:45–50`).
- **This is post-run, not mid-stream**: pi-free cannot switch after tokens have streamed;
  it switches between agent turns and replays the prompt. That is a deliberate, honest
  design choice and exactly the interaction Ferry's handoff/`auto-continue` should mirror.

### 8.5 Quota tracking
- `processQuotaResponse` extracts remaining/limit from five header-pair formats in priority
  order (`x-ratelimit-remaining-requests`/`-limit-requests` SambaNova first, then Mistral
  `x-ratelimit-remaining`/`-limit`, generic `ratelimit-*`, and `-day` variants)
  (`quota-monitor.ts:67–104`). It computes `percent`, stores a snapshot with `lastUpdated`
  and marks it stale after 5 min (:154–206). It also counts 401/403, 429, 5xx, and
  "quota-header-drift" (rate-limit headers present but unmatched) per provider
  (:115–163) — a cheap way to detect provider header changes.

### 8.6 Health / recovery
- The **blacklist** is the health state (`blacklist.ts:43–131`): TTL default 10 min, 3
  strikes within the window promote to a hard ban for the rest of the session; state is
  in-memory and intentionally **not persisted** ("free providers flip free/paid status
  frequently", :15–20). A single strike expires with the TTL.
- `formatHealthReport` (`health.ts:23–106`) is a credential-free diagnostic: registered
  providers, startup failures, network failures, empty catalogs, response-outcome counters,
  log-write failures, and auto-fallback status (switches, last reason, EXHAUSTED).
  "Empty after completed refresh (0 models)" vs "refresh never completed" is distinguished
  (:113–135).

### 8.7 Agent integration
**Agent-aware by construction**: it subscribes to `after_provider_response`, `message_end`,
and `agent_settled`, and calls `pi.setModel` after a failure. Config defaults are OFF
(`config.ts:53–63`) because `setModel` is sticky and rewrites the user's default model
(pi#1248) — same opt-in concern Ferry has for subscription OAuth models.

### 8.8 Known failure modes
- [#576 "auto-fallback: in-flight recovery restore can override an explicit user model
  selection"](https://github.com/apmantza/pi-free/issues/576) — the restore path clobbered a
  manual choice. Ferry must make manual selection authoritative.
- [#421](https://github.com/apmantza/pi-free/issues/421) (0 models registered),
  [#543](https://github.com/apmantza/pi-free/issues/543) (single-arg `registerProvider` has
  no fallback → startup crash), [#554](https://github.com/apmantza/pi-free/issues/554)
  (opencode-free compat fallback still sent the account key), [#509](https://github.com/apmantza/pi-free/issues/509)
  (stale extension ctx across auto-continue). All are provider-integration seams.
- `classifier.ts:7–8` and `:174–176` state a "wire-signature convention #17/#437": pi-free
  refuses to read response bodies from `after_provider_response`, only status+headers. That
  is a privacy/robustness stance worth copying.

### 8.9 License
MIT (`LICENSE`, copyright 2024 pi-free-providers contributors).

---

## 9. Kilo Code gateway auto-free (`Kilo-Org/kilocode`)

Kilo's auto-free routing is **server-side and closed**; the open-source client only fetches
the model catalog and passes a mode header. It is worth studying for the *client* contract
and for how they handle a virtual "auto" model in `/models`.

### 9.1 Model list / churn
- `packages/kilo-gateway/src/api/models.ts` fetches an OpenRouter-compatible models list
  from `api.kilo.ai`, validates it with Zod, transforms it to opencode's `Model` shape, and
  maps pricing/modalities/context. Model cache is 5-min TTL
  (`packages/opencode/src/provider/model-cache.ts`, per the architecture doc).
- Virtual auto models `kilo-auto/frontier|balanced|free` (and legacy `kilo/auto`,
  `kilo/auto-free`) are injected client-side when missing:
  [issue #6686](https://github.com/Kilo-Org/kilocode/issues/6686) and
  [PR #6687](https://github.com/Kilo-Org/kilocode/pull/6687). The client also added an
  explicit `__kiloFetchStatus = "success"|"fallback"` marker so a fallback catalog triggers a
  refresh without loops (PR #6687 discussion). That "always surface the virtual auto model,
  mark fallback catalogs, refresh on real success" pattern is directly reusable by Ferry's
  `catalog`/discovery service.

### 9.2 Capability detection
- `fetchKiloModels` **skips models that explicitly don't support tools**: "Kilo requires tool
  calling"; if `supported_parameters` exists and lacks `tools`, the model is dropped;
  a missing array is optimistically assumed to support tools
  (`packages/kilo-gateway/src/api/models.ts`, `fetchKiloModels`). It also maps
  `architecture.input_modalities` → `attachment`, `supported_parameters` → `reasoning`/
  `temperature`/`tool_call`, and computes `max_completion_tokens` from `top_provider`.
- This is a hard filter at catalog time (unlike 9router's soft reorder): a tool-less model
  never appears as a candidate for an agent. Good for an agent-only client, bad if you also
  want chat.

### 9.3–9.6 Error classification / fallback / quota / health
**Server-side; source not in the open repo → unknown.** What is documented:
- `kilo-auto/frontier` uses the `x-kilocode-mode` header; `balanced` uses the API interface
  kind (Completions→qwen3.6-plus, Responses→gpt-5.3-codex, Messages→claude-haiku-4.5);
  `free` is "selected dynamically per session from a curated set of available free models;
  the mapping updates server-side" (`packages/kilo-docs/pages/gateway/models-and-providers.md`,
  and `contributing/architecture/auto-model-tiers.md` — docs/claimed, tied to the cloud repo).
- Free tier is **200 requests/hour per IP** (Kilo docs, external). Auto Free may route to
  providers that log/train (NVIDIA trial terms) — a data-handling caveat.
- The client-side failure signal is `FailoverError: Unknown model: kilocode/kilo/auto-free`
  when the virtual model is absent (#6686).

### 9.7 Agent integration
Kilo Code is the agent; the gateway is a remote proxy. Client keeps the tool loop.

### 9.8 Known failure modes
- #6686 above is the canonical one: **a virtual auto model missing from `/models` breaks
  clients that validate model ids**. Ferry's discovery service must always advertise its
  `auto-free`-style aliases even when live discovery fails.

### 9.9 License
MIT (`LICENSE`, "Copyright (c) 2026 Kilo Code; Copyright (c) 2025 opencode").

---

## 10. OpenRouter (documented behavior) + RouteLLM + Not Diamond

### 10.1 OpenRouter
Closed gateway; behavior is documented, not source-available.
- **Model list / churn**: live `/api/v1/models` plus `~family/latest` resolution ("Latest
  Model Resolution" router) and `:free` suffixed free models. Auto-router ranks by
  **trailing 7-day aggregate spend share per task type** across ~30 task classes — a
  market-signal router, not a health router.
- **Fallbacks**: the `models` array is priority-ordered; the first model that errors falls
  through. "By default, any error can trigger the use of a fallback model, including:
  Context length validation errors, Moderation flags for filtered models, Rate-limiting,
  Downtime" (Model Fallbacks doc). The Anthropic `/v1/messages` surface accepts a
  `fallbacks` array of at most 3 entries, mutually exclusive with `models`; per-entry
  overrides are rejected (400). Pricing is for the model actually used.
- **Provider routing** (`provider` object): `order`, `allow_fallbacks`, `require_parameters`,
  `data_collection`, `zdr`, `only`/`ignore`, `quantizations`, `sort` (`price|throughput|
  latency`, with `partition: model|none`), `preferred_min_throughput`/`preferred_max_latency`
  (percentiles p50/p75/p90/p99 over a rolling 5-min window), `max_price`. Default provider
  choice is price-based load balancing weighted by inverse-square price, with providers that
  saw outages in the last 30 s deprioritized.
- **Capability**: "When you send a request with `tools` or `tool_choice`, OpenRouter makes a
  best effort to route to providers known to support tool use. … if you set `max_tokens`,
  then OpenRouter will only route to providers that support a response of that length."
  `require_parameters: true` is a hard filter; `tools`/`response_format`/`verbosity` are soft
  preferences by default and never remove a model from a fallback list.
- **Auto-router** slugs: `openrouter/auto` and `openrouter/auto-beta`; settings under plugin
  id `auto-router`/`auto-beta-router`; `cost_tier` ∈ {low, medium, high, xhigh, max};
  `allowed_models`/`excluded_models` wildcard patterns; session stickiness by `session_id`
  or a message fingerprint; degrades gracefully to a default model set if classification or
  rankings are unavailable. If restrictions exclude everything: `404 No models match your
  request and model restrictions`.
- **Health**: provider uptime (30 s outage window), rolling 5-min percentile latency/
  throughput. No per-user cooldown ledger surfaced.
- License: gateway closed; docs are OpenRouter's.

### 10.2 RouteLLM (`lm-sys/RouteLLM`, Apache-2.0)
- A *quality/cost* router, not a provider-health router. Four routers trained on preference
  data: `mf` (matrix factorization, recommended), `sw_ranking` (similarity-weighted Elo),
  `bert`, `causal_llm`, plus `random` (`README`; `routellm/controller.py`).
- Route by threshold: `router-mf-0.11593` etc.; a threshold of 0.5 sends ~50 % to the strong
  model (`examples/routing_to_local_models.md`). It routes between exactly two models
  (strong/weak) per request and does not track provider failures, quotas, or cooldowns.
- Useful to Ferry only as an **optional escalation policy** ("send only the hard 20 % to a
  paid/frontier model"), not as the resilience layer. Apache-2.0 makes reuse safe.

### 10.3 Not Diamond
- Closed hosted router API (`POST /v2/modelRouter/modelSelect`): pass messages + candidate
  providers, get back a recommended model + `session_id`; `tradeoff` ∈ {quality, cost,
  latency} or a continuous `cost_quality_tradeoff` 0–10; supports tools and a
  `max_model_depth`. Custom routers are trained on your eval data (`preference_id`).
- OSS: **RoRF** (Routing on Random Forests), a pairwise router trained on prompt embeddings
  (`jina-embeddings-v3`) predicting the four outcome classes; blog states it beats RouteLLM
  on their benchmark. Cost/quality router, no provider-health/quota/cooldown handling.
- For Ferry: same role as RouteLLM — an optional learned escalation signal, not the
  resilience core. The hosted API would add a network dependency and key; avoid as a default.

### 10.4 Also surveyed, briefly
- `LMRouter/lmrouter-core` (MIT): open-source OpenRouter alternative, multi-modality, single
  key; routing details not read deeply — a provider-aggregation reference, not a free-tier
  resilience one.
- `LanceZPF/agent-as-a-router` (ACRouter, research): agentic routing for coding tasks, with
  integrations into claude-code-router and cc-switch; an academic escalation policy.

---

## 11. Licenses — what Ferry can legally reuse

| Source | License | Reuse posture for Ferry (MIT-ish core) |
|---|---|---|
| `BerriAI/litellm` | MIT **except** `enterprise/` | Copy/adapt router + cooldown code with attribution; avoid `enterprise/`. |
| `Portkey-AI/gateway` | MIT | Safe to adapt. |
| `musistudio/claude-code-router` | MIT | Safe to adapt. |
| `zephel01/CodeRouter` | MIT | Safe to adapt. |
| `Mirrowel/LLM-API-Key-Proxy` | **split**: `rotator_library` LGPL-3.0-only; `proxy_app` MIT | MIT app code is reusable; **do not copy LGPL library files** into a permissively licensed core without honoring LGPL (keep as a separate LGPL dependency or re-implement from the ideas). |
| `diegosouzapw/OmniRoute` | MIT | Safe to adapt (but large; borrow designs, not wholesale files). |
| `decolua/9router` | MIT | Safe to adapt. |
| `apmantza/pi-free` | MIT | Safe to adapt. |
| `Kilo-Org/kilocode` | MIT | Client patterns safe; gateway routing is server-side closed. |
| `lm-sys/RouteLLM` | Apache-2.0 | Safe with NOTICE. |
| Not Diamond | closed API; RoRF OSS | API unusable offline; check RoRF license before reuse. |

**Takeaway:** nearly all of this is MIT and reusable with attribution. The one trap is
Mirrowel's LGPL `rotator_library`; treat it as ideas-only unless Ferry accepts LGPL.

---

## 12. What Ferry should adopt (ranked, mapped to Ferry's architecture)

Ranked by expected survival gain per unit of implementation risk. Each item names the target
Ferry package from `docs/ARCHITECTURE.md`.

1. **A typed error classifier as a first-class module** (target: `@ferry/router` +
   `@ferry/shared` error kinds). Follow OmniRoute's `classifyProviderError` shape (typed
   families, not booleans) and 9router's ordered config table. Minimum families:
   `rate_limit`, `quota_exhausted`, `auth`, `model_not_found`, `context_overflow`,
   `content_filter`, `server`, `timeout`, `request_scoped_client`, `stream_failure`.
   Ferry's current `StepError.kind` (`packages/router/src/index.ts:389–392`) is too coarse.
   OmniRoute's `classify429` (`src/shared/utils/classify429.ts:315–331`) is the single most
   valuable snippet to copy: **rate-limit vs quota-exhausted**, including CJK patterns.
   *Effort: S–M.*

2. **Split 429 into "short throttle" vs "quota window" and honor upstream reset hints.**
   Parse `Retry-After` (int / HTTP-date / `5m` / `2h`), Google `RetryInfo.retryDelay`, and
   body phrases; a declared sub-hour window must force a *short* rate-limit path, not a long
   quota lockout. This is the top-reported seam bug across OmniRoute (#8396) and the reason
   9router/CodeRouter/Mirrowel all parse reset text. Feed it into `onStepError`
   (`packages/router/src/index.ts:396–403`). *Effort: S.*

3. **A three-layer resilience model with explicit scopes**, kept separate exactly as
   OmniRoute documents (`RESILIENCE_GUIDE.md:9–15`):
   - provider circuit breaker (health), connection/key cooldown (quota), model lockout
     (capability/quota).
   Map to `@ferry/providers` (health), `@ferry/quota` (cooldowns/windows), `@ferry/router`
     (lockout-aware candidate filtering). Status→scope mapping from OmniRoute §6.6: 429/403/
     402 → quota family, 404 → bare model, 5xx → exact tuple. *Effort: M.*

4. **Success-decay recovery, not timer-only.** Copy OmniRoute's rule: any success halves the
   failure count (`RESILIENCE_GUIDE.md:290–299`), and a success clears cooldown (9router
   `resetAccountState`, CCR `credential-pool.ts:57–64`). This directly prevents the
   "blacked out for hours" class (#8396, #12817). Complement with pi-free's hard-ban cap:
   3 strikes in a TTL window → session ban; otherwise TTL expiry
   (`blacklist.ts:59–131`). *Effort: S.*

5. **A guaranteed non-empty fallback ladder / "never skip everything" invariant.** The
   single most common catastrophic report is "all targets skipped" (OmniRoute #12168,
   #12954). Before dispatch, if every candidate is cooling, Ferry must either (a) pick the
   earliest-resetting candidate and wait/admit one probe (OmniRoute's reset-aware/
   half-open, CodeRouter's `should_skip` half-open probe), or (b) ask the user. Never return
   a 503 that hides which timer caused it. Add this as a test in `packages/router`.
   *Effort: S–M.*

6. **Capability-aware candidate ordering that never drops a model.** Adopt 9router's
   `reorderByCapabilities` (`services/combo.js:61–82`): hard caps (vision/pdf/audio/video)
   float to the front, soft caps next, everything else remains as fallback. This fits
   Ferry's existing hard filter at `scoreModels` (`packages/router/src/index.ts:255–256`,
   `requiresTools`) but is strictly better for resilience: currently a tool-less model is
   dropped, which shrinks the pool. Keep a hard filter only when the step *cannot* proceed
   (tool-only agent turn), else reorder. *Effort: S.*

7. **Model lifecycle awareness for churn.** Follow OmniRoute's `modelLifecycle.ts`: a small
   records list + vendor-retired id snapshot, prefix-stripped, with `allow|warn|reject`
   decisions and a replacement hint (`:78–103`, `:199–304`). On 404/410 or
   "model not found"/"not supported" phrasing, lock the *model* (not the provider) and
   reassign from the same family. Adopt OmniRoute's `modelFamilyFallback`
   (`open-sse/services/modelFamilyFallback.ts:30–140,252–267`) as the family fallback
   template. Target: `@ferry/catalog` + `@ferry/router`. *Effort: M.*

8. **Live discovery with a signed/static fallback and "always advertise virtual models".**
   From Kilo (#6686/#6687) and OmniRoute (`providerUsesAuthoritativeLiveCatalog`,
   `providerRegistry.ts:219–233`): discovery is authoritative when it works, but the client
   must always expose the `auto`/`auto-free` aliases and mark a fallback catalog so it
   refreshes later (Kilo's `__kiloFetchStatus`). Target: `@ferry/catalog` discovery service.
   *Effort: M.*

9. **Header-driven quota tracking with drift detection.** Adopt pi-free's five header-pair
   formats and its "quota-header-drift" counter (`quota-monitor.ts:67–163`), plus adaptive
   polling (OmniRoute `quotaMonitor.ts:21–25`: 60 s→15 s, warn 0.8, exhaust 0.95) and reset
   parsing (`quotaResetParsing.ts`). Ferry already has `QuotaObservation`/`ParsedQuotaWindow`
   contracts (`docs/ARCHITECTURE.md:40–42`); this fills the parsers. *Effort: M.*

10. **Agent-loop reroute modeled on pi-free, with an explicit mid-stream policy.**
    - Switch at the **settled-run boundary**, not mid-stream, and optionally auto-continue
      the captured prompt (pi-free `settled-decision.ts`, `buildAutoContinueContent`).
    - Make manual model selection authoritative so recovery can never clobber it
      (pi-free #576).
    - For mid-stream, adopt the safe-retry rule from Mirrowel
      (`stream_retry_policy.py:18–78`): retry/switch only before content, or when the last
      chunk is reasoning-only; otherwise surface. CodeRouter's preamble-holdback +
      `MidStreamError` (`fallback.py:3553–3664`) and OmniRoute's 750 ms holdback
      (`STREAM_RECOVERY`, `constants.ts:372–394`) are the two implementation options.
    - Map to Ferry's step 2/8 (`ARCHITECTURE.md:32–44`) and the handoff briefing
      (`router/src/index.ts:427–514`). *Effort: M–L.* This is the highest-value differentiator:
      no proxy-only router can do it.

11. **A health/observability surface with credential-free diagnostics.** pi-free's
    `formatHealthReport` (`health.ts:23–106`) is a good template: counts, ages, status
    codes — never keys or bodies. Ferry's desktop can render it; the CLI can print it.
    *Effort: S.*

12. **User-defined fallback profiles (Ferry already has them) + optional learned
    escalation.** Ferry's `Profile`/`BUILTIN_PROFILES` (`router/src/index.ts:102–143`)
    already covers the "combos" concept. Add an optional RouteLLM/Not-Diamond-style
    threshold escalation ("only the hard 20 % goes paid/frontier") as a *scoring term*, not
    a hard router. Do not make it a network dependency by default. *Effort: M (optional).*

13. **Ordering of fallback attempts and provider routing controls.** From OpenRouter's
    documented `provider` object and CCR's evidence: expose `order`, `allow_fallbacks`,
    `prefer` (price/throughput/latency), `max_price`, and a per-request `partition` (try the
    chosen model's endpoints first vs sort globally). Ferry's `scoreModels` weights already
    encode this; make the user-facing knobs explicit. *Effort: S.*

---

## 13. Ideas to avoid

- **Scraping web sessions / cookie auth** (OmniRoute "Web cookie" providers, 9router
  MITM/Antigravity interception, `chatgpt-web`/`gemini-web`/`claude-web`). The existing
  `docs/research/free-providers.md:367–369` already classifies these as ToS-hostile; they
  also produce fingerprint rejections (OmniRoute's whole `FINGERPRINT_REJECTION` family,
  `errorClassifier.ts:245–300`) and brittle stream failures. Ferry's `PROVIDERS.md` stance
  (opt-in, risk-acknowledged, out of auto-routing) is the right one.
- **Key/account rotation across many accounts of the same provider** (OmniRoute
  "Multi-Account Support", Mirrowel key pools, 9router multi-account round-robin). It
  multiplies free quota but invites bans and ToS violations, and it is the direct cause of
  "all accounts locked" reports (#2951, #3875). Ferry must not ship multi-account pooling as
  a default; one key per provider, user-managed.
- **Fabricating a token headline** ("~1.51B free tokens/month") or counting trial credits as
  recurring free capacity. `docs/research/free-providers.md` has already corrected Cerebras
  on this. Keep the honest catalog.
- **Long hardcoded cooldowns for every 429** (OmniRoute's 2-min default, the 24-h
  geo-block/gcp-project timers). They caused #8396 ("blacked out for hours") and #12817
  ("stays cooling after quota restored"). Prefer upstream-declared windows + success decay.
- **Persisting cooldown/lockout state without a recovery path.** OmniRoute persists circuit
  breaker state to DB and had exactly the stale-lockout bugs (#12817). If Ferry persists,
  it must persist an expiry and clear on success.
- **Server-side closed routing as a dependency** (Kilo gateway, Not Diamond hosted API) for
  the core path. Fine as an optional accelerator; not as Ferry's only way to route.
- **Model lists that omit the virtual auto model** (Kilo #6686). Always advertise the
  aliases your own router accepts.
- **Treating a request-scoped 400 as a credential failure.** Both OmniRoute
  (`requestScoped400.ts`) and 9router (`accountFallback.js:48–64`) fixed this; 9router #3875
  shows how bad it is when missed. A client-field 400 must never cool a key or lock a model.

---

## 14. Citation index (primary references used)

LiteLLM: `litellm/router.py` (fallbacks :7222–7551, mid-stream :5409/:5724, capability
union :10850–10939, pre-call :852/:912); `litellm/router_utils/cooldown_handlers.py`;
`cooldown_cache.py`; `fallback_event_handlers.py`; `get_retry_from_policy.py`;
`litellm/proxy/health_check.py`; `litellm/litellm_core_utils/exception_mapping_utils.py`;
`litellm/router_strategy/{lowest_tpm_rpm_v2,adaptive_router/README,complexity_router/README}`;
`litellm/constants.py`; `LICENSE`.
Portkey: `src/handlers/retryHandler.ts`; `src/handlers/handlerUtils.ts`;
`src/services/conditionalRouter.ts`; `src/shared/services/cache/utils/rateLimiter.ts`;
`src/globals.ts`; `src/types/requestBody.ts`; `LICENSE`.
CCR: `packages/core/src/routing/{failure-classifier,model-registry,config-compiler,
policy-engine}.ts`; `packages/core/src/gateway/upstream/{executor,retry-policy}.ts`;
`packages/core/src/gateway/limits/window-limiter.ts`; `packages/core/src/providers/
credential-pool.ts`; `packages/core/src/gateway/features/model-discovery.ts`;
`packages/core/src/agents/local-providers/opencode-freetier.ts`; `LICENSE`.
CodeRouter: `coderouter/routing/{fallback,auto_router,adaptive,budget}.py`;
`coderouter/adapters/base.py`; `coderouter/guards/backend_health.py`;
`coderouter/config/capability_registry.py`; `coderouter/data/model-capabilities.yaml`;
`LICENSE`.
Mirrowel: `src/rotator_library/{error_handler,cooldown_manager}.py`;
`src/rotator_library/client/stream_retry_policy.py`;
`src/rotator_library/usage/limits/{cooldowns,window_limits}.py`; `DOCUMENTATION.md`; `README.md`;
`LICENSE`, `src/rotator_library/COPYING*`.
OmniRoute: `open-sse/services/errorClassifier.ts`; `open-sse/config/{errorConfig,constants,
providerRegistry}.ts`; `src/shared/utils/{classify429,circuitBreaker}.ts`;
`open-sse/services/accountFallback.ts`; `open-sse/services/modelLifecycle.ts`;
`open-sse/services/modelFamilyFallback.ts`; `open-sse/services/autoCombo/{scoring,selfHealing,
resilienceCandidateFilter}.ts`; `open-sse/services/quotaMonitor.ts`;
`docs/architecture/RESILIENCE_GUIDE.md`; `docs/routing/AUTO-COMBO.md`; issue tracker.
9router: `open-sse/services/{accountFallback,combo,model}.js`;
`open-sse/config/errorConfig.js`; `open-sse/providers/registry/index.js`;
`gitbook/content/en/features/{combos,quota-tracking}.md`; `LICENSE`.
pi-free: `lib/auto-fallback/{classifier,selection,blacklist,config,settled-decision}.ts`;
`lib/{health,quota-monitor}.ts`; `lib/auto-fallback/index.ts`; `docs/providers.md`; `LICENSE`.
Kilo: `packages/kilo-gateway/src/api/models.ts`;
`packages/kilo-docs/pages/gateway/models-and-providers.md`;
`packages/kilo-docs/pages/contributing/architecture/auto-model-tiers.md`; #6686/#6687.
OpenRouter: Model Fallbacks, Provider Routing, Auto Router docs (openrouter.ai/docs).
RouteLLM: `routellm/controller.py`, README, Apache-2.0.
Not Diamond: docs.notdiamond.ai key-concepts/quickstart/training; RoRF blog.
