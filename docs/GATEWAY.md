# Ferry Gateway

Ferry Gateway exposes Ferry's configured providers through a local OpenAI-compatible API and an Anthropic Messages endpoint. It uses the provider accounts configured in Ferry; a `ferry-gw-…` key only authenticates a local client and does not represent pooled provider access.

## Start and create a key

In Ferry, open **Settings → Gateway**, enable the gateway, and create a named key. The secret is shown once. Ferry stores its SHA-256 hash in its local SQLite settings table; the provider credentials remain in Ferry's secret store.

The default listener is `127.0.0.1:11435`. If that port is busy, Ferry selects an available local port and shows the chosen URL. LAN binding is off by default. Enabling it binds all interfaces, so use it only on a trusted network. `/health` returns service status and never returns a key or provider data.

Available profile aliases are `ferry/auto-free`, `ferry/best`, `ferry/fast`, and `ferry/long-context`; these reserved aliases take precedence over user mappings. Logical model names such as `gpt-oss-120b` map to one or more provider-specific upstream IDs and are resolved through the selected profile's normal eligibility, free-first scoring, quota checks, and handoff rules. Enabled concrete model IDs keep the `provider/model` form and pass through unchanged. `/v1/models` advertises profile aliases and logical names only when an eligible mapped model is available. A key can be limited to selected model IDs and requests per minute.

Add custom logical mappings in **Settings > Routing > Logical model mappings**. Each row contains a slash-free logical name, provider ID, and upstream model ID. For example, a logical name may map to `groq` / `openai/gpt-oss-120b`, `cerebras` / `gpt-oss-120b`, and `openrouter` / `openai/gpt-oss-120b:free`. User entries replace the catalog mapping for the same logical name and provider; entries for other providers stay in the pool.

Available profile aliases are `ferry/auto-free`, `ferry/best`, `ferry/fast`, and `ferry/long-context`. Enabled concrete model IDs use `provider/model`. `/v1/models` advertises the profile aliases even when no concrete model is currently available. Each key can be limited to selected model IDs, requests per minute, estimated tokens per minute, tokens per UTC day, and concurrent requests. Leave a limit blank in Settings to keep it unlimited.

## OpenCode

Add a provider entry to `opencode.json` (replace the port and key with the values shown by Ferry):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ferry": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ferry",
      "options": {
        "baseURL": "http://127.0.0.1:11435/v1",
        "apiKey": "YOUR_FERRY_GATEWAY_KEY"
      },
      "models": {
        "ferry/auto-free": { "name": "Ferry Auto-Free" },
        "ferry/best": { "name": "Ferry Best" },
        "ferry/fast": { "name": "Ferry Fast" },
        "ferry/long-context": { "name": "Ferry Long Context" }
      }
    }
  }
}
```

For OpenAI-compatible clients such as Cline, Roo Code, or Kilo, select the OpenAI-compatible provider, use `http://127.0.0.1:11435/v1`, enter the Ferry key, and choose a profile alias. Aider can use:

```powershell
$env:OPENAI_API_BASE = 'http://127.0.0.1:11435/v1'
$env:OPENAI_API_KEY = 'YOUR_FERRY_GATEWAY_KEY'
aider --model ferry/auto-free
```

Continue's OpenAI-compatible provider uses the same base URL, key, and model ID.

## Claude Code

Claude Code uses the Anthropic-compatible `/v1/messages` route:

```powershell
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:11435'
$env:ANTHROPIC_AUTH_TOKEN = 'YOUR_FERRY_GATEWAY_KEY'
claude
```

Both bearer authorization and `x-api-key` are accepted. OpenAI chat requests support non-streaming and SSE responses, function tools, parallel tool calls, JSON mode, and final-chunk usage. Anthropic Messages supports streaming, text blocks, `tool_use`, and `tool_result`. Ferry also accepts OpenAI Responses requests at `/v1/responses`, including tool calls, reasoning summaries, streaming, and usage. `previous_response_id` is not supported; send the conversation input on each request.

### Codex CLI

Add a custom provider to `~/.codex/config.toml` (replace the example URL and model with values shown by Ferry):

```toml
model_provider = "ferry"
model = "ferry/auto-free"
model_reasoning_effort = "medium"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[model_providers.ferry]
name = "Ferry Gateway"
base_url = "http://127.0.0.1:11435/v1"
env_key = "FERRY_GATEWAY_KEY"
wire_api = "responses"
```

Set `FERRY_GATEWAY_KEY` to the key shown once when created in **Settings > Gateway**, then start Codex CLI. Ferry authenticates the key and applies its model allowlist, request/token limits, and normal free-first provider routing. Select a Ferry profile alias such as `ferry/auto-free` for routing across eligible free models. Codex tools remain client-side and are returned as function calls. Ferry returns Responses streaming events for text, function calls, reasoning summaries, terminal status, and token usage. Send the full conversation on each request because `previous_response_id` chaining is not supported.

### Gemini clients

Native Gemini clients can use `POST /v1beta/models/{model}:generateContent` for a single response and `POST /v1beta/models/{model}:streamGenerateContent?alt=sse` for SSE. Use a Ferry profile alias or enabled `provider/model` ID as `{model}`; URL-encode its slash (for example, `ferry%2Fauto-free`). Authenticate with `x-api-key` or bearer authorization. `GET /v1beta/models` returns Gemini's model-list shape with supported generation methods. Ferry maps Gemini contents, function declarations/calls, cached usage, and token usage through the same Gateway routing path. `/v1/models` remains available to OpenAI-compatible and Codex clients.

## CLI

```sh
ferry gateway start
ferry gateway status
ferry gateway keys create "OpenCode" auto-free
ferry gateway keys list
ferry gateway keys revoke <key-id>
ferry gateway stop
ferry serve --gateway
```

`ferry serve --gateway` starts the core and gateway in the foreground until Ctrl+C. Start/stop/status and key operations use the local Ferry core.

## Routing and limits

Ferry routes through configured provider models, existing profile eligibility, quota-aware scoring, cooldown handling, avoid-training policy, and provider adapters. A request-level `x-ferry-session` or `x-session-id` header keeps a route sticky for 30 minutes; absent either header, Ferry uses a hash of the first message. Gateway calls do not run Ferry's planner/editor loop, since the connected coding client owns its tool loop. Per-key tool-result compression is enabled by default and uses inline notice text when it filters a result; recovery storage is disabled. The terse system instruction is off by default. Neither option rewrites code or tool arguments.

Image parts are forwarded only to eligible model candidates whose catalog capability declares vision support. If no such candidate is available, Ferry returns HTTP 400. Text-only requests remain the default; audio, video, and file blocks are not supported.

Gateway requests use provider request overrides from the catalog, layered with **Settings > Routing > Provider request overrides**. A user value replaces the catalog value for that provider. Overrides strip or force JSON request parameters, add request headers, and optionally remap a response status when its body contains a configured phrase. Mapped statuses are used for quota and fallback classification.

Ferry may retry another eligible model only before any streamed text or tool call has been emitted. Once output starts, an error is returned as an OpenAI error chunk or Anthropic error event. A client may need to retry the whole operation. The gateway does not execute client tools; tool calls are passed back to the client.

### Per-key budgets and counters

Settings > Gateway shows the total request count and successful request count separately. Total requests include authenticated inference attempts after request-per-minute and concurrency admission; successful requests increment only when Ferry returns usage from a completed provider call. Counters are stored in Ferry's local settings database. Token usage windows survive restarts: tokens per minute uses a rolling 60-second window, and tokens per day rolls over at 00:00 UTC.

Before a provider call, Ferry estimates input tokens from the request body and reserves the requested output allowance (`max_tokens`, `max_output_tokens`, or Gemini `maxOutputTokens`). If this estimate would exceed a token budget, every inference protocol returns HTTP 429 with `Retry-After`, before the provider is called. OpenAI Chat and Responses use `{ "error": ... }`; Anthropic Messages uses `{ "type": "error", "error": ... }`; Gemini uses its native `{ "error": { "code": 429, "status": "RESOURCE_EXHAUSTED", ... } }` shape. The same key concurrency cap covers streaming and non-streaming calls on every endpoint. Completed calls settle token counters from reported input/output usage; cached input is a subset of input tokens, is exposed in each protocol's native usage field, and is passed to Ferry's cached-token pricing. Failed provider calls do not increment the successful-request count. Budget errors do not call the provider. Upstream provider failures return HTTP 502 when no more specific upstream status applies; Ferry internal failures return HTTP 500.

## Security

- Keep the gateway disabled until a client needs it. Bind to loopback by default.
- Treat keys like local passwords. They are shown only at creation, hashed at rest, and can be revoked. Never share them: provider free-tier allowances belong to the provider account owner.
- LAN mode opens the endpoint to devices able to reach the host. Ferry gateway keys are bearer credentials; use a trusted network and revoke keys you no longer need.
- `GET /health` is unauthenticated and reports only whether the service is responding. Model and inference routes require an active Ferry key.
- Prompts go from Ferry to the configured upstream provider. Ferry's provider-specific data-use notes and account terms still apply.
