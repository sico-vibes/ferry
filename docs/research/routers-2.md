# Routers, gateways & aggregators Ferry has not yet covered

**Research date: 2026-09-27.** Desk review plus direct reading of GitHub source, raw docs and
vendor pages. Every non-obvious claim is referenced to a URL; source claims cite the file/page
read. Claims that come only from a README, marketing page or third-party directory are marked
**claimed**. Anything I could not confirm is **unknown**. No API keys were used and no Ferry
code was run against these services.

**Scope note.** This document deliberately does **not** re-cover the projects already assessed in
`docs/research/routing-comparison.md`: OmniRoute, 9router, LiteLLM, Portkey gateway,
claude-code-router, CodeRouter (zephel01), LLM-API-Key-Proxy (Mirrowel), pi-free, Kilo gateway,
OpenRouter, RouteLLM, Not Diamond, FreeLLMAPI, or `cheahjs/free-llm-api-resources`. It assumes the
reader has read `routing-comparison.md` §12 ("What Ferry should adopt") and the Ferry package map
in `docs/ARCHITECTURE.md:10–22`.

> **Brief deviation:** the brief asked me to also read `docs/research/freellmapi.md` Part 3. That
> file does not exist in this workspace (`docs/research/` contains only `routing-comparison.md`,
> `free-providers.md` and `limits-proposed/`; a repo-wide search for `freellmapi` returned nothing).
> I anchored the "what Ferry already adopted" baseline on `routing-comparison.md` §12 and
> `docs/ARCHITECTURE.md` instead. If `freellmapi.md` lands later, this doc's final sections should
> be reconciled against its Part 3.

---

## 10-line plain-English summary

1. Most of the "free-LLM routers" people name are **not resilient routers at all**: they are
   provider-translation proxies (Helicone, Bifrost, Kong, Cloudflare/Vercel gateways) or
   key-distribution systems (one-api, new-api, uni-api).
2. The best *new* resilience ideas Ferry can steal are **Bifrost's two-layer retry→fallback with
   per-key rotation and a routing-engine log trail**, and **LobeHub's typed `retry|stop` error
   classifier** — both are readable and permissively licensed.
3. **Two marquee "routers" are effectively gone**: Unify pivoted from routing to a continual-learning
   research lab, and Martian's router is no longer a public product (site now Thesean AI); treat both
   as historical, not candidates.
4. **TensorZero is archived** (read-only since 2026-06-12) — still worth reading for its three-level
   retry/fallback model, but do not depend on it.
5. Cloud gateways (Cloudflare, Vercel) have surprisingly good **declarative fallback schemas** —
   Vercel returns a `modelAttempts[]` audit trail per request that is a great telemetry contract.
6. The Chinese aggregator family (**one-api / new-api / uni-api**) solves key redistribution, channel
   priority/weight and auto-disable, but not agent-aware routing; new-api adds a real circuit-breaker
   knob (consecutive-failure threshold) and multi-key polling.
7. **gpt4free (g4f) is a scraper** that wraps vendors' web sessions against their terms — classify as
   `avoid`, exactly like the web-cookie providers Ferry already rejects.
8. Local runtimes (**Ollama, LM Studio**) and desktop apps (**Jan, Msty**) are useful *as fallback
   endpoints*, not as routers: they expose OpenAI-compatible `/v1` and (Ollama) a `capabilities`
   field, but no failover between providers.
9. For **model metadata, pricing and capability datasets**, the best-licensed sources are
   `models.dev` (MIT) and **Helicone's cost package** (Apache-2.0) plus LiteLLM's shipped pricing
   JSON (MIT) and live OpenRouter `/models`.
10. Net: Ferry should borrow *mechanisms* (typed classification, per-key rotation, non-empty ladders,
    attempt audit trails) from these projects and *data* from the catalog datasets — not wholesale
    gateways, whose failure seams are the same multi-layer cooldown bugs the first report found.

---

## At-a-glance

| Project | Kind | License | Access | Route/fallback | Catalog source | Verdict for Ferry |
|---|---|---|---|---|---|---|
| any-llm + Otari (Mozilla) | SDK + self-host gateway | Apache-2.0 | BYOK | gateway: local policies (failover/weight/learned) | provider `/v1/models` | **Borrow** classifier/exception shape & Otari budget-enforcement ordering |
| aisuite (Andrew Ng) | Provider SDK + Agents API | MIT | BYOK | none (no provider failover) | static provider adapters | Borrow tool-policy/state-store shape; skip routing |
| TensorZero | Gateway/LLMOps | Apache-2.0 | BYOK | model routing → variant retries → variant fallbacks | config (+OpenAI-compatible) | Read-only (archived); borrow 3-level ladder |
| Helicone AI Gateway | Obs + gateway | Apache-2.0 (repo) | BYOK + PTB | BYOK-first, cost-sorted, then PTB | static registry + live | Borrow cost registry & BYOK-first ordering |
| Bifrost (Maxim) | Go AI gateway | Apache-2.0 | BYOK | retry per key → provider fallbacks; adaptive LB (enterprise) | model catalog resolver | **Borrow** most: retry/fallback split, `upstream_credentials_exhausted`, log trail |
| Kong AI Gateway | Gateway (Lua/Nginx) | Apache-2.0 core (plugin tier unknown) | BYOK | 7 LB algos + failover criteria + circuit breaker | static model entity | Borrow EWMA probing + failover_criteria taxonomy |
| Cloudflare AI Gateway | Managed gateway | closed | BYOK / Workers AI | visual Dynamic Routing: condition/percent/rate/budget + fallback | live by provider | Borrow budget/rate nodes as pre-dispatch gates |
| Vercel AI Gateway | Managed gateway | closed | BYOK + system | `models[]` fallback + `order[]` provider pref | live | **Borrow** `modelAttempts[]` telemetry contract |
| Requesty | Hosted router | closed | BYOK + managed | failover / loadbalance / latency policies, nested | static catalog + live | Borrow policy-as-model-string + scope hierarchy |
| Unify | (was) router | unillm MIT | BYOK | historical: per-request benchmarked routing | live benchmarks | **Avoid** (pivoted; no routing product) |
| Martian | (was) router | closed + OSS research | gateway key only | historical: learned routers | live pricing | **Avoid** (site now Thesean AI; pricing 404) |
| one-api | Key redistribution | MIT | pooled keys | random-channel retry | static channel list | Ideas only; pooling is a ToS risk |
| new-api | Key redistribution | AGPL-3.0 | pooled keys | priority/weight, auto-disable, multi-key polling | static channel list | Ideas only (AGPL; pooling) |
| uni-api | Lightweight aggregator | MIT | pooled keys | multi-key round-robin only, **no failover** | config yaml | Skip |
| gpt4free (g4f) | Scraper aggregator | GPL-3.0 | **scraping** | provider list, rotation | scraped | **Avoid** (ToS-hostile) |
| LobeHub provider layer | Desktop/web client runtime | MIT | BYOK | ordered router options w/ cross-provider fallback | static + remote | **Borrow** error classifier + `shouldStopFallback` hook |
| Open WebUI Pipelines/Functions | Plugin framework | Pipelines MIT; core branding-licensed | BYOK | user Python (no built-in router) | live `/models` | Borrow pipe/filter plugin seam, not the legacy worker |
| Jan / Msty | Desktop apps | Apache-2.0 / closed | BYOK + local | none (manual provider choice) | live providers | Fallback endpoints only |
| Ollama / LM Studio | Local runtimes | MIT / closed | local (no keys) | none | local `/api/tags`, `/v1/models` | Useful zero-cost last resort + `capabilities` |

---

## 1. any-llm (Mozilla) and its extracted gateway, Otari

### 1.1 what it is, license, activity
`mozilla-ai/any-llm` is a Python SDK ("Communicate with an LLM provider using a single interface").
Its README positions it explicitly against LiteLLM/aisuite/OpenRouter: "requiring no proxy servers"
and "leveraging official SDKs when available". **Apache-2.0**
(`LICENSE`, "Copyright 2026 Mozilla.ai"); ~2.1k stars, ~200 forks, 40 open issues, created
2025-07-14; default branch `main` (<https://github.com/mozilla-ai/any-llm>).
Activity is high and recent (README mentions an `any_llm` gateway page and a 2026-09 commit).

The **gateway server was extracted into its own repo**, `mozilla-ai/otari`, in commit `664c551`
("chore: remove gateway server code (#1075)", <https://github.com/mozilla-ai/any-llm/commit/664c55122a9a1d43313656e18a778cf04454f525>).
Otari is "An OpenAI-compatible LLM gateway you own and run. Route one endpoint to 40+ providers,
issue virtual keys, enforce budgets, and track usage." **Apache-2.0**, ~494 stars, 57 forks, 285
open issues, 1,152 commits; default branch `main` (<https://github.com/mozilla-ai/otari>).
Otari sits between the app and providers and "enforces budgets before dispatch, and records usage
afterwards" (`README.md`); provider calls go through `any-llm`.

### 1.2 access method
BYOK. Otari can run standalone with your own DB and provider keys, or hybrid against
`otari.ai` (`README.md` "Runtime modes"). No pooled/scraped capacity.

### 1.3 routing & fallback
any-llm itself is a provider abstraction, not a router: the README's differentiators are unified
exceptions, official SDKs and no proxy. Routing lives in Otari: "**Local routing policies for
failover, weighting, and learned selection**" (`README.md`, "Why Otari"). The
`src/gateway/` tree removed in the any-llm commit included `api/routes/{chat,budgets,keys,models,
pricing,users}.py` and `services/{budget_service,pricing_service}.py` — i.e. the gateway already had
budget checks, pricing and model listing. Details of the failover algorithm are **unknown** from the
pages read (Otari docs `docs/routing.md` exist but were not read line-by-line).

### 1.4 quota tracking
Otari: "Budget checks before spend and usage records after settlement" (`README.md`). Per-key,
per-user/per-workspace and per-model scope. This is a **server-side budget ledger**, not
provider-header quota parsing. any-llm SDK itself does not track quota.

### 1.5 model catalog
Provider-native: any-llm calls each provider's official SDK, so model lists are whatever the provider
exposes; Otari serves an OpenAI-compatible `/models` from the `any_llm` provider layer (removed
gateway had `routes/models.py`). Catalog source is effectively **live / provider-native**, not a
bundled price table.

### 1.6 tool calling
any-llm supports tool calling through the unified interface (README "tool calling"). It does **not**
do agent tool loops or reroute when a model lacks tools; that stays in the caller. Otari advertises
optional "code execution, web search, MCP" as built-in tools (`README.md`) — that is a server-side
tool surface, not capability-based routing.

### 1.7 standout ideas
- **Unified exception hierarchy across providers** is the SDK's headline (`docs.mozilla.ai`): a good
  precedent for Ferry's `@ferry/shared` typed error kinds.
- **Budget enforcement before dispatch, settle after** — the correct ordering for Ferry's quota
  ledger: reject *before* the provider call, record after. Otari is a clean worked example.
- **Split the gateway from the SDK.** A provider-normalization library and an enforcement gateway are
  separate concerns; Ferry's `providers/` and `core/` are similarly separable.

### 1.8 known failure modes
Otari has **285 open issues** at ~1 month of public life — a young, fast-moving gateway
(<https://github.com/mozilla-ai/otari/issues>). The any-llm discussion #687 asks for
load-based routing and rate limiting and the maintainer says "We don't yet have a feature to route
requests based on actual server load" — i.e. routing is policy-based, not health-based
(<https://github.com/mozilla-ai/any-llm/discussions/687>). Treat Otari's resilience as unproven.

---

## 2. aisuite (Andrew Ng)

### 2.1 what it is, license, activity
`andrewyng/aisuite` is "a lightweight Python library for building with LLMs, in two layers: a unified
Chat Completions API across providers, and an Agents API with tools and toolkits on top." Provider
list includes OpenAI, Anthropic, Google, Mistral, Hugging Face, AWS, Cohere, Ollama, OpenRouter and
**Requesty**. **MIT**; ~16.3k stars, ~1.7k forks, 77 open issues, 686 commits; default `main`
(<https://github.com/andrewyng/aisuite>). The companion desktop coworker **OpenWorker** moved to its
own repo (`andrewyng/openworker`), with a historical snapshot in `openworker-archive/`.

### 2.2 access method
BYOK; no proxy. Model strings are `<provider>:<model-name>` and calls route to the matching provider
adapter (`README.md`).

### 2.3 routing & fallback
**None between providers.** aisuite routes a single model string to its adapter; there is no failover,
cooldown or health logic. The README's `models = ["openai:gpt-4o", "anthropic:..."]` example is a
loop the *caller* writes, not a fallback chain. No quota tracking, no error taxonomy beyond provider
SDKs.

### 2.4 tool calling
First-class: `tools=[...]` with `max_turns` runs the tool loop for you and returns
`response.choices[0].intermediate_messages`; or omit `max_turns` for manual control. The Agents API
adds `Agent`, `Runner`, toolkits (files/git/shell), `RequireApprovalPolicy`, allow/deny lists, state
stores (in-memory/file/Postgres), artifacts/tracing, and MCP servers (`README.md`). This is the most
relevant part for Ferry's `@ferry/agent`: **tool policies** (`RequireApprovalPolicy`, allow/deny,
callable) mirror Ferry's dangerous-command permissions (`ARCHITECTURE.md:46–48`).

### 2.5 standout ideas
- **Tool-governance objects as first-class** (`RequireApprovalPolicy`, allow/deny lists, custom
  callables) — a cleaner API for Ferry's permission gate than ad-hoc checks.
- **`max_turns` convenience loop** with `intermediate_messages` retained: good model for Ferry's
  agent step loop and handoff briefing.
- **MCP as a tool source** integrated into the same `tools` array.

### 2.6 known failure modes
No public router-specific issues (it has no router). The project's own README notes aisuite's history
of "lacks active maintenance" was a criticism of the *old* aisuite (from any-llm's comparison), which
is now outdated given the 2025–2026 rewrite. No quota/health failure history exists because those
features don't exist.

---

## 3. TensorZero (now archived)

### 3.1 what it is, license, activity
`TensorZero/tensorzero` is an "open-source LLMOps platform that unifies an LLM gateway, observability,
evaluation, optimization, and experimentation" — Rust gateway, <1ms p99 overhead (claimed).
**Apache-2.0**; ~11.7k stars, ~969 forks, 4,100 commits. **The repository was archived by the owner
on 2026-06-12 and is read-only** (<https://github.com/TensorZero/tensorzero>). The README still
claims "powers ~1% of global LLM API spend" (**claimed**, no verification).

### 3.2 access method
BYOK / self-hosted. Also supports client auth so callers don't need provider keys.

### 3.3 routing & fallback (the useful part)
`docs/gateway/guides/retries-fallbacks.mdx` defines **three levels**, tried in this order:
1. **Model provider routing** — a model's `routing = ["openai","azure"]` list is tried sequentially.
2. **Variant retries** — `retries = { num_retries, max_delay_s }` with "truncated exponential
   backoff with jitter".
3. **Variant fallbacks** — candidate variants sampled (uniform or weighted), fallback variants tried
   sequentially if all candidates fail.
The pseudocode in the doc is a clean nested loop:
```python
while variants:
    variant = sample_variant(variants)
    for _ in range(num_retries + 1):
        for provider in variant.routing:
            try: return inference(variant, provider)
            except: continue
```
Granular timeouts split into `non_streaming.total_ms`, `streaming.ttft_ms`, `streaming.total_ms`,
with a global `gateway.global_outbound_http_timeout_ms` (default 15 min) acting as an upper bound.
Load balancing across keys is achieved *by defining duplicate variants with equal sampling
probability* — the docs admit "TensorZero doesn't currently offer an explicit strategy for load
balancing API keys".

### 3.4 quota, catalog, tools
- **Quota**: "Track usage and cost" and "enforce custom rate limits with granular scopes (e.g.
  tags)" (README). No provider-header quota parser evidenced.
- **Catalog**: configuration-driven (`tensorzero.toml`) plus any OpenAI-compatible endpoint.
- **Tools**: supports tool use, structured outputs, batch, embeddings, multimodal, caching.

### 3.5 standout ideas
- **The explicit three-level ladder** (provider → variant retry → variant fallback) is the clearest
  statement of the same idea Ferry's step/handoff model needs — and it separates *retry* from
  *fallback to a different logical config*.
- **Split streaming timeouts** (`ttft_ms` vs `total_ms`) is better than a single timeout and maps
  directly to Ferry's mid-stream policy.
- **Fallback-only variants** (`fallback_variants`) distinct from sampled candidates.

### 3.6 known failure modes
Archival itself is the headline risk: **do not build a dependency on it.** The load-balancing gap is
admitted in the docs. No live issue tracker (archived).

---

## 4. Helicone AI Gateway (+ observability and cost registry)

### 4.1 what it is, license, activity
Helicone is "an AI Gateway & LLM Observability Platform": an OpenAI-compatible gateway over 100+
providers (`https://ai-gateway.helicone.ai`) plus logging/traces/eval. **Apache-2.0**; ~6.2k stars,
675 forks, 55 open issues, 5,488 commits; default `main`
(<https://github.com/Helicone/helicone>). The **gateway is hosted**; the *observability* stack is
self-hostable (Docker/Helm). Repo includes a `bifrost/` directory (it embeds Bifrost, §5).

### 4.2 access method
Two modes (documented in `packages/cost/FLOWS.md`):
- **BYOK** — user's own provider keys, billed directly.
- **PTB (Pass-Through Billing)** — Helicone manages keys and bills; "0% markup" (**claimed**,
  <https://docs.helicone.ai/gateway/overview>).
Free tier "10k requests/month, no credit card" (**claimed**, README).

### 4.3 routing & fallback
The gateway does "intelligent routing" and "automatic fallbacks" (README/docs). The concrete,
source-backed behavior is in the model registry (`packages/cost/FLOWS.md`):
- **Phase 1: all BYOK endpoints, sorted by cost. Phase 2: all PTB endpoints, sorted by cost.**
  "BYOK endpoints are ALWAYS exhausted before trying ANY PTB endpoint."
- `byok_only` is **per-provider**: set true and that provider is excluded from Phase 2, forcing a
  hard failure rather than silently spending Helicone credits.
- Endpoints are deployment-resolved (e.g. Bedrock `us-east-1`, Vertex `us-central1`) with per-deployment
  overrides merged onto a base `ModelProviderConfig`.

This is the clearest published "BYOK before managed key, cheapest first" policy I found.

### 4.4 quota tracking
Hosted: credits and usage dashboards; "custom rate limits" are a listed feature. Self-host: your own
ClickHouse. No provider-header quota parser evidenced.

### 4.5 model catalog & tools
Static, typed registry under `packages/cost/authors/<provider>/.../{models.ts,endpoints.ts}` with
`ModelProviderConfig`/`EndpointConfig`/`Endpoint` types and O(1) Map indexes
(`packages/cost/README.md`). It stores `pricing`, `contextLength`, `maxCompletionTokens`,
`supportedParameters`, `ptbEnabled`. Tools are passed through; no capability routing evidenced.

### 4.6 standout ideas
- **BYOK-first, cost-sorted, PTB-fallback with a per-provider `byok_only` escape hatch** — directly
  applicable to Ferry's optional paid fallback lanes.
- **The cost registry as a typed, O(1), deployment-aware model** is a strong template for
  `@ferry/catalog` (see Data sources §6).
- **Self-hostable observability separate from the hosted gateway** — Ferry's desktop/CLI can own its
  telemetry.

### 4.7 known failure modes
- The hosted gateway is **closed** and BYOK/PTB accounting is a seam: a failed BYOK request falling
  back to PTB can spend money the user did not intend (hence the `byok_only` flag). **unknown**
  whether Ferry-relevant bugs exist; no issue review performed.
- Heliosone lists 55 open issues; not examined per-issue.

---

## 5. Bifrost (Maxim AI)

### 5.1 what it is, license, activity
"Bifrost is a high-performance AI gateway that unifies access to 23+ providers … through a single
OpenAI-compatible API. Deploy in seconds with zero configuration and get automatic failover, load
balancing, semantic caching." Go. **Apache-2.0**; ~8.4k stars, 1.3k forks, 509 open issues, 7,455
commits; default branch `dev` (<https://github.com/maximhq/bifrost>). Repo layout: `core/`
(providers, schemas, `bifrost.go`), `framework/` (configstore/logstore/vectorstore), `transports/`,
`plugins/` (governance, semanticcache, logging, telemetry, mocker, maxim), `ui/`. Performance claims
(50x faster than LiteLLM, <15 µs overhead at 5k RPS) are **claimed**.

### 5.2 access method
BYOK, self-hosted (npx or Docker). Multiple keys per provider are first-class. Enterprise adds
clustering/adaptive LB/guardrails/MCP gateway.

### 5.3 routing & fallback (the strongest new source)
`docs.getbifrost.ai/features/retries-and-fallbacks` documents **two nested layers**:
- **Retries** — same-provider, transient `5xx`/network reuse the same key with exponential backoff
  + jitter; **per-key failures rotate to a different key** from the pool. `429` rotates with backoff
  ("let account-level quota windows slide"); `401/402/403` rotate **without** backoff and mark the key
  permanently dead for the request. Defaults: `max_retries: 0`, `retry_backoff_initial: 500`,
  `retry_backoff_max: 5000`. Rate-limited keys are tracked in a per-request `used` set that resets
  once all keys are tried ("with 3 keys and `max_retries: 5`, Bifrost can cycle through all three keys
  twice").
- **Fallbacks** — a `fallbacks: ["provider/model", ...]` request array; each fallback gets its **own
  full retry budget** ("primary `max_retries:3` + two fallbacks `3` = up to 12 attempts"). If all keys
  die, Bifrost returns **`502 upstream_credentials_exhausted`** rather than the raw provider 4xx, so
  the caller knows their Bifrost key is fine.
- A plugin can set `AllowFallbacks = false` on an error to **halt the fallback chain** for security/
  compliance reasons.
- Every retry/fallback transition is written to the request's **routing-engine log trail** under engine
  `core`, alongside `governance`, `loadbalancing`, `routing-rule`, `model-catalog` decisions.
- **Governance routing** (Virtual Keys) adds weighted load balancing and auto-created fallback chains
  sorted by weight; manual `fallbacks` are preserved. **Adaptive Load Balancing** (enterprise) scores
  routes every 5 s on time-decayed error rate, token-aware latency and utilization, with a small
  exploration share so recovered routes get re-probed; it has explicit switches
  (`direction_selection_enabled`, `route_selection_enabled`, `append_fallbacks_to_pinned`,
  `reroute_failed_directions`, `prune_failed_fallbacks`). `model-catalog-resolver` runs last and
  "always leaves `req.Provider` populated when the catalog knows about the model".

### 5.4 quota tracking
Governance "Budget Management — hierarchical cost control with virtual keys, teams, and customer
budgets" (README/docs). Utilization is a minor input to adaptive scoring. TPM-hit backoff is the only
signal shared across nodes and only within the same region (docs, "Scope & Limitations"). No
provider-header quota parser evidenced.

### 5.5 model catalog & tools
`model-catalog-resolver` picks a provider from a catalog; keys are filtered by model restrictions
(`allowed_models`, `["*"]` uses the catalog). Semantic caching plugin; MCP gateway; plugins handle
request/response transformation. Tool calling is passed through per provider; no capability-based
rerouting evidenced.

### 5.6 standout ideas (Ferry should borrow these specifically)
- **Separate retry budget per provider/fallback**, with per-key rotation classes (`429` backoff vs
  `401/402/403` no-backoff permanent death).
- **`upstream_credentials_exhausted`** as a distinct typed error: never leak a raw provider 4xx when
  the real problem is the credential pool. This belongs in Ferry's `@ferry/shared` error kinds.
- **A machine-readable routing-engine log trail** per request: which engine chose the primary, what
  it failed with, which fallback served. Ferry's handoff briefing (`router/src/index.ts:427–504`)
  should emit this.
- **Plugin override to halt fallback** (`AllowFallbacks=false`) for safety — a policy seam.
- **"Always leave the provider populated from the catalog"** — the non-empty invariant from
  `routing-comparison.md` §12, implemented as a final hook.

### 5.7 known failure modes
- The public benchmark claims are vendor-run (**claimed**).
- Adaptive LB's documented limits: per-node weights, 5-second adaptation lag, no cross-region
  consensus; the `PUT /api/load-balancer-config` API is a **full replacement** ("sending only the
  field you want to change silently turns off the others") — a footgun Ferry must not copy.
- 509 open issues (not reviewed individually).

---

## 6. Kong AI Gateway (`ai-proxy` / `ai-proxy-advanced`)

### 6.1 what it is, license, activity
Kong Gateway's AI plugins ("AI Gateway") proxy/transform requests to multiple AI providers and load
balance across models. Kong Gateway OSS is **Apache-2.0** (<https://github.com/Kong/kong>).
**The open-source vs enterprise split for `ai-proxy` / `ai-proxy-advanced` and the AI load-balancing/
circuit-breaker features is not stated in the docs read → unknown.**
Docs: <https://developer.konghq.com/plugins/ai-proxy-advanced/> and
<https://developer.konghq.com/ai-gateway/load-balancing/>.

### 6.2 access method
BYOK (provider keys configured on the AI Model entity); self-hosted Kong.

### 6.3 routing & fallback
Seven load-balancing algorithms (`ai-proxy-advanced`): **round-robin, consistent-hashing,
least-connections, lowest-usage, lowest-latency, semantic, priority**. Lowest-latency uses Kong's
**EWMA**; "the fastest model gets a majority of traffic, but Kong never sends 100% to a single target
unless it's the only one available" — ongoing probing.
- **Retry & fallback**: `failover_criteria` defines which failures retry on the next target
  (default `error` and `timeout`; can include `http_429`, `http_500`, ...). Behavior: retry same or
  another target, then fall back; return failure if exhausted.
- **Health check & circuit breaker** (`v3.13+`): `config.balancer.max_fails` and
  `config.balancer.fail_timeout`; the failure counter is **total failures in the window, not
  consecutive** ("2 failed then 1 success within the timeout window keeps the counter at 2"). If all
  targets are unhealthy, requests fail with **HTTP 500**.
- Model routing (`config.route.model`) maps a request body model alias to an AI Model; routing rules
  are independent of the balance algorithm.

### 6.4 quota, catalog, tools
Usage stats logged via Kong plugins; no provider-free-tier quota parsing evidenced. Model/provider
list is configuration on the AI Model entity. Tool calling: request/response transformation handles
provider formats; native format passthrough via `config.llm_format`. No capability rerouting.

### 6.5 standout ideas
- **EWMA lowest-latency with mandatory exploration traffic** — a mature version of the "keep probing
  recovered routes" idea; Ferry can copy the *rule* (never 100% to one target) rather than the
  algorithm.
- **`failover_criteria` as a configurable error taxonomy** — Ferry currently hard-codes one fast
  retry for `rate_limit` (`router/src/index.ts:389–403`); a per-profile criteria list is a better
  shape.
- **"total failures in window, not consecutive"** circuit breaker is a deliberate, well-documented
  choice; Ferry should pick one and document it.
- **HTTP 500 when all targets are unhealthy** is the *anti-pattern* Ferry already rejects
  (`routing-comparison.md` §12 item 5: never return a 503/500 that hides which timer caused it).

### 6.6 known failure modes
The all-unhealthy → HTTP 500 behavior is the canonical "all targets skipped" failure the first report
found; Kong documents it rather than solving it. Plugin licensing ambiguity is a procurement risk.

---

## 7. Cloudflare AI Gateway

### 7.1 what it is, license, activity
Managed gateway, "Available on all plans", for analytics/logging plus caching, rate limiting, request
retry, model fallback. **Closed service.**
<https://developers.cloudflare.com/ai-gateway/> (last updated 2026-04-20).

### 7.2 access method
BYOK stored in the gateway, or Workers AI; authentication is required for Dynamic Routing.

### 7.3 routing & fallback — **Dynamic Routing**
`features/dynamic-routing/` (updated 2026-08-07) is a **versioned visual flow** replacing the model
name with a route name (`"model": "dynamic/support"`). Node types:
- **Start**, **Conditional** (if/else over request body/headers/custom metadata, e.g.
  `user_plan == "paid"`), **Percentage** (A/B), **Model** (provider/model call), **Rate Limit**,
  **Budget Limit**, **End**.
- Rate Limit / Budget Limit nodes "switch to fallback when exceeded" — pre-dispatch quota gates.
- **Versions** produce a draft; deploy is instant with rollback.
- Caveat: the OpenAI-compatible `/compat/chat/completions` endpoint is "marked Deprecated for
  standard single-model chat completions, but it remains the required way to call dynamic routes";
  dynamic routing is not on the REST API.

### 7.4 quota, catalog, tools
Analytics (requests/tokens/cost) and logging; rate limiting is caller-configured. Model catalog is
live per provider. Caching and multimodal pass-through; no capability-based rerouting evidenced.

### 7.5 standout ideas
- **Budget/rate nodes inside the routing graph that *switch to fallback*** — the "quota gate as a
  first-class graph node" idea maps well to Ferry's `@ferry/quota` + `@ferry/router` pre-dispatch
  checks.
- **Versioned routes with instant rollback** — a good model for user-editable routing profiles.
- **Passing request metadata** (`userId`, `orgId`, `plan`) for conditionals is exactly the data Ferry
  already has on a step.

### 7.6 known failure modes
The dynamic-route endpoint being the *deprecated* OpenAI-compat path is a maintenance smell (**risk**).
Hosted/closed: unavailable offline; adds a network dependency. No issue tracker to mine.

---

## 8. Vercel AI Gateway (as a router)

### 8.1 what it is, license, activity
"Call AI models across providers with Vercel AI Gateway. Use one managed gateway from any
infrastructure to centralize credentials, log requests, control spend, and fail over across
providers." **Closed managed service**; last updated 2026-09-14
(<https://vercel.com/docs/ai-gateway>).

### 8.2 access method
System credentials (pay-as-you-go, "zero markup") or **BYOK**; budgets per team/project/key with
soft caps. "If a BYOK request fails, AI Gateway can fall back to system credentials."

### 8.3 routing & fallback
- **Model fallbacks**: `providerOptions.gateway.models = ['anthropic/claude-opus-5',
  'google/gemini-3.1-pro-preview']` tried in order; combined with `order: ['azure','openai']` for
  per-model provider preference. Works across AI SDK, Chat Completions, Messages, Responses.
- **Failure semantics**: routes primary → per-model provider order/`only` → next model in `models[]`;
  first success wins. Response provider metadata includes **`modelAttempts[]`**, each with
  `canonicalSlug`, `modelId`, `success`, `providerAttemptCount`, and per-attempt
  `{attemptNumber, provider, modelId, success, credentialType, responseTimeMs, error, statusCode,
  providerResponseId}`. This is a **ready-made telemetry contract** for Ferry.
- `429` handling has its own doc (`/docs/ai-gateway/rate-limits`).

### 8.4 quota, catalog, tools
Budgets ("rejects new system-credential requests after an applicable budget is exceeded"); request
logs with routing attempts. Catalog is live ("200+ models"). Modalities include text/image/video/
speech/embeddings/rerank; tools/file input where the model supports them; no capability-based
rerouting evidenced.

### 8.5 standout ideas
- **`modelAttempts[]`** — copy this schema into `@ferry/shared` for `RawCallObservation`/handoff
  telemetry.
- **`models[]` + `order[]`** is a clean two-dimensional fallback (which model × which provider).
- **BYOK-falls-back-to-system-credentials** with explicit soft-cap semantics — the same
  BYOK/PTB distinction Helicone makes.

### 8.6 known failure modes
Closed, hosted, network dependency. Budget semantics are explicitly "soft-cap" (may overshoot), and
BYOK spend is metered separately and "does not count toward those limits" — a billing seam Ferry must
model if it ever proxies paid lanes.

---

## 9. Requesty (hosted router)

### 9.1 what it is, license, activity
Hosted LLM router/gateway: "600+ AI models … change your base URL to `router.requesty.ai`".
**Closed**, no self-hosting ("Not today"). <https://www.requesty.ai/>, docs
<https://docs.requesty.ai/features/fallback-policies>. Stats like "70,000+ developers … 90+ billion
tokens daily", "99.99% uptime", "failover … under 14 ms" are **claimed**.

### 9.2 access method
Managed keys by default (5% markup) **or BYOK (0% markup)**, with four key-selection modes:
Requesty key / my key / Requesty-first-then-mine / mine-first-then-Requesty. Free tier "200 requests
per day on free models" (**claimed**).

### 9.3 routing & fallback
Three policy strategies: **Failover** (ordered; "A 429 or 5xx on one moves the request to the next"),
**Load balance** (weighted shares), **Latency** (scores time-to-first-token and generation speed,
order ignored). Policies are named and referenced as `policy/<name>` in the model field, and can be
**nested** ("a latency policy per region, a failover across them"). Each model in a chain gets 0–10
retries with **exponential backoff 500ms→1s→2s→4s + ±10% jitter** and **immediate failover on
non-retryable errors (invalid request, auth failure)**. Region-pinned chains never fail over out of
region. "You only pay for successful requests."

### 9.4 quota, catalog, tools
Hard caps per key/user/team/org with alerts at 80%; spend attribution by model/team/user/feature.
Catalog is static-ish (600+ models, filterable by provider/region/data policy). Requests with
parameters a model can't handle "skip to the next model" — a capability check in the chain, but
**claimed** in docs, implementation unknown. Five-layer RBAC, SSO, EU/US/AP gateways, ZDR pinning.

### 9.5 standout ideas
- **Policy-as-model-string** (`"model": "policy/prod-chain"`) — users edit routing without shipping
  code; ideal for Ferry's profiles.
- **Scope hierarchy that can narrow but never widen** (`org → group → user → key`; "A scope can
  narrow what it inherits. It can never widen it.") — a strong invariant for Ferry's quota limits.
- **Retry-then-failover with immediate failover on non-retryable errors** matches Bifrost's model and
  Ferry's classifier need.

### 9.6 known failure modes
Closed/hosted; the "zeros and milliseconds" numbers are marketing (**claimed**). A 5% markup applies
unless BYOK — an economic reason Ferry should keep BYOK-first. No issue tracker.

---

## 10. Unify — pivoted away (historical)

`unify.ai` is now "a research lab working on continual learning"; the homepage describes
"systems that improve from a stream of experience without forgetting what they know." A tracking site
states the router product is gone and the pricing page returns 404
(<https://www.getsnippets.ai/gateways/discontinued>, checked 2026-09-01).
**Do not treat Unify as a candidate.**

Historically (for reference only): the `unifyai` Python package did per-request routing across 100+
providers using a `model@provider` / `model@routing-mode` syntax (`lowest-input-cost`, etc.), with
"live runtime benchmarks". The current `unifyai/unillm` repo ("LLM access layer", **MIT**) is only a
provider-normalization client with caching, OTel and a `model@provider` endpoint format; it has **1
star, 1 fork** and its own README says it "is the model-access layer of unify-agent, a self-improving
agent harness" (<https://github.com/unifyai/unillm>). Star counts on archived/forked Unify repos are
tiny; the older `unifyai/ivy` (14k stars) is unrelated (framework transpilation).

**Takeaway:** the once-famous "benchmark-driven neural router" is no longer a product. Its idea
(per-prompt quality scoring as a routing term) is already captured as an *optional* escalation signal
in `routing-comparison.md` §12 item 12.

---

## 11. Martian — no longer a public router (historical)

`withmartian.com` is described by a third-party comparison as "now Thesean AI, a research lab for
best-execution LLMs", and the pricing page returns 404
(<https://www.eggstriker.com/en/ai-api/martian>, 2026-08-15; corroborated by
<https://apio.sh/apis/martian>: "Official pricing page (withmartian.com/pricing) returns 404").
**Do not treat Martian as a live candidate.**

The docs at `docs.withmartian.com` still describe a **Martian Gateway** with "200+ models … both
OpenAI-compatible and Anthropic-compatible endpoints", prices "updated every 5 minutes", and a
LiteLLM integration for "an additional layer of routing, load balancing, and spend tracking"
(<https://docs.withmartian.com/integrations/litellm>, <https://docs.withmartian.com/api-reference/models>).
The ToS is a proprietary "Martian Learning Terms of Service" with usage-based fees and explicit
warranty disclaimers; **the gateway itself is closed** (only research repos like `routerbench`,
`ares`, `llm-adapters` are open source) (<https://github.com/withmartian>). A third-party directory
notes "No self-hosted/open-source option for the gateway itself" and lists no documented BYOK
(<https://apio.sh/apis/martian>, **claimed/third-party**).

**Takeaway:** closed, gateway-key-only, no BYOK, no public pricing — incompatible with Ferry's
BYOK-first, offline rule. The one durable artifact is the **RouterBench** benchmark (see Data sources).

---

## 12. The one-api / new-api / uni-api aggregator family

These are **key-redistribution systems** ("put many provider keys behind one OpenAI-compatible
endpoint"), usually deployed for resale or team sharing. They are not agent-aware routers.

### 12.1 one-api (`songquanpeng/one-api`)
LLM API management & key redistribution across OpenAI/Azure/Anthropic/Gemini/DeepSeek/Groq/Ollama/...
**MIT** (with a required footer attribution back to the project); ~36.6k stars, ~6.8k forks, ~1,032
open issues, created 2023-04-22 (<https://github.com/songquanpeng/one-api>). Access method = **pooled
keys** (you supply provider keys; it reissues tokens).

**Routing/fallback (source-read):** `controller/relay.go` `Relay()` implements retry by picking a
**random satisfied channel** for the group/model, with `retryTimes = config.RetryTimes`, skipping the
last failed channel (`if channel.Id == lastFailedChannelId { continue }`). `shouldRetry` retries on
`429` and `5xx`/other, and does **not** retry on `400` or `2xx`. On relay error it calls
`processChannelRelayError` → `monitor.ShouldDisableChannel` → `DisableChannel`. There is **no model
capability gate, no provider-header quota parser, and no per-key cooldown ledger** in the code read.

**Concern:** its entire purpose is key pooling/redistribution, which `routing-comparison.md` §13
already flags as a ToS/bans risk. Ferry should not adopt the pooling model.

### 12.2 new-api (`QuantumNous/new-api`, fork of one-api)
"A unified AI model hub for aggregation & distribution" that cross-converts OpenAI/Claude/Gemini
formats. **AGPL-3.0** with extra attribution terms; ~46.7k stars, ~11.3k forks, ~1,354 open issues,
created 2023-11-10 (<https://github.com/QuantumNous/new-api>). Docs
<https://docs.newapi.ai/en/docs/guide/feature-guide/admin/channel>.

**Routing/fallback:** channels have `priority` (higher selected first) and `weight` (random among
same priority); **Multi-Key mode** polls multiple keys in a channel (round-robin or weighted random)
and "a failed key is skipped automatically and re-enabled when it recovers"; **Auto Disable** turns a
channel off after consecutive failures; channel retry/cache settings exist, plus user-level model rate
limiting. PR #4363 added `AutomaticDisableChannelThreshold` (default 1) so a channel disables only
after N **consecutive** matching failures; "any successful relay on that channel/key resets its
counter to zero", and generic transient 5xx/network errors do **not** advance the counter
(<https://github.com/QuantumNous/new-api/pull/4363>). That "reset on success + only count matching
errors" rule is exactly the success-decay behavior Ferry wants.

**Concern:** AGPL-3.0 is copyleft over the network; do **not** copy its code into Ferry. Pooling model
again not adoptable as a default.

### 12.3 uni-api (`yym68686/uni-api`)
A deliberately lean single-file-ish aggregator: config `api.yaml`, many backend providers converted to
OpenAI format, **MIT**, ~1.2k stars (<https://github.com/yym68686/uni-api>). Each model can list
multiple providers and "automatically enable polling load balancing" across keys. **Critically, its
own README states it does not handle automatic retries or failover — "`uni-api` currently provides
backend … only capabilities. `uni-api` does not handle automatic retries or failover; … 'only'
design."** Catalog is static YAML. **Skip** for resilience; useful only as a purity reference (a
gateway that *knows* it is not a router).

### 12.4 what to borrow from the family
- new-api's **consecutive-failure threshold + reset-on-success + transient-errors-don't-count** rule
  (already aligned with `routing-comparison.md` §12 items 4 and 7).
- channel `priority` then `weight` selection (maps to Ferry's profile ordering + tie-break).
- The cautionary tale: pooled keys cause shared-fate lockouts; Ferry's one-key-per-provider stance is
  right.

---

## 13. gpt4free (g4f) — the scraper class (`avoid`)

`xtekky/gpt4free` "aggregates multiple accessible providers and interfaces", including
"OpenAI-compatible endpoints, **PerplexityLabs, Gemini, MetaAI, Pollinations** (media)". **GPL-3.0**;
~66.6k stars, 13.5k forks; created 2023-03-29 (<https://github.com/xtekky/gpt4free>). Access method =
**scraping/wrapping vendor web surfaces**, not a first-party API. Its `LEGAL_NOTICE.md` says it is
"**not associated with or endorsed by** the providers", "intended **for educational purposes only**",
and disclaims all warranties and liability.

**Routing/fallback:** a provider registry plus retries/rotation across scraped providers; models
change without notice. Tool calling is inconsistent (it depends on the wrapped surface).

**Verdict: avoid**, consistent with `free-providers.md:367` and `routing-comparison.md` §13 (cookie/
web-session providers are ToS-hostile and produce fingerprint rejections/brittle streams). The GPL-3.0
license would also infect Ferry's codebase. No separate issue analysis needed: the design itself is
out of bounds.

---

## 14. LobeHub provider layer (`lobehub/lobehub`, formerly `lobe-chat`)

### 14.1 what it is, license, activity
LobeHub's `packages/model-runtime` is a client/server provider runtime with a genuine **router runtime
and error classifier**. **MIT**; the repo is large and very active (see
<https://github.com/lobehub/lobehub>). It supports many providers and a `lobehub` hosted channel.

### 14.2 access method
BYOK, with a hosted LobeHub channel as an alternative. `RouterRuntime` reuses server/config routers.

### 14.3 routing & fallback (source-read)
`packages/model-runtime/src/core/RouterRuntime/createRuntime.ts`:
- A router's `options` may be **an array**; items are tried in order for chat fallback, and each item
  can override `apiType` to switch provider on fallback (`RouterOptionItem`).
- `runWithFallback(model, requestHandler, metadata)` resolves a matched router (fallback = "the last
  router"), normalizes options, and loops: on error it stores `lastError`, calls
  `params.shouldStopFallback?.({...})` (a caller hook to abort the chain), and continues; if
  `isNonRetryableRequestError(error)` it throws immediately. It emits **`onRouteAttempt`** telemetry
  per attempt (`success`, `durationMs`, `error`, `channelId`, `apiType`, `routerId`).
- PR #11531 ("feat(router-runtime): add fallback options") applied the same fallback flow to chat,
  `generateObject`, `createImage`, `embeddings`, `textToSpeech`
  (<https://github.com/lobehub/lobehub/pull/11531>).

`apps/server/src/.../AgentRuntime/llmErrorClassification.ts` is the clearest new artifact:
- Builds `RETRY`/`STOP` sets from an `ERROR_CODE_SPECS` table, plus deliberate overrides
  `RETRY_OVERRIDES = {AgentRuntimeError, OllamaServiceUnavailable, ProviderBizError, StreamChunkError}`
  ("a retried call frequently succeeds, so the operational retry loop is more aggressive than the
  spec's intrinsic retryability").
- `classifyKind`: `401/403 → stop`; `400/404/409/422 → stop`; `408/425/429/5xx → retry`; then keyword
  sets; **default is `retry`**. It has a defensive outer try/catch that returns `stop` with the
  original message so a classifier bug never masks the provider error.
- It extracts numeric status from `code`/`status`/`statusCode` and normalizes nested error shapes.

### 14.4 quota, catalog, tools
Cost/token accounting in the host app; no provider-free-tier quota parsing. Model metadata is bundled
and remote. Tool/protocol adaptation (Chat Completions vs Responses API) is per provider: known bug
where a local llama.cpp was forced onto the Responses API and choked on `item` payloads.

### 14.5 standout ideas
- **The `retry|stop` classifier with a defensive fallback** is the single best new snippet here; it
  generalizes `StepError.kind` and pairs with OmniRoute's typed families (already recommended).
- **`shouldStopFallback` hook** lets the caller abort a fallback chain (e.g., compliance) — same seam
  as Bifrost's `AllowFallbacks=false`.
- **`onRouteAttempt` telemetry per attempt** — the attempt-audit pattern again.
- **Non-retryable short-circuit** (`isNonRetryableRequestError`) before any fallback.

### 14.6 known failure modes (rich)
- [#17594](https://github.com/lobehub/lobe-chat/issues/17594): after a retry-classification refactor,
  a 6/6 retry loop was triggered for upstream "busy" errors, and a local llama.cpp failed because the
  runtime forced the Responses API (`item` payloads) — the failure was in the **classification +
  protocol-selection seams**, which is the exact class Ferry must test.
- [#17511](https://github.com/lobehub/lobehub/issues/17511): an explicitly configured sub-agent model
  was **silently overwritten by the parent topic's pinned model**; the fix required "explicit model
  override > topic-pinned model > agent default". This is the same class as pi-free #576 — Ferry's
  manual selection must be authoritative and fallback must never clobber it.
- The error-classification churn (PR #15286/#16024/#16053/#17089) shows how quickly keyword-based
  classifiers become over-broad.

### 14.7 license
MIT (`lobehub/lobehub`). Safe to adapt the classifier and fallback loop with attribution.

---

## 15. Open WebUI pipelines / functions

### 15.1 what it is, license, activity
Open WebUI is a self-hosted chat UI; **Pipelines** (`open-webui/pipelines`) is a
"UI-Agnostic OpenAI-Compatible Plugin Framework" where a `pipe` function can call any provider or run
custom logic and return results to the client. **Pipelines is MIT** (~2.4k stars, 684 forks, 544
commits; <https://github.com/open-webui/pipelines>). **Open WebUI core is *not* plain MIT**: its
LICENSE is the "Open WebUI License with an additional requirement to preserve the Open WebUI
branding", with `LICENSE_HISTORY`/`LICENSE_NOTICE` files (<https://github.com/open-webui/open-webui>).

### 15.2 status & access
Docs mark Pipelines **legacy**: "Pipelines are outdated and legacy, and are no longer recommended …
A Pipeline can run as a pipe or as a filter; both forms now have in-process replacements … Filter →
Filter Function, custom provider/RAG/request routing → Pipe Function."
(<https://docs.openwebui.com/features/extensibility/pipelines/>). Access method is BYOK (or local
Ollama). There is **no built-in router**: routing is whatever Python the operator writes
(`examples/pipelines/providers/openai_pipeline.py` just posts to `https://api.openai.com`).

### 15.3 standout ideas
- **The pipe/filter plugin seam** — an operator can inject arbitrary pre/post-processing and provider
  selection *without changing the core*; Ferry's `@ferry/optimizer` filters and `@ferry/providers`
  adapters are the analogous seam.
- Warning worth heeding: "Pipelines are a plugin system with arbitrary code execution — don't fetch
  random pipelines from sources you don't trust." Ferry's bundled-skills model should keep that
  distrust for third-party routing code.

### 15.4 known failure modes
Pipelines are deprecated; a separate worker container and arbitrary code execution are operational
liabilities. **Core license branding clause** means Ferry must not copy Open WebUI UI code without
checking it. Use only as a design reference.

---

## 16. Jan and Msty (desktop clients)

### 16.1 Jan (`menloresearch/jan`, formerly `janhq/jan`)
Open-source desktop app that runs models 100% offline plus cloud providers (OpenAI, Anthropic, Mistral,
Groq, MiniMax); local OpenAI-compatible server at `localhost:1337`; MCP integration. **LICENSE says
Apache-2.0** ("Copyright 2025 Menlo Research") (<https://github.com/menloresearch/jan>); ~43.2k stars,
2,869 forks, 469 open issues. **Caveat:** llama.cpp's ecosystem list labels `janhq/jan` as **AGPL**
(<https://github.com/ggml-org/llama.cpp#projects-using-llama.cpp>) — a license discrepancy worth
verifying before reuse. Architecture is a Tauri app + TS core SDK + extensions (`llamacpp`,
`hardware`); providers are selected by the user, with **no automatic cross-provider failover**
evidenced.

### 16.2 Msty (closed)
Desktop + web AI chat app; supports local engines (Ollama/MLX/Llama.cpp), remote providers (OpenAI,
Claude, Gemini, Groq, OpenRouter, "any OpenAI-compatible"), and can act as a **secure proxy so the web
version reaches local resources**; the "Msty Sidecar" proxies local AI/tools to the web app; tunnels
(Tailscale) for remote access. **Closed source.** Docs: <https://docs.msty.app/getting-started/onboarding>,
<https://docs.msty.ai/studio/settings/remote-connections>. No cross-provider routing/fallback
evidenced; it is a provider manager.

### 16.3 what Ferry can use
- Jan/Msty confirm the **local server as a fallback endpoint** pattern: a desktop app exposing
  `localhost` OpenAI-compatible APIs, which Ferry can treat as a zero-cost lane.
- Msty's **local service exposed on the LAN + token-authenticated tunnel** is the security shape
  Ferry's desktop would need if it ever exposes its own local model server.
- Neither is a routing reference; both are **UI/UX and local-endpoint references**.

---

## 17. Ollama and LM Studio (local fallback endpoints)

### 17.1 Ollama (`ollama/ollama`)
MIT (`LICENSE`, <https://github.com/ollama/ollama>). Local inference server with a native API
(`/api/chat`, `/api/generate`, `/api/tags`, `/api/show`) and OpenAI-compatible endpoints. Relevant,
source-backed facts from `docs/api.md`:
- `/api/chat` accepts `tools` (OpenAI-style function specs) and returns `message.tool_calls`;
  streaming is supported (`docs/api.md`, "Tool calling").
- `/api/show` returns a **`capabilities`** array (e.g. `["completion","vision"]`) and model details
  (`details`, `model_info` including `*.context_length`). This is a usable **capability dataset for
  local models** — Ferry can read it to gate tool/vision steps.
- `/api/tags` lists local models (the "catalog" for a local lane).
- No routing/failover: Ollama is a single-server runtime, so Ferry's router must decide when to use it.

### 17.2 LM Studio (closed)
Local server with OpenAI-compatible `/v1/models`, `/v1/chat/completions`, `/v1/responses`,
`/v1/embeddings` and an Anthropic-compatible `/v1/messages`, so any OpenAI/Anthropic client can point
at `localhost:1234/v1` (<https://lmstudio.ai/docs/developer/openai-compat>). **Closed source**, no
routing/failover. Useful to Ferry only as a **zero-cost fallback endpoint** and a second local
capability source (its REST API exposes max context/quantization/loaded state).

### 17.3 standout idea
Treat local runtimes as **first-class cheap providers with a capability manifest** (`/api/show`
`capabilities`; LM Studio model metadata), and place them behind *paid* lanes in the ladder — local
first is not always right (a small local model can fail a tool step), so capability gates matter.

---

## New things Ferry should borrow

Ranked by expected survival gain per unit of risk. Each item names the target Ferry package
(`ARCHITECTURE.md:10–22`). Licenses are per the sections above; all listed sources are
Apache-2.0/MIT unless stated.

1. **A two-layer retry→fallback engine with per-key rotation classes** (target: `@ferry/router` +
   `@ferry/providers`). Copy Bifrost's split: transient `5xx`/network reuse the same key with
   exponential backoff + jitter; `429` rotates key **with** backoff; `401/402/403` rotate **without**
   backoff and mark the key dead for the request; each provider/fallback gets its **own** retry budget.
   Source: Bifrost `docs.getbifrost.ai/features/retries-and-fallbacks` (Apache-2.0). Ferry's current
   one-fast-retry-for-`rate_limit` rule (`router/src/index.ts:389–403`) is too narrow. *Effort: M.*

2. **A typed `retry|stop` classifier with a defensive default** (target: `@ferry/shared` error kinds +
   `@ferry/router`). Port LobeHub's `llmErrorClassification.ts`: status-first (`401/403/400/404/409/422
   → stop`; `408/425/429/5xx → retry`), then keyword sets, then **default `retry`**, wrapped in a
   try/catch that falls back to `stop` preserving the original error. Pair it with Bifrost's distinct
   `upstream_credentials_exhausted` and OmniRoute's typed families (already adopted). License MIT
   (`lobehub/lobehub`). *Effort: S–M.*

3. **`upstream_credentials_exhausted` (and never leak a raw provider 4xx when the pool is dead)**
   (target: `@ferry/shared` + `@ferry/router`). Bifrost returns a distinct `502` so the caller knows
   their own credential is fine. Generalize to a typed "all candidates cooling/exhausted" error that
   names the binding timer — this is the non-empty-ladder invariant from `routing-comparison.md` §12
   item 5, now with a concrete error shape. Source: Bifrost (Apache-2.0). *Effort: S.*

4. **A per-request routing-attempt audit trail** (target: `@ferry/shared` `RawCallObservation` +
   `@ferry/router` handoff briefing). Copy Vercel's `modelAttempts[]` (`canonicalSlug`, `modelId`,
   `success`, per-attempt `provider`, `statusCode`, `responseTimeMs`, `credentialType`, `error`) and
   Bifrost's per-request routing-engine log. Feed Ferry's handoff briefing
   (`router/src/index.ts:427–504`) and the health surface. Vercel docs (closed service; schema is a
   public contract). *Effort: S–M.*

5. **A caller hook to stop a fallback chain + non-retryable short-circuit** (target: `@ferry/router`).
   LobeHub's `shouldStopFallback` and `isNonRetryableRequestError`; Bifrost's `AllowFallbacks=false`.
   Lets Ferry halt fallback for policy/compliance or a user-pinned model. License MIT. *Effort: S.*

6. **BYOK-first, cost-sorted, managed-key-fallback with a per-provider opt-out** (target:
   `@ferry/router` lane ordering + `@ferry/quota`). Helicone's `packages/cost/FLOWS.md`: "all BYOK
   endpoints first (sorted by cost), then all PTB"; `byok_only` per provider forces hard failure
   instead of silently spending managed credits. Directly usable for Ferry's optional paid lanes.
   Apache-2.0. *Effort: S–M.*

7. **A paced, out-of-region-aware failover suite with nested policies** (target: `@ferry/router`
   profiles). Requesty's failover/loadbalance/latency policies referenced as `policy/<name>`, with
   retries 0–10, exponential backoff + jitter, immediate failover on non-retryable errors, and
   region-pinned chains that never leave region. Treat the marketing numbers as **claimed**; borrow the
   *policy shape*, not the claims. Closed service. *Effort: M (optional).*

8. **Quota/budget gates as pre-dispatch routing nodes that switch to fallback** (target:
   `@ferry/quota` + `@ferry/router`). Cloudflare's Dynamic Routing Rate/Budget Limit nodes and Otari's
   "enforce budgets before dispatch, record usage afterwards" (Apache-2.0). Ferry already has
   `QuotaObservation`/`ParsedQuotaWindow` contracts (`ARCHITECTURE.md:40–42`); this defines *where*
   the check runs in the step flow. *Effort: M.*

9. **Consecutive-failure threshold with reset-on-success and transient-errors-don't-count** (target:
   `@ferry/providers` health + `@ferry/router`). new-api PR #4363 is the cleanest statement of the rule
   (default threshold 1; any success resets the counter; generic 5xx/network errors don't advance it).
   **AGPL-3.0 is ideas-only — do not copy code.** *Effort: S.*

10. **A model-metadata/capability manifest for local lanes** (target: `@ferry/catalog` +
    `@ferry/providers`). Read Ollama's `/api/show` `capabilities` (+ `model_info` context length) and
    LM Studio's model metadata to gate local models on `tools`/`vision` before routing an agent step
    to them. Ollama MIT, LM Studio closed (endpoint only). *Effort: S.*

11. **A plugin/pipe seam for user-supplied routing filters** (target: `@ferry/optimizer` /
    `@ferry/router`). Open WebUI's pipe/filter model (MIT) is the pattern; keep its explicit warning
    about arbitrary third-party code and sandbox accordingly. *Effort: M (optional).*

12. **Route versioning with instant rollback** (target: `@ferry/router` profiles / `@ferry/config`).
    Cloudflare's draft→deploy→rollback versioning for routing graphs is a good UX for user profiles.
    Closed service; borrow the concept. *Effort: S–M (optional).*

**Explicitly do not borrow:** key/account pooling (one-api/new-api/uni-api; ToS and shared-fate risk —
`routing-comparison.md` §13), scrapers (g4f; GPL-3.0 + ToS-hostile), closed router products as a core
dependency (Requesty/Martian/Unify/Kong tier ambiguity), TensorZero (archived), and Bifrost's
full-replacement config `PUT` footgun.

---

## Data sources Ferry can use

For Ferry's `@ferry/catalog`, `@ferry/quota` and capability gating. Verify licenses line-by-line
before vendoring into the repo; merge rules (static → live overlay) are already described in
`routing-comparison.md` §12 item 8.

| Dataset | What it gives | License | Access / cadence | Notes |
|---|---|---|---|---|
| **models.dev** (`sst/models.dev`) | Provider-agnostic model facts (`family`, `release_date`, `knowledge`, `attachment`, `tool_call`, `reasoning`, `structured_output`, `temperature`), `[limit]` context/input/output, `[modalities]`, `open_weights`, `cost`, plus provider-specific serving/pricing via `base_model` inheritance | **MIT** | Static TOML in repo + JSON endpoints `https://models.dev/api.json`, `/models.json`, `/catalog.json`; community-contributed; used internally by opencode | Best single free capability+price source; 6.5k stars; schema documented in README. Prefer `models.json` for provider-agnostic facts, `catalog.json` for endpoints+facts. <https://github.com/sst/models.dev> |
| **Helicone cost package** (`Helicone/helicone` `packages/cost/`) | Typed model registry: pricing (prompt/completion/cache/audio tokens, per-image, per-call), `contextLength`, `maxCompletionTokens`, `supportedParameters`, endpoint/deployment overrides, BYOK/PTB flags | **Apache-2.0** (repo) | Static TS under `authors/<provider>/...` plus a live API `https://www.helicone.ai/api/llm-costs` (JSON/CSV, filterable); community PRs | 300+ models; O(1) Map indexes; "largest open-source pricing DB" is **claimed** but the package is real. <https://github.com/Helicone/helicone/blob/main/packages/cost/README.md> |
| **LiteLLM pricing/context JSON** | `model_prices_and_context_window.json`: per-model input/output/cache cost, context window, `supports_function_calling`, `supports_vision`, etc. | **MIT** (repo; avoid `enterprise/`) | Static file updated per release (`litellm/model_prices_and_context_window_backup.json`) | Already the catalog basis for Mirrowel's proxy (first report §5.1) and widely used. Great breadth; staleness is release-driven. <https://github.com/BerriAI/litellm> |
| **OpenRouter `/api/v1/models`** | Live per-model pricing, `context_length`, `architecture.input_modalities`, `supported_parameters` (incl. `tools`), provider list | Docs/site (gateway closed); model metadata is public | **Live** HTTP; no key needed for the models list | Best live source for parameter-level capability (`tools`, `response_format`). Re-verify ToS for redistribution. <https://openrouter.ai/docs> |
| **Vercel AI Gateway models** | Public model list/pricing/capabilities for 200+ models; request-time `modelAttempts[]` metadata | Closed service | Live `<https://ai-gateway.vercel.sh/...>` + docs | Use as a **cross-check** for models.dev/LiteLLM, not as an offline dependency. <https://vercel.com/docs/ai-gateway/models-and-providers> (docs) |
| **Cloudflare Workers AI model search** | Workers AI model catalog + task/modality metadata | Closed service | Live `GET /accounts/{id}/ai/models/search` (auth) | Only useful for the Cloudflare lane. <https://developers.cloudflare.com/workers-ai/> |
| **Provider `/v1/models` + free-tier docs** | Live model ids and per-provider free limits; runtime `x-ratelimit-*` headers | Per provider | Live at runtime; docs re-verified quarterly | Already the basis of `docs/research/free-providers.md`; the honest catalog (no fabricated totals) should stay. |
| **Ollama `/api/show` + `/api/tags`** | `capabilities` (`completion`, `vision`, `tools`, ...), `model_info.*.context_length`, quantization; local model list | **MIT** | Live, local | Capability manifest for the local lane. <https://github.com/ollama/ollama/blob/main/docs/api.md> |
| **Martian RouterBench** (`withmartian/routerbench`) | Benchmark for multi-LLM routing (evaluate a router's cost/quality tradeoff) | Verify (repo) | Static research code | Useful to **evaluate Ferry's own scorer**, not to route production traffic. <https://github.com/withmartian/routerbench> |
| **Provider error/reset text** (Google `RetryInfo`, OpenAI/Groq/Mistral rate-limit headers) | Parse where a 429 is a short throttle vs a quota window and when it resets | n/a (protocol) | Live at runtime | Reinforces `routing-comparison.md` §12 item 2; no dataset needed. |

**Recommended cadence for Ferry:** (a) vendor a static snapshot of models.dev + Helicone/LiteLLM
pricing at build time for offline/desktop use, (b) refresh live overlays (`/models`, provider headers,
local `/api/tags`) at runtime behind a cache, and (c) re-run the free-tier doc review quarterly, since
free tiers (and the projects above) churn fast — as Unify, Martian and TensorZero demonstrate.

---

## Sources (primary)

- any-llm: <https://github.com/mozilla-ai/any-llm>, `LICENSE`, `README.md`, commit `664c551`, discussion #687.
- Otari: <https://github.com/mozilla-ai/otari>, `README.md`, `docs/routing.md`.
- aisuite: <https://github.com/andrewyng/aisuite>, `LICENSE`, `README.md`.
- TensorZero: <https://github.com/TensorZero/tensorzero> (archived 2026-06-12), `docs/gateway/guides/retries-fallbacks.mdx`.
- Helicone: <https://github.com/Helicone/helicone>, `packages/cost/README.md`, `packages/cost/FLOWS.md`, <https://docs.helicone.ai/gateway/overview>.
- Bifrost: <https://github.com/maximhq/bifrost>, <https://docs.getbifrost.ai/features/retries-and-fallbacks>, `/features/governance/routing`, `/enterprise/adaptive-load-balancing`, `docs/providers/provider-routing.mdx`.
- Kong: <https://developer.konghq.com/ai-gateway/load-balancing/>, <https://developer.konghq.com/plugins/ai-proxy-advanced/>, <https://github.com/Kong/kong>.
- Cloudflare AI Gateway: <https://developers.cloudflare.com/ai-gateway/>, `/features/dynamic-routing/`.
- Vercel AI Gateway: <https://vercel.com/docs/ai-gateway>, `/models-and-providers/model-fallbacks`.
- Requesty: <https://www.requesty.ai/>, <https://docs.requesty.ai/features/fallback-policies>, <https://www.requesty.ai/product/routing>.
- Unify: <https://unify.ai/>, <https://www.getsnippets.ai/gateways/discontinued>, <https://github.com/unifyai/unillm>.
- Martian: <https://docs.withmartian.com/api-reference/models>, <https://docs.withmartian.com/integrations/litellm>, <https://github.com/withmartian>, <https://www.eggstriker.com/en/ai-api/martian>, <https://apio.sh/apis/martian>.
- one-api: <https://github.com/songquanpeng/one-api>, `controller/relay.go`.
- new-api: <https://github.com/QuantumNous/new-api>, <https://docs.newapi.ai/en/docs/guide/feature-guide/admin/channel>, PR #4363.
- uni-api: <https://github.com/yym68686/uni-api>, `README.md`.
- gpt4free: <https://github.com/xtekky/gpt4free>, `LICENSE`, `LEGAL_NOTICE.md`.
- LobeHub: <https://github.com/lobehub/lobehub>, `packages/model-runtime/src/core/RouterRuntime/createRuntime.ts`, `apps/server/src/.../AgentRuntime/llmErrorClassification.ts`, PR #11531, issues #17594/#17511.
- Open WebUI: <https://github.com/open-webui/pipelines>, <https://github.com/open-webui/open-webui>, <https://docs.openwebui.com/features/extensibility/pipelines/>.
- Jan: <https://github.com/menloresearch/jan>, `LICENSE`; <https://github.com/ggml-org/llama.cpp> ecosystem list.
- Msty: <https://docs.msty.app/getting-started/onboarding>, <https://docs.msty.ai/studio/settings/remote-connections>.
- Ollama: <https://github.com/ollama/ollama>, `docs/api.md`.
- LM Studio: <https://lmstudio.ai/docs/developer/openai-compat>.
- Data sources: <https://github.com/sst/models.dev>, <https://github.com/Helicone/helicone/tree/main/packages/cost>, <https://github.com/BerriAI/litellm>, OpenRouter docs, <https://github.com/withmartian/routerbench>.
