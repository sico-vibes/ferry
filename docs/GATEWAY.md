# Ferry Gateway

Ferry Gateway exposes Ferry's configured providers through a local OpenAI-compatible API and an Anthropic Messages endpoint. It uses the provider accounts configured in Ferry; a `ferry-gw-…` key only authenticates a local client and does not represent pooled provider access.

## Start and create a key

In Ferry, open **Gateway**, enable the server, and create a named key in **Keys**. Ferry stores a SHA-256 verification hash in SQLite and keeps the secret in the operating system keyring for client setup. The Connect tab can retrieve that secret, preview and back up a configuration, and verify a request.

The default listener is `127.0.0.1:11435`. If that port is busy, Ferry selects an available local port and shows the chosen URL. LAN binding is off by default. Enabling it binds all interfaces, so use it only on a trusted network. `/health` returns service status and never returns a key or provider data.

`ferry/auto` follows the key's assigned preset. Existing aliases (`ferry/auto-free`, `ferry/best`, `ferry/fast`, `ferry/long-context`), custom profile IDs and logical mappings remain supported. Profile keys with concrete model restrictions may use Auto; No profile keys retain their ordered concrete model list. Alias changes cannot loosen key, profile or global spending limits.

## Control centre and request history

Gateway has Overview, Requests, Routing, Keys, Usage & costs, and Connect tabs. Requests offers search, key/status filters, 24-hour/7-day/30-day ranges and paging. Its drawer shows the requested and serving model, correlation ID, attempt durations, failures/skips, policy constraints and completed/cancelled/partial outcomes. SQLite stores metadata without prompts or response bodies; Core retention applies. Usage groups by key, provider or model, and separates reported tokens and actual/estimated charges. Provider/model costs include charged failed attempts. Unknown metrics explain what was not reported.

Named keys have a client assignment, preset, concrete restrictions, request/token limits, a monthly USD limit and rotation/revocation. Rotation preserves the key ID, policy and accounting while invalidating the old secret. Global accounting covers agent and Gateway spend. Paid backup needs explicit authorization and a positive key limit; unknown metered pricing blocks automatic paid execution.

The server allows 16 active requests with up to 64 waiting globally and 8 waiting per key. Key concurrency defaults to 4; an explicit key limit remains enforced. Waiting is FIFO within a key and rotates between keys. The 150-second overall deadline includes queue time, with the existing routing first-response setting and agent inactivity setting applied upstream. Disconnect, cancel and shutdown abort work and release slots. Slow-client writes await socket drain. Transparent retries stop after visible text or tool output; a partial stream reports an error without pretending to finish successfully.

Output defaults to a bounded 4096 tokens when omitted; clients may supply a positive output cap. Token reservations use a conservative UTF-8 input bound plus requested output. Missing usage or interrupted dispatch retains a conservative token estimate; it is not displayed as reported usage. Budget accounting survives metadata retention.

Connection verification uses a small request through the selected key and protocol (chat, Responses or Anthropic Messages). Paid-capable tests require a separately approved request cost ceiling (up to $1); the default UI ceiling is $0.01, and key/profile/global caps still apply. This verifies the Gateway protocol, not an installed external client's full workflow.

Core free provider checks select one eligible representative model per connection, run at most two generations concurrently, support cancellation and bounded deadlines, and record timing, sample count and measurement age. Preview recommendations before Apply; Undo restores the prior preset. Responsiveness checks are not coding benchmarks. Import `scripts/bench` JSON from Profiles → Advanced; Auto edits/reviews also use bounded, decaying coding outcomes with checklist evidence. Ordinary chat success does not improve coding scores.

Onboarding saves its six-step journey in Core, leaves folders optional, reuses its named Personal API key after resuming, and finishes only after a successful request. Account routing must be enabled explicitly; subscription/account models also need the key's authorized paid-backup policy. API requests preserve fidelity by default, while free native-agent built-ins retain Caveman Lite. Planner/editor splitting remains an advanced agent option.


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

## OpenCode Zen

Use your own OpenCode key for the standard Zen API. Models restricted to the OpenCode app are launched with `ferry run opencode --native` or the delegation lane; they are not Ferry routes.

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
- Treat keys like local passwords. Authentication metadata keeps a verification hash; the bearer secret is retained in the operating system keyring for client configuration. Keys can be revoked. Never share them: provider free-tier allowances belong to the provider account owner.
- LAN mode opens the endpoint to devices able to reach the host. Ferry gateway keys are bearer credentials; use a trusted network and revoke keys you no longer need.
- `GET /health` is unauthenticated and reports only whether the service is responding. Model and inference routes require an active Ferry key.
- Prompts go from Ferry to the configured upstream provider. Ferry's provider-specific data-use notes and account terms still apply.

## Spending policy and deadlines

New keys are free only and preserve prompts and tool schemas by default. Paid execution needs an explicit paid-backup policy, a positive monthly key limit, and a paid-capable assigned profile. Unknown metered pricing blocks automatic paid dispatch. Profile and global limits apply even when the client requests a different model or alias.

Set key policy with `ferry gateway keys update <id> --paid-backup true --budget-usd 5`. Reservations are atomic in SQLite and settle against reported usage; interrupted dispatches retain a conservative estimated charge. Global limits also cover the native agent.

Gateway execution uses the routing first-token timeout, the agent step inactivity timeout, a 150-second overall deadline and at most five dispatches. Provider cooldowns and Retry-After remain authoritative. Request history is persisted locally as metadata, with Core retention settings applied at startup and hourly.

OpenCode-only models use the real OpenCode app's own providers and credentials. Launch with `ferry run opencode --native --model opencode/big-pickle`; this path does not create a Gateway key, start the Gateway, or inject Ferry provider configuration.

## Interactive CLI and provider readiness

Use `/connect` to choose an API, supported account sign-in, or a keyless/authenticated local server. Credentials are entered without echo or history. Escape closes a connection/picker overlay first; it cancels the agent only when no overlay is open. Configure a custom or regional endpoint with `/connect <provider> endpoint <base-url>` and check saved access with `/connect <provider> check`.

`/gateway` reports the shared Core server and key spending policies. `/gateway start`, `stop`, `requests`, and `routing` use the same Core operations as the dashboard. `/gateway configure codex|opencode|claude` prints a masked configuration; adding `--apply` writes through the existing configuration/backup helper. `/doctor` reads a sanitized Core/provider diagnostic summary without opening an agent chat. Scripted generation remains available through `ferry run`; the interactive UI requires a terminal.

Models and onboarding expose free checks, a recommendation preview, Apply and Undo. Paid API checks require separate approval of a positive total ceiling, at most USD 1. The ceiling covers both workers together and shared global spend caps remain enforced. Cancellation or missing usage retains a conservative charge. Paid checks never enable paid inference; supported account models use the Gateway verification operation. A small synthetic generation tests responsiveness and access, not coding ability or installed-client certification.

Preserve fidelity disables lossy agent transforms. Safe savings enables recoverable output filtering and context hygiene. Advanced exposes individual switches, including RTK when installed. Saving global optimizer controls applies them to built-in native agent profiles; custom profiles retain their explicit overrides. Gateway prompts and tool structures retain their independent fidelity defaults. Free native profiles retain Caveman Lite and Lite replies until explicitly changed. Savings appear from recorded transform measurements; cost estimates and missing usage are labelled separately.

Custom OpenAI-compatible APIs and regional template endpoints persist in Core. Changing an endpoint clears old model and check evidence. Local discovery uses advertised context/tool metadata; unadvertised local/custom tool support remains unavailable. Beta integrations remain excluded from default Auto until enabled. Kilo's API template is separate from its Coming soon account connection; Qoder and Cline account controls also remain unavailable until supported authentication exists.

Data & privacy and About can export allowlisted diagnostics containing version, Gateway state and provider health. The export excludes credentials, configuration headers, paths, prompts, responses and arbitrary log/error bodies.
