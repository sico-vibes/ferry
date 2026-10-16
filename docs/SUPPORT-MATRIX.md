# Ferry 1.0 support matrix

Snapshot: 2026-10-16, implementation merged into `main` through [PR #6](https://github.com/sico-vibes/ferry/pull/6).
These labels describe implementation evidence; publication and downloads are tracked in [STATUS.md](STATUS.md)
and [GitHub Releases](https://github.com/sico-vibes/ferry/releases). Account access is checked separately. The shared provider registry
(`packages/shared/src/provider-registry.ts`) controls release states in desktop and CLI.

Release checks and unfinished work for this checkout are maintained in [STATUS.md](STATUS.md).

- **Verified:** supported implementation with automated fixture/adapter evidence. Account access,
  model availability and pricing are checked separately; this label does not promise a live account run.
- **Beta:** usable integration with incomplete provider-specific certification; excluded from default
  Auto unless explicitly enabled. Local tool/context capability depends on advertised metadata.
- **Coming soon:** connection controls unavailable. An ended or unsupported integration is not routable.

## Clients

| Client | State | Verified contract | Live installed-client evidence |
| --- | --- | --- | --- |
| Ferry desktop + CLI | Verified | Shared Core, settings, routing and keys; native-module/packaged checks | Isolated Windows smoke; no live provider/account required |
| OpenCode | Verified (fixtures) | OpenAI chat SSE, streamed tool arguments, full tool-result replay | Opt-in script; not claimed by CI |
| Codex CLI | Verified (fixtures) | Stateless Responses (`store=false`), named SSE events, function calls/output replay, reasoning effort | Opt-in script; not claimed by CI |
| Claude Code | Verified (fixtures) | Anthropic Messages, API-key/Bearer authentication, tools, stop reasons, message/content SSE events | Opt-in script; not claimed by CI |
| Generic OpenAI HTTP | Verified (fixtures) | Chat nonstream/stream, models, authentication, tool calls/results | Opt-in script; not claimed by CI |
| Other OpenAI/Anthropic-compatible clients | Beta | Protocol compatibility only; client-specific extensions may be unsupported | No certification claim |

The fixture harness is `packages/core/test/client-certification.test.ts`. It traverses Gateway HTTP,
Core policy/routing, the upstream adapter and local SQLite using synthetic loopback responses.
It verifies a two-turn tool exchange for each mandatory client. It does not execute installed binaries
or impersonate them. Responses `previous_response_id`/server-side conversation storage are unsupported;
clients must replay conversation history. Multimodal, structured-output, disconnect, partial failures,
deadlines, backpressure and policy enforcement have additional Gateway/Core fixture tests.

## Providers and connection methods

| State | Connection IDs | Evidence and limits |
| --- | --- | --- |
| Verified API/anonymous | `anthropic`, `anyapi`, `cerebras`, `cloudflare-workers-ai`, `deepinfra`, `deepseek`, `fireworks`, `gemini`, `groq`, `huggingface`, `hyperbolic`, `kilo`, `llm7`, `mistral`, `nebius`, `novita`, `nvidia`, `openai`, `opencode-go`, `opencode`, `openrouter`, `ovhcloud`, `sambanova`, `scaleway`, `stepfun`, `together`, `tokenrouter`, `vercel-ai-gateway`, `zai-glm` | Registry adapter-tested state. Account/model allowances and capability coverage vary. API keys and eligible anonymous access use standard transports. |
| Beta API | `openai-compatible`, `cohere`, `inception`, `minimax`, `moonshot`, `perplexity`, `siliconflow`, `xai-api` | Custom/regional endpoints and documented catalogs; provider-specific live verification pending. |
| Beta local | `ollama`, `lmstudio` | Keyless/authenticated discovery and execution fixtures. Server/model capability metadata is authoritative. |
| Beta installed CLIs | `codex-cli`, `claude-code-cli`, `opencode-cli` | Genuine installed-client transports with independent native/Gateway opt-ins and per-model generation checks. Windows operator checks completed caller-tool round trips through native Ferry and Gateway for all three clients. Account capacity and supported controls vary by installed client. |
| Beta OAuth/account | `oauth-anthropic`, `oauth-openai-codex`, `oauth-github-copilot`, `oauth-openrouter`, `oauth-kimi-coding`, `oauth-meta`, `oauth-xai`, `oauth-radius` | Supported sign-in, cancellation, refresh and Gateway adapter fixtures. API and account identities remain separate; no current account certification claim. |
| Coming soon/unavailable | `chutes`, `gemini-cli`, `github-models`, `kiro`, `qwen-code-oauth`, `zenmux`, `oauth-kilo`, `oauth-qoder`, `oauth-cline` | Disabled; catalog entries do not authorize third-party access. |
| Ferry Cloud | Coming soon | New setup disabled; recovery for existing Cloud-only data/credentials remains available. |

OpenCode Zen's OpenCode-only free models can use the real installed CLI transport in Ferry chat,
Ferry CLI and Gateway, after an explicit access check and the relevant surface opt-in. Finding a Go
credential does not prove Zen entitlement. Anonymous free checks, installed credentials and a saved
Ferry Zen key remain separate choices. Ferry never spoofs another product's identity or renames tools
to bypass access controls. Standard Zen API access retains its own legitimate key and eligible models.
See [CLI connections](CLI-CONNECTIONS.md) for setup and the distinction between free, included and
metered capacity.

Installed CLI transport currently supports text and caller tools. Ferry owns native tool approvals;
Gateway returns tool requests to its calling client. Native shell/file tools, external MCP servers,
project hooks and plugins are isolated from the transport. Unsupported images, structured output or
explicit request controls fail validation rather than being silently ignored. Fast modes never gain
spending authorization from a subscription opt-in. This beta cannot bound a separately billed
Fast/priority charge with a known-price reservation, so the bridge fails closed when that guarantee is
required; a positive Gateway key budget alone does not enable the mode. Standard speed and supported
reasoning choices remain available. Additional account enrollment and importing native CLI conversation
history are deferred. Quota windows are shown only when the client reports them.

Auto remains free-first. Paid backup requires a positive explicit budget and known prices, and every
request remains bounded by the key, assigned/requested profile and global spending policy. A text-only
provider check measures responsiveness/reachability; it does not certify coding quality or all capabilities.

## Running certification

Fixture gates require no external network or real credentials:

```powershell
.\tools\pnpm.cmd check
.\tools\pnpm.cmd --filter @ferry/desktop ui:invariants
.\tools\pnpm.cmd --filter @ferry/desktop dist
.\tools\pnpm.cmd --filter @ferry/desktop install:smoke
```

The installer smoke builds two dedicated app identities with isolated data/registry destinations and
shortcuts disabled. It cannot accept a production installer. It validates normal-user clean install,
upgrade persistence, default/opt-in uninstall, special paths, installed CLI and the actual portable executable.
The web matrix uses 1024×680 and 1440×900 **logical pixels** at device scale factors 1, 1.25 and 1.5,
both themes, reduced motion and keyboard journeys. Native Windows monitor/DPI switching and real
hardware sleep/wake remain manual checks; simulated lifecycle events are automated.

Real installed-client runs are explicit and free-only:

```powershell
# Set FERRY_CERT_PROVIDER, FERRY_CERT_MODEL and FERRY_CERT_KEY in your isolated test environment.
# Optional FERRY_CERT_BASE_URL selects a custom test endpoint.
# Never supply production credentials. Installed opencode, codex and claude must be on PATH.
node --import tsx scripts/live/client-certification.mjs --live
```

The live runner uses a disposable Core/profile/config/workspace and in-memory provider secrets,
performs file-tool round trips, then revokes its Gateway key and removes the profile. It never reads
stored Ferry credentials. Client output is withheld to avoid leaking credentials. Live failures are
release evidence, not CI exceptions; preserve the tested client versions alongside any live result.
