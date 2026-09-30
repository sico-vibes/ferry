# Reasoning exposure across Ferry's free providers

Research note (RP1). Probes what reasoning, if any, each of Ferry's **configured free
providers** returns for a reasoning-inviting prompt, in which **wire format** it arrives, and
what Ferry must normalise. Docs + redacted fixtures only — no `src/` changes.

- Probe date: 2026-09-30 (UTC)
- Prompt (identical for every model): `Think step by step: what is 17*23? Answer briefly.`
- Path: Ferry's real request path — `createLanguageModel()` from `@ferry/providers` +
  `streamText()` (AI SDK v7), `stream: true`, `maxOutputTokens: 1024`, `maxRetries: 0`,
  recording `fetch` that captures the raw SSE while the SDK consumes it.
  Gemini also probed once through its **native** `streamGenerateContent` endpoint for
  comparison.
- Keys: providers present in the local Ferry data dir `.env.local`
  (Gemini, OpenRouter, Groq, NVIDIA, Mistral, Cerebras, OpenCode Zen). No key material is
  printed or stored anywhere; one request per model; raw samples are redacted.
- Model selection prioritised `packages/router/data/auto-free-chain.yaml`, then other free
  models discovered live via each provider's `/models`.

## Result matrix

`reasoning?` = a distinct reasoning stream reached the AI SDK. `size` = reasoning characters
streamed / `usage.reasoning_tokens` when reported. `before` = first reasoning delta vs first
answer delta (both seconds from request start); ``-`` when no reasoning.

| Provider | Model | reasoning? | Wire format | size (chars / r-tok) | before answer | Notes |
|---|---|---|---|---|---|---|
| openrouter | `nvidia/nemotron-3-super-120b-a12b:free` | yes | `reasoning` + `reasoning_details[]` | 72 / 19 | 0.81 → 1.82 | NVIDIA backend via OR |
| openrouter | `nvidia/nemotron-3-ultra-550b-a55b:free` | yes | `reasoning` + `reasoning_details[]` | 71 / 18 | 0.58 → 0.82 | |
| openrouter | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | yes | `reasoning` + `reasoning_details[]` | 357 / 90 | 0.31 → 3.90 | 149 deltas |
| openrouter | `poolside/laguna-s-2.1:free` | yes | `reasoning` + `reasoning_details[]` | 1556 / 557 | 0.60 → 11.58 | longest visible CoT |
| openrouter | `cohere/north-mini-code:free` | yes | `reasoning` + `reasoning_details[]` | 311 / 78 | 0.25 → 1.03 | |
| openrouter | `openrouter/free` (auto-router) | yes | `reasoning` + `reasoning_details[]` | 2185 / 933 | 0.54 → 18.79 | routed to a reasoning model |
| openrouter | `stealth/space-bunny-alpha` | yes | `reasoning` + `reasoning_details[]` | 154 / **0** | 1.44 → 1.87 | usage under-reports r-tok |
| openrouter | `liquid/lfm-2.5-2.6b:free` | yes | `reasoning` + `reasoning_details[]` | 1136 / 405 | 1.33 → 3.54 | |
| openrouter | `qwen/qwen3.8-27b:free` | **error** | — | — | — | HTTP 429 upstream shared pool |
| openrouter | `google/gemma-4-31b-it:free` | **error** | — | — | — | HTTP 429 upstream (Google AI Studio) |
| openrouter | `thinkingmachines/inkling:free` | **error** | — | — | — | HTTP 403 "only available on agentic harnesses" |
| gemini (compat) | `gemini-3.8-flash` | no | none (signature only) | 0 / 0 | text 2.87 | first try 503, retry OK |
| gemini (compat) | `gemini-3.6-flash` | no | none (signature only) | 0 / 0 | text 2.73 | |
| gemini (compat) | `gemini-3.5-flash` | no | none (signature only) | 0 / 0 | text 16.94 | thinks ~17 s, text hidden |
| gemini (compat) | `gemini-3.1-flash-lite` | no | none (signature only) | 0 / 0 | text 1.56 | |
| gemini (native) | `gemini-flash-latest` | yes | thought parts (`"thought": true`) | 355 / n/a | 8.87 → — | partial: 503 mid-stream |
| gemini (native) | `gemini-2.5-flash` | **error** | — | — | — | 404 "no longer available to new users" |
| gemini (native) | `gemini-3.7-flash` | **error** | — | — | — | HTTP 503 high demand |
| groq | `openai/gpt-oss-120b` | yes | `reasoning` (+ `channel:"analysis"`) | 79 / 24 | 0.35 → 0.41 | |
| groq | `qwen/qwen3.8-27b` | no | none | 0 / 0 | text 0.04 | |
| nvidia | `nvidia/nemotron-3-super-120b-a12b` | yes | `reasoning_content` | 71 / **0** | 0.46 → 0.70 | |
| nvidia | `openai/gpt-oss-120b` | **error** | — | — | — | 410 end-of-life 2026-09-03 |
| nvidia | `deepseek-ai/deepseek-v4.1-flash` | **error** | — | — | — | timeout: no bytes in 180 s |
| mistral | `codestral-latest` | no | none | 0 / 0 | text 0.24 | |
| mistral | `mistral-medium-latest` | **error** | — | — | — | HTTP 429, `x-ratelimit-limit-req-minute: 0` |
| mistral | `magistral-medium-latest` | **error** | — | — | — | HTTP 429 (same) |
| cerebras | `gpt-oss-120b` | yes | `reasoning` | 77 / 29 | 0.24 → 0.25 | reasoning+content in one delta |
| opencode (zen) | `nemotron-3-ultra-free` | **error** | — | — | — | HTTP 403 `FreeTierError` (see quirks) |

## Format taxonomy

### 1. `reasoning` string field — Groq, Cerebras
OpenAI-compatible delta with the reasoning text under `choices[].delta.reasoning`, streamed on
its own chunks before `choices[].delta.content`.

- Groq additionally tags every chunk `"channel":"analysis"` and, on the first chunk, still
  sends an empty `content:""` role chunk before reasoning starts.
- Cerebras sends no channel and can put **`reasoning` and `content` in the same delta** (e.g.
  `{"delta":{"content":"17 ","reasoning":" = 391. Provide brief answer."}}`). A chunk is not
  guaranteed to be reasoning-only or content-only.

### 2. `reasoning_details` array + `reasoning` string — OpenRouter
OpenRouter deltas for reasoning models carry **both**:

```json
{"delta":{"content":"","role":"assistant",
  "reasoning":"We",
  "reasoning_details":[{"type":"reasoning.text","text":"We","format":"unknown","index":0}]}}
```

- Free models stream reasoning **without** `include_reasoning` / `reasoning` being set.
  Ferry's `createOpenRouter(...)` never sets them, and reasoning still arrived for all seven
  working free models.
- OpenRouter's schema also permits `reasoning.summary` and `reasoning.encrypted` detail types.
  `encrypted` entries carry no readable text and must be preserved verbatim for replay, not
  displayed; `summary` is a condensed form, not full CoT.
- Non-OpenRouter backends hide behind this one format (the array is provider-agnostic).

### 3. `reasoning_content` string field — NVIDIA NIM
DeepSeek-style field: `choices[].delta.reasoning_content`. Streamed before `content`.
`usage.reasoning_tokens` is reported as `0` even though reasoning text is streamed.

### 4. Gemini thought parts (native only) — not on Ferry's compat lane
Native `v1beta/models/<m>:streamGenerateContent?alt=sse` with
`thinkingConfig.includeThoughts=true` returns:

```json
{"candidates":[{"content":{"parts":[{"text":"**Initiating…","thought":true}],"role":"model"}}]}
```

Ferry does **not** use this endpoint. On the **OpenAI-compat** endpoint Ferry uses, no thought
text is exposed at all: the final chunk only carries
`choices[].delta.extra_content.google.thought_signature`. Gemini-3.x clearly reasons (3.5-flash
held text for ~17 s) but the text is discarded by Google's compat shim.

### 5. Inline `<think>` tags
Not observed on any free model in this sample. Qwen/Nemotron free models routed through
Groq/Cerebras/OpenRouter all used a structured reasoning field instead. Treat inline tags as a
defensive fallback only (some R1-style or self-hosted endpoints still inline them).

## Provider quirks

- **Gemini**: reasoning is invisible on the compat lane — only `extra_content.google.thought_signature`
  survives. The signature *must* be round-tripped on tool calls (Ferry already does this in
  `packages/agent/src/loop.ts`), but it is not reasoning text. Very high latency spikes
  (HTTP 503 "high demand") are common on free tier; the same model succeeded on retry.
- **NVIDIA**: `openai/gpt-oss-120b` is gone (410, EOL 2026-09-03) even though the auto-free
  chain still lists it; `deepseek-ai/deepseek-v4.1-flash` accepted the connection but sent no
  bytes for 180 s (two attempts). `reasoning_tokens` is unreliable (0 with text present).
- **Groq**: cleanest `reasoning` field, but every reasoning chunk repeats
  `channel:"analysis"`; handle chunks that also carry empty `content`.
- **Cerebras**: `reasoning` and `content` co-occur in a single delta; do not assume
  mutual exclusivity per chunk. Free offer is a card-backed trial (already noted in the
  auto-free chain).
- **Mistral**: `codestral-latest` works and returns no reasoning; `mistral-medium-latest` and
  `magistral-medium-latest` are rate-limited to zero (`x-ratelimit-limit-req-minute: 0`), so
  the free tier currently cannot exercise their reasoning at all.
- **OpenCode Zen**: all free models return `403 FreeTierError: OpenCode's free tier can only
  be used from within OpenCode`. The configured key is unusable outside OpenCode, matching the
  existing `unsupported_free_tier` handling in `mapProviderError`.
- **OpenRouter**: reasoning works without opt-in, but the free pool is heavily contended —
  two models returned `429 … temporarily rate-limited upstream … shared_pool`, and
  `thinkingmachines/inkling:free` is gated to "agentic harnesses" (403). These are routing
  gates, not key errors.
- **Usage accounting**: `usage.reasoning_tokens`/`output_tokens_details.reasoning_tokens` is
  present on OpenRouter/Groq/Cerebras but zero on NVIDIA and on `stealth/space-bunny-alpha`
  despite streamed text. Do not use it as the source of truth for whether reasoning occurred.

## What Ferry must normalise

The AI SDK already collapses formats 1–3 into provider-agnostic `reasoning-delta` stream parts
(verified: every reasoning model produced `reasoning-start → reasoning-delta* → reasoning-end`).
**But Ferry currently throws those parts away** in both consumption paths:

- `packages/agent/src/loop.ts:1846-1852` (`createStepGenerator`) handles only `text-delta`; it
  never accumulates `reasoning-delta`.
- `packages/providers/src/index.ts` `streamProviderChat` (used by the gateway) likewise only
  reads `text-delta` / `tool-call`.

`GeneratedStep.reasoning` and the `{type:'reasoning'}` message part already exist, so the gap is
purely that production code never populates them. Minimum work:

1. **Consume `reasoning-delta`** in `createStepGenerator` (and `streamProviderChat`): accumulate
   into a separate buffer, emit as a `reasoning` part before/alongside the text part, and never
   concatenate it into the user-visible answer. Ordering is safe: reasoning always streams before
   the answer.
2. **Accept all field names if parsing SSE directly**: `reasoning`, `reasoning_content`,
   `reasoning_details[].text`; honour `reasoning.summary` vs `reasoning.text`; preserve
   `reasoning.encrypted` blobs without display. (If Ferry stays on the AI SDK, one
   `reasoning-delta` handler covers all of them — preferred.)
3. **Handle per-chunk co-occurrence** (Cerebras) — process `reasoning` and `content` keys
   independently within one delta.
4. **Gemini**: decide consciously. Either (a) accept that the compat lane exposes no reasoning
   and display nothing, while continuing to round-trip `thought_signature` for tool calls; or
   (b) add a native Gemini lane with `thinkingConfig.includeThoughts=true` and map
   `parts[].thought === true` to reasoning parts. Do not present `thought_signature` as reasoning.
5. **Do not gate reasoning rendering on `reasoning_tokens`** — it is frequently 0 while text
   exists.
6. **Inline `<think>` guard**: optionally strip/relocate inline `…` blocks from content for
   older/self-hosted endpoints.

## Errors observed (all non-fatal to the probe)

| Error | Providers / models |
|---|---|
| 403 free-tier policy | `opencode/*` (Zen `FreeTierError`); `openrouter/thinkingmachines/inkling:free` (agentic-harness gate) |
| 410 end-of-life | `nvidia/openai/gpt-oss-120b` |
| 429 rate limit / shared pool | `openrouter/qwen/qwen3.8-27b:free`, `openrouter/google/gemma-4-31b-it:free`, `mistral/mistral-medium-latest`, `mistral/magistral-medium-latest` |
| 404 / 503 upstream availability | `gemini-native/gemini-2.5-flash` (404), `gemini-native/gemini-3.7-flash` (503), first `gemini/gemini-3.8-flash` attempt (503, retry OK) |
| timeout (180 s, no bytes) | `nvidia/deepseek-ai/deepseek-v4.1-flash` |

## Auto-free-chain resolution (providers with keys)

- **Resolved live**: Gemini `gemini-*-flash-lite*`, `gemini-3.*-flash`, `gemini-3.8-flash`,
  `gemini-flash-latest`; Groq `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`; NVIDIA
  `nvidia/nemotron-3-super-*`, `nvidia/nemotron-3-ultra-*`; Mistral `codestral-*`,
  `mistral-medium*`; OpenRouter `nvidia/nemotron-3-super*:free`, `nvidia/nemotron-3-ultra*:free`.
- **Chain entry no longer resolves**: Groq `qwen/qwen3-coder*`; NVIDIA
  `deepseek/deepseek-v4-flash*` (live id is `deepseek-ai/deepseek-v4.1-flash`, and it hangs) and
  `openai/gpt-oss-120b` (410 EOL); Mistral `devstral-*`; OpenRouter `openai/gpt-oss-120b:free`,
  `deepseek/deepseek-v4-flash:free`, `z-ai/glm-5*:free`, `minimax/minimax-m3:free`,
  `minimax/minimax-m2.5:free`, `qwen/qwen3-coder:free`.
- `sambanova`, `kilo`, `cloudflare-workers-ai` were not probed: no key present in the local
  Ferry data dir (SambaNova `DeepSeek-R1` would be a valuable additional reasoning sample).

## Fixtures

`packages/testkit/fixtures/reasoning/` — one redacted raw SSE sample per format, each with the
exact request body, timing, and size:

- `openrouter-reasoning-details.json` — format 2 (OpenRouter).
- `openai-compat-reasoning.json` — format 1 (Groq; notes Cerebras co-occurrence).
- `openai-compat-reasoning-content.json` — format 3 (NVIDIA NIM).
- `gemini-native-thought-parts.json` — format 4 (native Gemini, partial due to mid-stream 503).
- `gemini-openai-compat-none.json` — Gemini compat: no reasoning, `thought_signature` only.
- `mistral-none.json` — OpenAI-compatible model with no reasoning channel.

## Caveats

- One request per model, so figures are single-shot (reasoning length and timing vary run to run).
- Free pools are contended: 429/503 are expected and are not signals about the model's format.
- Model availability drifts quickly (NVIDIA EOL, Gemini 2.5 retired for new users); re-run
  `pnpm probe:live`-style discovery before acting on chain entries.
