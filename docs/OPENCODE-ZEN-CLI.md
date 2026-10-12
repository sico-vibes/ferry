# OpenCode Zen through the installed CLI

Ferry can use the real installed OpenCode CLI through ACP for Zen free models in
both native Ferry chat and its Gateway API. Standard API mode remains the default.
OpenCode Go is a separate paid provider.

In Models, open **Manage key** for OpenCode Zen, turn on **Use installed OpenCode
CLI**, select a free model, and choose **Verify free CLI access**. Only a model that
returns a real free generation becomes selectable. The check sends one small
generation; detecting the installation does not send a prompt.

The default credential source is OpenCode's own Zen API credential (including
`OPENCODE_API_KEY`), or anonymous access when none exists. Free anonymous availability
is determined by OpenCode and may change. A Go subscription is not required to run
the free-model check. Ferry can optionally supply its saved Zen key if OpenCode has
no Zen credential. Changing that option resets CLI verification. Keys remain in
their existing stores, and are never displayed in detection results.

The bridge launches `opencode acp` in a private temporary directory, with isolated
configuration, data, cache and state directories. Both the main and auxiliary model
are explicitly set to the selected free Zen model. It checks the ACP model selector
and fails if that model is unavailable; it never selects the CLI's paid default.
User plugins, project rules and user sessions are not used.

The caller's actual tools are exposed to OpenCode over an authenticated loopback
MCP connection. A tool invocation is returned to Ferry or the Gateway client, which
executes it under its own permission system. OpenCode's filesystem callbacks and
native permission requests are denied. The bridge does not execute caller tools.
After tool results arrive, the next ACP turn receives the full caller transcript,
including tool names, call IDs and results. Each completion has its own subprocess
and MCP token, so no mutable OpenCode conversation is shared across Gateway keys.
Cancellation and completion terminate the process tree and remove temporary data.
At most four ACP completions run concurrently.

This is an agent transport: OpenCode supplies its own harness and context, so its
latency and token usage differ from a direct model API. Text streaming and caller
tool handoffs are supported. Images and structured response formats are rejected;
use standard API mode for those requests. OpenAI sampling/output-token parameters
do not configure OpenCode's ACP agent. Usage is reported when ACP provides it;
interrupted tool-handoff turns can have unavailable usage and are recorded through
Ferry's existing unreported-usage handling.

CLI and API generation verification are separate. Switching back to API mode
excludes CLI-only models. Provider checks and model discovery preserve that
distinction.

Implementation: `packages/delegate/src/zen-acp.ts`, `zen-tools.ts`, and
`packages/core/src/zen-cli.ts`. Offline ACP fixtures cover model selection, optional
auth methods, host-operation denial, tool handoff, cancellation and MCP isolation.
Core tests exercise native-agent execution and Gateway streaming/continuation.

Official reference: [OpenCode ACP documentation](https://docs.opencode.ai/docs/acp/).
