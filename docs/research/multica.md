# Multica — how a signed-in-CLI workspace integrates agents, models, effort, reasoning and tool calls

**Research date: 2026-09-28.** Desk review with direct source reading. The repo was cloned
(shallow) to a scratch dir and read at commit
`67d61a2073bad0fbb7140fd2000f1ab7ec0a4f25` (`main`, Mon Sep 28 16:53:14 2026 +0800,
"feat(issues): run charts follow the pointer; a cost sparkline replaces the sidebar strip
(#8912)"). No Ferry code was changed and no Multica API/CLI was executed; nothing below was
run against a live account.

**Citation convention.** Every claim is cited to a repo-relative path and the line range in
the clone above. The clone is a single ref, so permalinks should be built as
`https://github.com/multica-ai/multica/blob/67d61a2073bad0fbb7140fd2000f1ab7ec0a4f25/<path>#Lx-Ly`.
Facts taken only from the README, the website, or in-code marketing copy and *not* verified
in source are marked **claimed**. Things the source does not settle are **unknown**.
Where the report compares to Ferry, the Ferry side is from `docs/DELEGATION.md`,
`docs/ROUTING.md`, `packages/delegate/src/index.ts`, `packages/oauth/src/index.ts`,
`packages/delegate/data/acp-agents.yaml`, and `packages/shared/src/domain/delegation.ts`
at the working tree.

Companions: `docs/research/coding-agents.md` (agent loop internals of individual CLIs) and
`docs/DELEGATION.md` (Ferry's own delegation contract).

---

## Ten-line summary (plain English)

1. Multica is a self-hostable **"agents on the board" workspace**: you assign an issue to a
   coding-agent CLI the way you assign it to a teammate; it runs on a daemon on your machine
   and reports back.
2. It **does not ship a model**. It detects and drives ~26 already-installed, already-signed-in
   CLIs (`claude`, `codex`, `cursor-agent`, `copilot`, `opencode`, `kimi`, `qwen`, `pi`, …) plus
   built-in forks such as `omp` (README "Runtimes"; `server/pkg/agent/agent.go:364-390`).
3. Login reuse is **subprocess + config-file sharing, not token scraping**: it runs each CLI
   under the user's own home and, only for Codex, symlinks (or copies) `~/.codex/auth.json`
   into a per-task `CODEX_HOME`; it logs the *kind* of file, never contents
   (`execenv/codex_home.go:17-30,195-230,1298-1321`).
4. Transport is **per-CLI and chosen for richness, not uniformity**: Codex speaks the
   `codex app-server` JSON-RPC 2.0 protocol; Claude/CodeBuddy/Qwen use `--output-format
   stream-json` control protocol; OpenCode uses `opencode run --format json`; most others use
   **ACP** over stdio (`agent.go:516-542`).
5. Every backend normalizes to one internal event model: `text | thinking | tool-use |
   tool-result | status | error | log`, with a `CallID` and per-model token usage
   (`agent.go:199-245`).
6. Model **and** reasoning-effort catalogs are discovered live from the logged-in CLI:
   Claude via a `list_models` stream-json control request (`claude_models.go:54-113,215-295`),
   Codex via `codex debug models` (`thinking.go:305-349`), OpenCode via
   `opencode models --verbose` variants (`models.go:771-977`), ACP agents via `session/new`
   `configOptions` (`acp_effort.go:10-120`).
7. Discovery is cached ~60 s (not cached when empty/fallback), version-gated, and always
   degrades to a static list or manual entry rather than lying (`models.go:106-149,516-575`;
   `version.go:18-36`).
8. The UI folds `tool_use`+`tool_result` pairs into one **step**, groups runs of ≥3 same-tool
   calls, shows collapsible thinking, diffs, per-step wall-clock, and a two-lane timeline
   ("model time" = the gaps between tools) (`packages/views/common/task-transcript/build-steps.ts:18-198,260-344`).
9. Sessions resume by protocol (`thread/resume`, ACP `session/resume`, `--resume`, OpenCode
   `--session` + server-side `/api/session/:id/interrupt`), run concurrently (default 20 per
   daemon), and can be steered mid-run for a few backends (`codex.go:363-370`;
   `config.go:72,117`; `opencode_v2.go:235-289`).
10. License is **"the Multica License" = Apache-2.0 + extra conditions** restricting hosted/
    embedded commercial use and removal of Multica branding; Ferry is MIT, so treat Multica as
    a **read-only reference and reimplement** (`LICENSE:1-120`).

---

## 1. What Multica is

**Product.** A source-available, self-hostable workspace that puts coding agents and humans on
one task board. You assign an issue to an "agent" (a named configuration of provider + runtime),
it picks the task up on a machine you control, comments progress, and hands the result back for
review (README "What is Multica?", "Build the team", "Hand off the work"; docs at
`multica.ai/docs`). The README's own framing is **claimed** marketing copy; the mechanics below
are from source.

**Stack (verified in-tree).**

| Layer | Stack | Citation |
|---|---|---|
| Web | Next.js 16 App Router | `package.json`, `apps/web` |
| Desktop | Electron, sharing web UI packages | `apps/desktop`, README |
| Mobile | Expo / React Native | `apps/mobile`, README |
| Backend | Go 1.26.6, Chi + `gorilla/websocket`, `sqlc` + `pgx` | `server/go.mod:1-20` |
| DB | PostgreSQL 17 (`pgcrypto`, `pg_trgm`) | README architecture; `server/migrations` |
| Agent runtime | a Go daemon that spawns agent CLIs on the user's machine | `server/internal/daemon`, `server/pkg/agent` |
| Client SDK / plugins | TS packages + plugin SDK | `packages/core`, `packages/plugin-sdk` |

**Activity.** The web view reported **51.6k stars, 6.7k forks, 5,527 commits, 946 open issues,
759 open PRs**, with releases "most weekdays". Multi-language (`go.mod`, `pnpm-lock.yaml`) and a
real test surface: `server/pkg/agent` alone contains >150 files of adapters and tests.
Confidence: the counts are from the GitHub page as served on 2026-09-28 and can drift.

**Shape of the code.** The interesting part for Ferry is `server/pkg/agent/` (the adapters),
`server/internal/daemon/` (scheduling, probing, per-task execution environments) and
`packages/views/common/task-transcript/` (the transcript UI model).

---

## 2. Using already-signed-in CLIs

### 2.1 How it detects them

Detection is **pure binary discovery plus version probing**; it does **not** determine login
state. `probeAgentCLIs` walks a fixed table of `(env-var override, default command, model env)`
triples and resolves each with `exec.LookPath`, falling back lazily to the user's **login
shell** for PATH entries a GUI-launched daemon can't see, and to a couple of known desktop-app
bundle paths (`server/internal/daemon/agents_probe.go:79-335`). Each provider gets its own env
override, e.g. `MULTICA_CLAUDE_PATH`, `MULTICA_CODEX_PATH`, `MULTICA_OPENCODE_PATH`, and a
`MULTICA_*_MODEL` default (`agents_probe.go:118-176,179-333`).

Built-in runtime **identities** that share a protocol family (today only `omp`, a Pi fork that
speaks the Pi JSON protocol) come from a descriptor registry rather than hard-coded probes
(`server/pkg/agent/builtin_runtimes.go:18-100`). A single `SupportedTypes` whitelist gates which
backends may back a custom runtime profile (`agent.go:344-402`).

Versions are read with `--version` (`agent.go:500-508`, `version.go`), and a per-CLI minimum
version is enforced at registration (`version.go:18-36`) — notably
**`codex: 0.100.0` because `app-server --listen stdio://` was added then** (`version.go:21`)
and **`opencode: 1.1.54` to stop it polluting shared temp dirs** (`version.go:28-35`).

There is **no** `codex login status` / `claude auth status` probe. The only `auth status` in the
tree belongs to the Multica CLI's own control-plane auth (`server/cmd/multica/cmd_agent.go:407`).
Login failures surface later, during model discovery or the first turn.

### 2.2 How it reuses the existing login/session

There is **no credential file parsing into application memory**. The pattern is:

- **Run the CLI as the user**, in the user's environment, so the CLI finds its own credential
  store. This covers Claude Code (`~/.claude`), OpenCode, and every ACP CLI.
- **Codex only**: the daemon isolates each task in a private `CODEX_HOME`. It **symlinks**
  `auth.json` from the shared `~/.codex/` (so token refreshes propagate) and **copies**
  `config.json` / `config.toml` / `instructions.md` (so task-local config doesn't mutate the
  shared home). On Windows, where `os.Symlink` may fail without Developer Mode, it falls back to
  copying and re-copies on env reuse (`execenv/codex_home.go:17-30,195-230`).
  `logCodexAuthState` logs only **symlink target / file size / mtime — never contents**
  (`codex_home.go:1298-1321`), and there is an explicit test asserting no content leakage
  (`execenv/codex_real_home_test.go`).

**API-key path (separate from subscription login).** Agents can carry a `custom_env`
(e.g. `ANTHROPIC_API_KEY`, `XAI_API_KEY`) that the daemon injects into the child process
(`server/internal/daemon/daemon.go:8534`; Grok selects its ACP auth method by checking whether
`XAI_API_KEY` is present — `agent/grok.go:376-379,632-669`). OAuth handling in the tree is for
*tooling the daemon reaches* (remote MCP servers, VCS integrations), not for agent model
credentials: `server/pkg/remotemcp/oauth.go` and `vcs_connection.access_token_encrypted`
(`server/pkg/db/generated/models.go:1629`).

**ToS / security implication.** Multica's design deliberately lets the vendor's own CLI own the
credential and auth lifecycle. The only "reuse" is file-level sharing of Codex's token file via
symlink, which the operator already consented to by signing in — but it still means an agent
process can read that token, and Multica is explicit that an agent's commits could capture files
in the workdir (see OpenCode 2.x MCP refusal below). This is materially safer than Ferry's
`packages/oauth` model, which stores subscription tokens in Ferry's own secret store
(`oauth/src/index.ts:26-56,83-110,247-256`) under a high-risk notice.

### 2.3 How it launches and streams

Transports are summarized by `launchHeaders` (`agent.go:516-542`):

| Provider | Launch skeleton | Protocol |
|---|---|---|
| Codex | `codex app-server` | JSON-RPC 2.0 over stdio |
| Claude | `claude (stream-json)` | stream-json + control protocol |
| CodeBuddy / Qwen | `codebuddy`/`qwen -p (stream-json)` | stream-json |
| OpenCode | `opencode run (json)` | NDJSON events |
| Cursor / Copilot / codearts / deveco / openclaw | `… (stream-json/json)` | vendor JSON |
| Hermes / Kimi / Reasonix / Kiro / Qoder / Qoder CN / Trae / Grok / QwenPaw / Dim / MCode / ZeroClaw | `<cli> acp` / `grok agent stdio` / `traecli acp serve` | ACP over stdio |
| Antigravity | `agy -p` | headless stream-json |
| DSH | `dsh --profile multica (stdio)` | custom profile protocol |

Concrete argv examples:

- **Codex**: `buildCodexArgs` → `["app-server","--listen","stdio://"]` plus filtered user args
  (`agent/codex.go:357-405`); RPCs observed in use include `initialize`, `thread/start`,
  `thread/resume`, `thread/name/set`, `turn/start`, `turn/steer`, `turn/interrupt`
  (`codex.go:2031-2144,1679,1954,2655`).
- **Claude**: `--print --verbose --input-format stream-json --output-format stream-json
  --permission-mode bypassPermissions`, plus `--model`, `--effort`, `--resume`, `--max-turns`
  (`agent/claude.go:1079-1133`).
- **OpenCode**: `opencode run --format json --dangerously-skip-permissions`, plus
  `--dir` (1.x), `--model`, `--variant`/model-embedded variant (2.x), `--session`
  (`agent/opencode.go:95-141`).
- **ACP**: `initialize` → optional `authenticate` → `session/new`/`session/resume` →
  optional `session/set_mode` / `session/set_config_option` → `session/prompt`, with
  `session/update` notifications on the way (`packages/delegate` mirrors this shape; in
  Multica the handshake is spelled out in `agent/models.go:1992-2180`).

Streams are byte-buffered NDJSON; each backend has a dedicated scanner/parser
(`server/pkg/agent/stream_scanner.go`, `stream_json_result.go`). Process groups are signalled
for cancellation, with Windows-specific tree kills (`proc_windows.go`).

---

## 3. Model + effort discovery per agent

The catalog type is `Catalog{Models, Unavailable, Fallback, CLIThinkingLevels}` and a `Model`
carries a per-model `Thinking *ModelThinking` (supported levels + default) and per-model
`ServiceTiers` (`agent/models.go:33-137`). This is the single most transferable idea in the
repo: **the runtime's own binary, queried against the logged-in account, is the authority on
what it can run and how hard it can think.**

`ListModels` dispatches per provider (`models.go:195-335`). Key mechanisms:

- **Claude** — no `--list-models`. It sends a `list_models` **stream-json control request**
  (`{"type":"control_request","request":{"subtype":"list_models"}}`) on a discovery-only
  `claude --print --input-format stream-json --output-format stream-json --strict-mcp-config`
  session; no model is invoked and nothing is billed (`claude_models.go:54-113,274-295`). Rows
  carry `value/resolvedModel/displayName/supportsEffort/supportedEffortLevels/disabled`; the
  daemon persists `resolvedModel` and builds a **per-model** effort catalog
  (`claude_models.go:174-197,336-456`). Disabled rows (CLI too old for a model) are returned in
  a separate `Unavailable` list with the runtime's own remedy string
  (`claude_models.go:64-70,364-372`). Unsupported control subtypes are remembered per
  `(command, version)` for 10 min so old builds aren't re-probed forever
  (`claude_models.go:115-165`). Fallback: a static list plus a `claude --help` scrape of a
  global effort superset (`thinking.go:97-255`).
- **Codex** — `codex debug models` (live) then `codex debug models --bundled` (offline), both
  version-gated behind `0.122.0`; parses `slug`, `display_name`, `visibility`,
  `supported_reasoning_levels` (with descriptions), `default_reasoning_level`, `service_tiers`
  (`thinking.go:271-493`). Service-tier support is version-gated behind `0.133.0`
  (`thinking.go:355-379`). Fallback static list carries per-model effort and deliberately does
  **not** guess service tiers (`models.go:602-661`).
- **OpenCode** — `opencode models --verbose`, parsed as `provider/model` rows plus trailing
  pretty JSON; the JSON `variants` map becomes the thinking picker and each enabled variant is
  later passed as `--variant` (1.x) or `provider/model#variant` (2.x)
  (`models.go:771-977`; `opencode_v2.go:72-95`). A plain `opencode models` retry covers CLIs
  that don't support `--verbose` (`models.go:791-799`).
- **ACP agents** (Kimi, Hermes, Reasonix, Kiro, Qoder, Trae, Grok, Dim, MCode, …) — a
  throwaway `<cli> acp` process does `initialize` + `session/new` and reads
  `models.availableModels`/`currentModelId` *or* the newer `configOptions` list
  (`models.go:1992-2180,2229-2410`). Reasoning effort is a `configOptions` entry whose
  `id`/`category` is one of `effort`/`thought_level`; it is applied with
  `session/set_config_option` and **read back** to confirm it took (some runtimes accept but
  ignore it) (`acp_effort.go:10-120,226-305`). Values are passed through verbatim, never
  flattened to a shared enum (`acp_effort.go:20-30,80-84`).
- **Others with a vendor command**: Antigravity `agy models`, Cursor `--list-models`, Copilot
  via ACP, Pi via RPC then a table fallback, OpenClaw's agent list, CodeBuddy's `--help`
  capture, etc. (`models.go:2407-3002`). Providers with no account-independent catalog return
  an empty list with manual entry available (`qwen`, `qwenpaw`, `mcode`, `zeroclaw` —
  `models.go:293-331`).

**Caching / refresh.** `cachedDiscovery` memoizes per `(provider, executable+prefix)` for
**60 s**, keyed by binary path and launch prefix so two profiles never share a catalog
(`models.go:163-176,516-575`). Crucially it **does not cache empty or fallback results**, so a
transient not-logged-in/timeout retries immediately rather than pinning a blank picker for the
TTL (`models.go:534-547`). A separate 10-minute cache holds the "this binary can't answer
list_models" verdict keyed by CLI version so an upgrade invalidates it at once
(`claude_models.go:115-165`). The server additionally keeps a day-scale catalog cache, which is
why `Fallback` must not enter it (`models.go:117-127`).

**Validation.** `ValidateThinkingLevelWith` / `ValidateServiceTierWith` check a persisted
effort/tier against the discovered catalog but **fail open to the CLI** when the catalog is
unverified, because a static stand-in is "unknown", not "unsupported" (`thinking.go:676-763`).
Empty-model thinking for Codex fails closed because the CLI config can resolve to any model
(`models.go:614-621`; `thinking.go:780-808`).

---

## 4. Displaying reasoning ("chain of thought") and tool calls

### 4.1 Wire protocols consumed

- **ACP** — `session/update` notifications, normalized by `normalizeACPUpdate` across three
  serializations (`sessionUpdate`, `type`, and externally-tagged `{"agentMessageChunk":…}`),
  into `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`,
  `usage_update`, `turn_end` (`agent/hermes.go:1834-1916`). Message chunks become
  `MessageText`; **thought chunks become `MessageThinking`** (`hermes.go:1918-1946`). Tool
  starts become `MessageToolUse` (with `rawInput` when available, *deferred* for streaming
  dialects like Kimi that build args token-by-token); completion becomes `MessageToolResult`
  with status and output (`hermes.go:1948-2127`). Usage is reconciled from cumulative
  `usage_update` snapshots and the terminal prompt result with per-bucket maxima, plus
  cache-read normalization when `totalTokens == input+output` (`acp_usage.go:20-111,163-264`).
- **Claude stream-json** — assistant content blocks map directly: `text`→`MessageText`,
  `thinking`→`MessageThinking`, `tool_use`→`MessageToolUse`; user `tool_result` blocks become
  `MessageToolResult` (`agent/claude.go:462-553`). Unknown block types set
  `turn.understood=false` so a turn is never falsely reported as silent
  (`claude.go:517-527`). Subagent usage is handled via the final result's `modelUsage`
  (`claude.go:476-492`).
- **Codex app-server** — v2 notifications: `item/agentMessage/delta` streams text,
  `item/started`/`item/completed` for `commandExecution` → `exec_command`, `fileChange` →
  `patch_apply`, `mcpToolCall` → MCP tool name; `item/completed` with `phase:"final_answer"`
  distinguishes the deliverable from narration (`codex.go:3700-3811`). Usage comes from
  `thread/tokenUsage/updated` with total/last delta accounting (`codex.go:3813-3863`). Legacy
  `exec_command_begin/end`, `patch_apply_begin/end`, `task_complete` are still parsed
  (`codex.go:3382-3466`). **Codex does not expose chain-of-thought text** — only
  `reasoningOutputTokens` — so there is no Codex thinking block to render (`codex.go:3855-3863`).
- **OpenCode** — `run --format json` NDJSON: `text`, `tool_use` (carries both call and result
  once terminal), `error`, `step_start`, `step_finish`. Reasoning tokens are counted but not
  emitted as a thinking message (`opencode.go:424-652`). A step-bracketing + "void step" guard
  exists so a dead stream isn't reported as a clean completion (`opencode.go:424-579`).

### 4.2 Unified UI model

The stored timeline item is `{seq, type: tool_use|tool_result|thinking|text|error, tool?,
callId?, content?, input?, output?, output_truncated?, created_at?}`
(`task-transcript/build-timeline.ts:4-21`), matching the Go `Message` shape
(`agent/agent.go:199-223`).

The rendering pipeline is worth copying almost wholesale (all pure TS, unit-tested):

- **Pair call↔result into a step** by opaque `callId` (never by tool-name when an id exists),
  with a legacy tool-name FIFO only for identity-less events (`build-steps.ts:94-149`). This
  is what stops a 75-call run rendering as 150 rows.
- **Group runs of ≥3 consecutive same-tool non-shell calls** into one row; shell calls (input
  has a `command`) never group because "Bash · 5 calls" hides the point
  (`build-steps.ts:58-64,151-198`).
- **Two-lane timeline**: tool lane from call spans; model lane as the *complement* (the gaps),
  because text/thinking rows carry only an arrival timestamp. This answers "where did the 28
  minutes go" (`build-steps.ts:260-344`). Ticks are round numbers with a 3 px minimum segment
  so fast calls stay clickable (`build-steps.ts:346-395`).
- **Readability hierarchy** (`trace-event-presenter.ts:1-73`): agent text and errors read
  without a click; tool calls are compact (provider-native name verbatim + most-informative
  arg, with login-shell wrappers stripped — `trace-event-presenter.ts:82-130`); tool results
  and thinking open in a step inspector. Unknown event types are retained, never dropped.
- **Diffs and truncation**: `diff-highlight.ts` renders patch bodies; tool results record
  `output_truncated`, and the UI must not render a truncated preview as "complete"
  (`build-timeline.ts:13-21,60-71`).
- **Secret redaction** runs over every event body on timeline build, with memoized per-message
  redaction to keep a 100 ms live flush cheap (`build-timeline.ts:52-58,73-90`).
- **Cost/usage** is stored per model via `TokenUsage{Input,Output,CacheRead,CacheWrite,
  CostUSDTicks}` (`agent/agent.go:225-250`) and priced by a static table
  (`server/internal/metrics/pricing.go:7-40`); provider-reported `CostUSDTicks` wins over
  estimate because request-level tiering can't be reconstructed from token counts
  (`agent.go:236-244`).

---

## 5. Session management

- **Resume.** Codex `thread/resume` (with a fresh-session fallback if the runtime rejects the
  id); ACP `session/resume`/`session/load` with `isACPResumeRejected` distinguishing "session
  gone" from auth/network/cancel, so only a genuine rejection retires the pointer
  (`agent/acp_session.go:13-170`); Claude `--resume` with a "no conversation found" detector
  (`claude.go:1171-1210`); OpenCode `--session` (`opencode.go:139`). Codex sessions are kept in
  a **per-issue store** that survives task IDs so a follow-up run continues the conversation
  without dragging in the machine's whole history (`execenv/codex_home.go:39-92,338-403`).
- **Concurrency.** A daemon runs up to `MaxConcurrentTasks` (default **20**, env
  `MULTICA_DAEMON_MAX_CONCURRENT_TASKS`) via a slot semaphore
  (`daemon/config.go:72,117,474-479`; `daemon.go:5348`). Local-directory tasks can run
  concurrently by using **worktrees instead of a per-path mutex** (`execenv/local_worktree.go:19-23`).
- **Cancel.** ACP sends `session/cancel` then kills the tree; Codex sends `turn/interrupt`
  and waits a bounded window for `turn/completed`; OpenCode 2.x must call the background
  service's HTTP `POST /api/session/:id/interrupt` because `opencode run` is a thin client and
  process-group signalling no longer stops the work (`packages/delegate`-style ACP cancel at
  `agent/acp_session.go`; `codex.go:2625-2655`; `opencode_v2.go:235-289`).
- **Approvals / permissions.** These are **not** surfaced to a human per tool call. The daemon
  auto-approves: Codex answers `item/commandExecution/requestApproval` and
  `item/fileChange/requestApproval` with `accept`, and echoes a turn-scoped
  network/fileSystem grant for `item/permissions/requestApproval`
  (`codex.go:2921-2985`); Claude replies to `control_request` by auto-approving tool uses
  (`claude.go:556-570`). Isolation is instead expressed as sandbox flags/`config.toml`
  (`codexBlockedArgs` includes transport-protocol flags, `codex.go:33-...`), OpenCode is
  launched with `--dangerously-skip-permissions` (`opencode.go:95`), and the human gate is at
  the **issue/branch** level: work lands in review, not in main (README "Review gates",
  **claimed**). Per-tool user approval is **unknown** in the source read.
- **Worktrees / sandboxes.** Local worktree mode snapshots the user's tracked edits *and*
  untracked files into a disposable worktree, never writes the user's dir, commits leftovers to
  a branch, and records ownership in `refs/multica/local-state/` (`execenv/local_worktree.go:19-73`).
  Codex gets a task-local sandbox block (`execenv/codex_sandbox.go`) and per-task `CODEX_HOME`.

---

## 6. Anything else notable

- **Fleet breadth as data, not branches.** New provider = a `SupportedTypes` entry + a
  descriptor/backend, not a cross-stack change (`agent.go:344-402`; `builtin_runtimes.go:8-70`).
  Custom "runtime profiles" can wrap a different binary under a known protocol family, with
  version/argv overlap guarded (`agent.go:318-341`; `models.go:559-575`).
- **Retry taxonomy.** `Result` carries `ResumeRejected`/`ResumeRejectedTransient` and
  `resumeRejectionUndetectable` is an explicit opt-in list, so a new backend fails closed
  rather than inheriting a guess-based retry (`agent.go:252-430`).
- **Liveness watchdogs.** Separate idle, semantic-inactivity, first-turn-no-progress and tool
  watchdogs, with semantic-activity counters so a busy app-server isn't killed for silence
  (`agent.go:26-136`; `ExecOptions` comments).
- **Orchestration.** Agents are first-class assignees; **squads** route work through a leader;
  **autopilots** run on cron; **skills** are reusable playbooks; work arrives via issues, chat,
  or Slack/Feishu/DingTalk/WeCom/Telegram channels (README sections; `server/internal/analytics/events.go:17-31,362-384`
  confirms squad/autopilot telemetry and that a squad autopilot's executing agent is the leader).
- **Cost tracking** per run/agent/issue with a static price table and provider-reported costs
  (`metrics/pricing.go`; README "Usage analytics"). **Model comparison** as a distinct feature
  was not found — **unknown**.
- **Self-hosting / telemetry.** Docker Compose or Helm; an anonymous deployment-level snapshot
  once a day, opt-out via `DO_NOT_TRACK=1` (README; `SELF_HOSTING.md`).
- **CLI drives the same API** as the UI, plus a Multica CLI skill for other agents (README;
  `CLI_AND_DAEMON.md`).

---

## 7. License and what Ferry can legally reuse

**License.** `LICENSE` is the "**Multica License**": the complete, unmodified Apache-2.0 text
(Part II) **plus additional conditions** (Part I) that together form a single license
(`LICENSE:1-9,100-120`). The additional conditions:

1. **Hosted/embedded commercial restriction.** Without a commercial license you may not use the
   source to provide a hosted service to third parties, nor embed Multica as a component of a
   product sold/licensed/distributed to third parties. Internal use inside one organization is
   allowed; publishing a fork's source is allowed but recipients must get their own commercial
   license to operate it (`LICENSE:20-48`).
2. **Branding.** You may not remove/modify the Multica logo, product name, or displayed
   attribution, and the "user interface" definition explicitly covers `apps/web`, `apps/desktop`,
   `apps/mobile`, `packages/views`, `packages/ui`, "when modified, moved, renamed, or extracted
   into another package or repository" (`LICENSE:49-71`).
3. **Non-interface attribution.** If you redistribute/operate a backend/daemon/CLI product
   without a Multica UI, you must retain notices and state in user docs that it's built on
   Multica, with a link (`LICENSE:73-79`).
4. Grants (branding waiver, commercial license) are separate and non-inferable
   (`LICENSE:81-87`); redistributions must deliver the whole LICENSE file (`LICENSE:116-118`).

**Is this OSI open source?** No — the additional conditions make it **source-available**, not a
standard OSS license, despite the Apache-2.0 base. **Ferry is MIT** (`LICENSE`, root and
`packages/*/package.json`). Ferry does not offer a hosted service to third parties today, but
the branding clause is the practical trap.

**What Ferry can legally reuse.**

- **Ideas, protocols, interfaces, and behavior are not copyrightable.** Reimplementing
  "discover models from the signed-in CLI", "normalize ACP/stream-json/app-server events into
  one model", "symlink `~/.codex/auth.json`", or "pair tool calls by id" is fine. The
  *protocols themselves* (ACP, Codex app-server, Claude stream-json, OpenCode JSON) are
  third-party and not Multica's to license.
- **Do not copy Multica source** (Go or TS) into Ferry's MIT tree. Even though the Apache-2.0
  base is MIT-compatible, copying imports the additional conditions (branding/attribution/
  commercial) into Ferry, which is a license-compatibility problem and, for the UI packages, a
  branding violation even if renamed.
- If Ferry ever wants to vendor a specific file, it must (a) get a commercial/branding waiver or
  (b) use only Apache-2.0-only content while retaining Multica's NOTICE and all notices, and
  state the product is built on Multica — a cost not worth paying for these mechanisms.
- **Recommended posture: clean-room reimplementation, cite this document and the Multica repo
  as prior art in comments/PRs, ship no Multica code, keep no Multica names/logos.**

---

## What Ferry should adopt

Ranked, concrete, mapped to Ferry packages. Today Ferry already has the ACP adapter and a
native codex/opencode/claude one-shot runner (`packages/delegate/src/index.ts`), subscription
OAuth through pi-ai (`packages/oauth`), a static catalog snapshot (`packages/catalog`), and a
string-only progress channel in `DelegationRun.progress`
(`packages/shared/src/domain/delegation.ts:48-70`). Multica's edge is that it treats each
signed-in CLI as a **live capability source** and each backend's stream as a **structured event
feed**.

### 1. Replace `progress: string[]` with a structured agent-event model (highest value)

Adopt a normalized event union in `@ferry/shared` (`text | thinking | tool_use | tool_result |
status | error | log`, each with `callId`, timestamps, optional `truncated`), and change
`AdapterResult`/`DelegationRun` to carry it. This is the prerequisite for every UI win below
and the least coupled to any one CLI. Map it into `@ferry/client`/desktop as a task-transcript
model mirroring `packages/views/common/task-transcript/build-steps.ts` (pair by `callId`, group
≥3 same-tool calls, never group shell calls, two-lane model/tool timeline, per-step
`durationMs`). Effort: medium; risk: low.

### 2. Discovery of models + reasoning effort from signed-in CLIs, exposed as "subscription CLI" models

Extend `packages/delegate` with a `listModels(agentId)` discovery module porting Multica's
per-CLI mechanisms, and register the results in `packages/catalog` under a `subscription_cli`
tag (parallel to the existing `subscription_oauth` tag in `packages/oauth/src/index.ts:26-42`):

- Claude: `list_models` control request over `--input-format/--output-format stream-json`
  (`claude_models.go:54-113,274-295`) — per-model effort, disabled rows, no billing.
- Codex: `codex debug models` / `--bundled`, version-gated (`thinking.go:271-493`).
- OpenCode: `opencode models --verbose`, variants → effort (`models.go:771-977`).
- ACP agents: `session/new` `configOptions` + `session/set_config_option`
  (`acp_effort.go:10-120`) — this also lets Ferry flip `supportsModel`/`supportsMode` in
  `data/acp-agents.yaml` from `false` to capability-derived.

Then surface these as selectable models in the picker and as delegation-lane `model`/`effort`
values (`LaneSchema` already has `model`/`effort`/`variant`). Cache ~60 s, **never cache empty/
fallback**, and key by executable+args. Effort: medium-high; this is the flagship adoption and
directly answers Ferry's `docs/ROUTING.md:7` "subscription OAuth models stay excluded unless
enabled" by giving users a first-class, per-CLI subscription path that does not require Ferry to
hold tokens.

### 3. Prefer rich transports over one-shot exec for the big three

For `delegate`, promote per-agent `transport` to a capability:

- Codex: `codex app-server` JSON-RPC (`thread/start|resume|name/set`, `turn/start|steer|
  interrupt`, `thread/tokenUsage/updated`) replaces `codex exec --json`
  (`packages/delegate/src/index.ts:496-508`). Gains: real resume, mid-run steering, interruption,
  per-turn usage, tool-item normalization.
- OpenCode: keep `run --format json` for events but add 2.x server-aware cancel via
  `/api/session/:id/interrupt`, and account for the 2.x argv changes (`--dir`/`--variant`
  removed, variant embedded as `model#variant`) (`opencode_v2.go:13-158,235-289`).
- Claude: the stream-json control protocol already used by Ferry's `-p --output-format
  stream-json` is the same channel for `list_models` and auto-approval; consider the Agent SDK
  path only if it adds resume/steering Ferry needs.
Keep ACP for the long tail. Effort: high (Codex app-server is the big one); risk: medium.

### 4. Login reuse done the safe way (no token reads)

Codify in `packages/delegate`: run each CLI as the user (Claude, OpenCode, ACP); for Codex, give
the task a private `CODEX_HOME` that **symlinks `auth.json`** and copies config
(`execenv/codex_home.go:17-30,195-230`), logging only file kind — never contents. This is both
a ToS-safer and a secret-hygiene improvement over `packages/oauth` storing subscription tokens
(`oauth/src/index.ts:83-110`). Do **not** add login-status probes that read credential files;
discover at model-list time instead. Effort: low-medium; risk: low.

### 5. Protocol-level resume/cancel/steer and per-issue session stores

Ferry already passes `--resume`/`--session`/`resumeId`; adopt Multica's stronger invariants:
resume-rejection detection (`acp_session.go`), a stable per-issue Codex session store separate
from shared history (`codex_home.go:39-92`), and per-model usage accounting
(`TokenUsage` with cache buckets). Effort: medium; risk: medium.

### 6. Isolation and concurrency for delegation

Adopt worktree-per-task for concurrent delegation on one repo, with snapshotting of uncommitted
work and no writes to the user's dir (`execenv/local_worktree.go:19-73`), plus a configurable
concurrency cap (`daemon/config.go:72`). Ferry's ACP write jail
(`packages/delegate/src/index.ts:1339-1364`) is a strong start; worktrees add concurrency without
the per-path lock. Effort: medium-high; risk: medium.

### 7. Version gating and fallback honesty

Port the `MinVersions` table and "fallback catalogs are not authoritative / empty results are
not cached" rules (`version.go:18-36`; `models.go:108-149,534-547`). Ferry's
`data/acp-agents.yaml` has `verified`/`launchVerified` but no version floor; adding one (e.g.
Codex `0.100.0`, OpenCode `1.1.54`, Kiro's ToS caution already present) prevents silent
breakage. Effort: low; risk: low. **What to avoid here:** do not copy Multica's `caution` copy
verbatim or its Kiro note as legal advice.

### Risks, ToS, and what to avoid

- **Subscription-session ToS.** Reusing a CLI's existing login is what these CLIs are for, but
  automating them can still violate provider terms. Ferry must keep an explicit per-agent risk
  notice (it already has one for OAuth: `oauth/src/index.ts:55-56`) and a Kiro-style caution
  (`acp-agents.yaml:102-103`). Do not market it as "free subscription tokens".
- **Credential access.** Never read token file contents; symlink or inherit only. Multica logs
  file kind only (`codex_home.go:1298-1321`); copy that discipline. Ferry's existing
  "never reads or stores agent credentials" promise (`docs/DELEGATION.md:5-7`) is the bar.
- **Secret leakage through workdir.** Multica refuses OpenCode 2.x runs when managed MCP config
  would have to be written into the agent's workdir, because an agent `git add -A` could commit
  credentials (`opencode_v2.go:97-158`). Ferry should adopt the same refusal rather than writing
  secrets into a repo the agent can commit.
- **Auto-approval of tools.** Multica auto-approves Codex/Claude tool requests
  (`codex.go:2921-2985`; `claude.go:556-570`). Ferry currently forwards ACP permission requests
  to an approval callback (`docs/DELEGATION.md:7`; `index.ts:827-843`) — keep that; do not copy
  Multica's blanket auto-approve for `scoped_write` lanes.
- **License.** Importing Multica source risks the branding/commercial conditions; reimplement
  clean-room. Do not copy `packages/views` UI code, the Multica name, or its NOTICE into Ferry.
- **Complexity / scope creep.** Multica ships ~26 adapters and a huge compatibility surface
  (per-CLI deserializers, retry taxonomies, watchdogs). Ferry's brief is UI-first; adopt the
  **event model + discovery for the three or four agents Ferry actually supports**, and keep the
  long tail on ACP rather than porting every vendor quirk.
