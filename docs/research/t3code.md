# R-t3code — what Ferry can learn from T3 Code (UI, features, multi-provider harness)

**Research date: 2026-09-29.** Source read directly from the cloned repo at commit
`d2c9281b8112dc3b2991642c4bdb985e4b08b9bb` (2026-09-28, `fix(web): pull request badge sits on
the sidebar row's baseline (#14007)`). All T3 Code citations below are repo-relative paths plus
line ranges; the same path at that commit resolves to
`https://github.com/pingdotgg/t3code/blob/d2c9281b8112dc3b2991642c4bdb985e4b08b9bb/<path>#Lx-Ly`.
Ferry citations are local file paths at the time of writing. README/marketing-only statements are
marked **claimed**; facts I could not establish from source are marked **unknown**. No Ferry
`src/` changes were made; this file is docs-only.

## Plain-English summary (10 lines)

1. **T3 Code is an agent control surface, not a router.** It is a Node WebSocket server that wraps
   locally installed coding-agent CLIs (Codex, Claude Code, Cursor, Grok Build, OpenCode,
   Antigravity) and serves three clients: web, Electron desktop, and an Expo/React-Native mobile
   app (`AGENTS.md#L3`, `apps/`, `packages/`).
2. **It is bring-your-own-subscription.** It reuses each CLI's own login and never pools provider
   access; there is no routing, quota ledger, or free-tier scoring — the opposite of Ferry's core
   (`README.md#L5`, `README.md#L9`).
3. **License is MIT, Copyright (c) 2026 T3 Tools Inc.** (`LICENSE#L1-L3`), so code and ideas are
   both reusable with attribution.
4. **Stack:** React 19 + Vite + TanStack Router/Query + Tailwind 4 + shadcn-style UI on the client;
   Effect 4 (RC) + Effect/Schema on the server; SQLite event log; Expo/React-Native mobile
   (`apps/web/package.json`, `pnpm-workspace.yaml#L24-L54`).
5. **Its architecture is the interesting part:** typed WebSocket RPC → command → pure decider →
   persisted events → projector read model, with side effects in queue-backed reactors and a receipt
   per command for idempotent retries (`AGENTS.md#L143-L147`, `docs/internals/overview.md#L53-L82`).
6. **Every turn ends in a checkpoint:** a hidden Git ref in the user's own repo, used for per-turn
   diffs and revert, coordinated with provider conversation rollback
   (`docs/internals/overview.md#L72-L82`, `apps/server/src/checkpointing/CheckpointStore.ts#L51-L99`).
7. **The UI is genuinely polished**: a virtualized timeline (`@legendapp/list`), Pierre diff viewer
   in a Web Worker pool (`@pierre/diffs`), a real command palette, per-thread terminals on Ghostty,
   model/effort "traits" pickers, plan cards, and drag-to-settle thread sidebars
   (`apps/web/src/components/...`).
8. **Feature gaps on Ferry's side:** worktree-per-thread, commit/push/PR from the UI, hidden-ref
   turn checkpoints, first-class terminals, command palette, remote/web/mobile surfaces, and
   file-based keybindings.
9. **Features Ferry has that T3 lacks:** free/paid routing across provider APIs, quota ledger and
   cooldowns, planner/editor roles, handoff markers, output optimizers, and the local
   OpenAI/Anthropic-compatible Gateway.
10. **Bottom line:** T3 is a better *harness and UI*; Ferry is a better *router and quota manager*.
    Copy T3's UI patterns and event-sourced/turn-checkpoint architecture; do not copy its Effect-heavy
    stack or its "wrap the vendor CLI" model.

---

## 1. What T3 Code is

**Product.** "T3 Code is an 'agent harness control surface'. It enables control of the agents on
your machine with a best-in-class mobile app … web app … and Electron-based desktop app."
(`README.md#L3`, **claimed**: "best-in-class"). The repo is described in-tree as "a minimal GUI for
coding agents. A Node WebSocket server wraps provider CLIs and agents … and serves web, desktop, and
mobile clients" (`AGENTS.md#L3`). It positions itself as an "open source 'bring-your-own-subscription'
alternative to Claude Desktop, Codex App, Cursor Glass and Conductor" (`AGENTS.md#L5`). On the
business model: "Wait, what are you selling me? Nothing." (`README.md#L7-L9`).

**License.** MIT, `Copyright (c) 2026 T3 Tools Inc.` (`LICENSE#L1-L3`). Confirmed via GitHub API
(`license` field present; MIT).

**Stack.**
- Monorepo (pnpm 11 workspace, `pnpm-workspace.yaml#L1-L6`): `apps/{desktop,web,mobile,server,marketing}`,
  `packages/{contracts,shared,client-runtime,effect-acp,effect-codex-app-server,ssh,tailscale}`,
  plus `infra/`, `native/`, `oxlint-plugin-t3code`.
- **Desktop:** Electron ("full Electron app that bundles the server runner", `AGENTS.md#L29`;
  root `package.json#L52-L58` has `electron`, `electron-winstaller`).
- **Web:** React 19.2.6, `@tanstack/react-router ^1.160.2`, Tailwind 4, Vite (aliased to "Vite+",
  `pnpm-workspace.yaml#L52-L53`), shadcn-derived `components/ui` (`apps/web/package.json`; UI files
  under `apps/web/src/components/ui`).
- **Server/runtime:** Node (`engines: node ^24.13.1`, root `package.json#L61`), bound by default to
  `DEFAULT_PORT = 3773` (`apps/server/src/config.ts#L19`), SQLite state under a T3 home dir
  (`config.ts#L35-L56`).
- **Mobile:** Expo `~57.0.18` + React Native `0.86.3` (`apps/mobile/package.json`), Clerk for auth.
- **Server libraries:** **Effect 4.0.0-rc.115** (`effect`, `@effect/platform-node`,
  `@effect/sql-pg`), Effect/Schema for all wire contracts, `@effect/atom-react` for client state,
  `node-pty` for terminals, `@pierre/diffs` for diffs (`pnpm-workspace.yaml#L32-L54`).
- State: client state is served by Effect "Atom" hooks (`useAtomValue`, `useAtomCommand`) plus a
  shared `packages/client-runtime`; server state is a projection derived from a SQLite event log
  (`apps/server/src/persistence/Layers/OrchestrationEventStore.ts`,
  `apps/server/src/persistence/Services/Projection*.ts`).
- TypeScript 7.0.2 (`pnpm-workspace.yaml#L51`); lint via `oxlint` + `@shadcn/lint`
  (`package.json#L29`, `AGENTS.md#L161`).

**Maturity / activity.** Very active and large. GitHub API at fetch time:
created `2026-02-08`, pushed `2026-09-29`, **23,875 stars, 6,227 forks, 2,566 open issues, 64
watchers**; nightly + preview releases at `v0.0.43` (`v0.0.43-nightly.20260929.2428`). The README
still says "We are very very early in this project. Expect bugs." and "We are (mostly) not accepting
contributions yet" (`README.md#L83-L85`) — **claimed/positioning**, but contradicted in practice by
a large contributor-facing `AGENTS.md`. In-tree it claims "over 200,000 users"
(`AGENTS.md#L13`) — **claimed (docs)**, not independently verifiable here.

**Screenshots/assets.** Brand assets live under `assets/{dev,nightly,prod}` (app icons and
blueprints: `assets/dev/blueprint-*.png`, `assets/nightly/*-ios-1024.png`). Product screenshots are
**unknown** in-repo; the README points to the App Store / Google Play / t3.codes rather than
committed screenshots (`README.md#L3`, `#L43-L79`). There is no `docs/screenshots` directory.

---

## 2. Provider / agent integration

### 2.1 What it drives

Six first-party drivers are registered statically in
`apps/server/src/provider/builtInDrivers.ts#L23-L56`: **Codex, Claude Agent, Cursor, Grok,
OpenCode, Antigravity**. All are wrapped local CLIs/SDKs; there is **no raw provider HTTP API
integration** (this is the deliberate inverse of Ferry). Auth is the vendor's own: the README tells
users to run `codex login`, `claude auth login`, `agent login` (Cursor), `grok login`,
`opencode auth login`, or Antigravity's Google sign-in (`README.md#L16-L23`).

Two protocol integrations exist as dedicated packages:
- `packages/effect-codex-app-server` — a typed Effect client over the **Codex app-server** JSON-RPC
  protocol (`client.ts`, `protocol.ts`, `_generated/schema.gen.ts`).
- `packages/effect-acp` — a typed Effect client/agent for the **Agent Client Protocol** (ACP), used
  by Cursor/Grok/Antigravity and any ACP-capable agent (`agent.ts#L31-L119`, `client.ts`,
  `_generated/schema.gen.ts`). Claude uses the bundled `@anthropic-ai/claude-agent-sdk`
  (`pnpm-workspace.yaml#L88`, overrides strip its platform binaries because the user's own Claude
  executable is passed in, `#L108-L116`).

### 2.2 Driver SPI (how a provider plugs in)

`ProviderDriver` is a **plain record, not a service singleton** — deliberately, so many instances of
the same driver can coexist (`apps/server/src/provider/ProviderDriver.ts#L1-L23`). A driver exposes
`driverKind`, static `metadata`, a `configSchema` (Effect `Codec<Config, unknown>`), `defaultConfig`,
and `create(input) → Effect<ProviderInstance>`. `create` owns all per-instance state and must release
it on scope close (`ProviderDriver.ts#L136-L174`). A materialized `ProviderInstance` bundles
`snapshot`, `adapter`, `textGeneration`, auth, model refresh, and reset-credit redemption
(`ProviderDriver.ts#L67-L91`). Key design point: routing is by **instance id**, not driver kind, so
two accounts on the same driver never share mutable state (`docs/internals/providers.md#L8-L10`).

### 2.3 Launch / stream / cancel / resume

Provider CLIs run as **child processes** (`ChildProcessSpawner`, `ACPSpawnInput` with
`command`/`args`/`cwd`/`env`: `AcpSessionRuntime.ts#L75-L81`). Per-provider **adapters** translate
native protocols into normalized orchestration events; orchestration itself never knows which
provider runs a thread (`docs/internals/providers.md#L1-L6`). The ACP runtime has explicit budgets:
session-load timeout 90s, replay idle gap 2s, cancel timeout 15s, 32 KiB stderr cap
(`AcpSessionRuntime.ts#L68-L73`) and supports `resumeSessionId` with `resumeMethod: "load" |
"resume"` (`#L83-L89`). Sessions are a durable read-model concept (`OrchestrationSession`, status
`idle|starting|running|ready|interrupted|stopped|error`,
`packages/contracts/src/orchestration.ts#L608-L628`), so a thread survives a provider process exit
("Thread … survives provider process exits", `docs/internals/glossary.md#L15`). Provider session
runtime is itself persisted (migrations `004_ProviderSessionRuntime.ts`, `009_ProviderSessionRuntimeMode.ts`).

### 2.4 Reusing logins / credential handling

T3 does **not** store most provider credentials; it uses the CLI's own auth. Where it must store
something it keeps it environment-local: `ProviderCredentialStore.ts`, `cursorCredentialStore.ts`,
`secretsDir` (`config.ts#L45`). Antigravity is forced to file-based credential storage because the
macOS keychain entry would otherwise be shared across instances, and its launch environment strips
ambient Google credentials so an instance cannot silently bill another project
(`docs/internals/providers.md#L25-L31`).

### 2.5 Model / effort discovery

- **Codex** gets its model list from its own app server; **Claude** uses a bundled manifest; generic
  presentation/capability data is in `apps/server/src/provider/model-manifest.json`
  (`docs/internals/model-manifest.md#L1-L27`). The manifest starts with a `compatibility` table that
  maps each driver to supported CLI version ranges (e.g. Codex `>=0.156.0` supported,
  `<0.149.0` broken; `model-manifest.json#L1-L32`).
- **Effort/reasoning** is modelled as generic provider **option descriptors** (`select`/`boolean`):
  ids seen in the picker include `effort`, `reasoningEffort`, `variant`, `agent`, `contextWindow`,
  `fastMode`, `thinking` (`apps/web/src/components/chat/TraitsPicker.tsx#L45-L50`, `#L163-L170`).
- `ModelSelection` is `{ instanceId, model, options }`; the wire schema even upgrades legacy
  `{provider, model}` payloads via a decoding transform (`orchestration.ts#L60-L126`).

### 2.6 Approvals / permissions

Two orthogonal controls:
- **Runtime mode** (per thread): `approval-required | auto-accept-edits | auto | full-access`;
  default is `full-access` (`orchestration.ts#L128-L138`). User-facing names are Supervised /
  Auto-accept edits / Auto / Full access (`docs/user/permission-modes.md#L11-L16`).
- **Provider approval/sandbox policy**: `ProviderApprovalPolicy`
  (`untrusted|on-failure|on-request|never`) and `ProviderSandboxMode`
  (`read-only|workspace-write|danger-full-access`) (`orchestration.ts#L46-L58`).

Approval requests carry a `ProviderRequestKind` (`command|file-read|file-change|mcp-elicitation|permission`)
and a decision set (`accept|acceptForSession|acceptAlways|decline|cancel`) with an optional
provider warning string for prompt-injection caution (`orchestration.ts#L139-L163`). Approvals are
projected so the shell can flag pending ones (`hasPendingApprovals`, `orchestration.ts#L920`).
Providers differ: Auto uses automatic review only where the provider supports it (Codex/Claude/
Cursor); Grok adds "Always allow this session"; Antigravity can still ask in Full access
(`docs/user/permission-modes.md#L21-L31`). ACP requests flow through `client.requestPermission`
(`packages/effect-acp/src/agent.ts#L53-L60`).

### 2.7 Multiple concurrent sessions, worktrees, branches

- Threads are durable and mutually independent; each has `branch` and `worktreePath`
  (`orchestration.ts#L802-L803`). A thread can start a **Git worktree** instead of the project's
  main checkout (`docs/internals/glossary.md#L14`), and new-thread bootstrap can prepare a worktree
  (`ThreadTurnStartBootstrapPrepareWorktree`, `orchestration.ts#L1303-L1309`).
- The UI exposes **"New worktree"** and **"New thread in this worktree"**, and **Shift-clicking
  multiple models** starts one thread+worktree per model with the same prompt
  (`docs/user/thread-sidebar.md#L1-L26`).
- Isolation rules for shared resources: T3-managed OpenCode uses **one server per thread**, because
  MCP registration is directory-scoped while T3's MCP connection is thread-scoped
  (`docs/internals/providers.md#L13-L20`).
- Concurrency safety: a command acknowledgement means intent committed, **not** that provider work
  finished; external I/O stays out of the decider and DB transaction
  (`docs/internals/overview.md#L53-L70`).

---

## 3. UI / UX (the main reason for this research)

Web UI root is `apps/web/src`. The desktop app wraps it (`AGENTS.md#L70`: "desktop (wraps web, adds
Electron shell/IPC)"), and mobile is a separate React-Native navigation. The shared behavioral layer
between web and mobile is `packages/client-runtime`.

### 3.1 Layout

- **Chat surface:** `ChatView.tsx` (10,414 lines) composes a `WorkspacePageHeader` (`ChatHeader.tsx`)
  over a chat column that holds the virtualized `MessagesTimeline` and a composer overlay
  (`ChatView.tsx#L9760-L9930`). The composer is centered as a "draft hero" when a new thread has no
  messages and docks to the bottom otherwise (`ChatView.tsx#L9932-L9938`).
- **Thread layout uses page scroll, not an inner scroll box:** scroll-position memory and anchoring
  are explicit modules (`pageScrollController.ts`, `timelineScrollAnchoring.ts`).
- **Header** carries project favicon, rename-in-place title, thread action menu, Git actions,
  project scripts, and an "Open in" editor picker (`ChatHeader.tsx#L126-L160`, `#L107-L124`).
- **Command palette** (`Cmd/Ctrl+K`) searches commands, projects, and threads across connected
  environments, with a `>` prefix for commands only (`CommandPalette.tsx#L1-L140`;
  `docs/user/thread-sidebar.md#L130-L132`).

### 3.2 Chat / thread timeline and rendering

`apps/web/src/components/chat/MessagesTimeline.tsx` (5,007 lines) renders rows produced by a pure
projector, `deriveMessagesTimelineRowsWithState` (`MessagesTimeline.logic.ts`). Roles include a
dedicated **`reasoning`** role — the thinking trace is a sibling of assistant text, not a
replacement (`orchestration.ts#L563-L572`). Activities (tool calls, approvals, failures) are
separate timeline items with a `tone` of `info|tool|approval|error`
(`orchestration.ts#L653-L671`).

Concrete rendering choices:
- **Thinking / reasoning** and tool activity use distinct icons (`BrainIcon`, `WrenchIcon`,
  `HammerIcon`, `TerminalIcon`, `SquarePenIcon`, `ZapIcon`, `EyeIcon`, …)
  (`MessagesTimeline.tsx#L109-L133`).
- **Tool calls** can be grouped: consecutive calls collapse into one bounded, virtualized group
  ("Renders standalone activity or one bounded, virtualized expanded tool group",
  `MessagesTimeline.tsx#L2939`), and summaries can rewrite shell wrappers
  (`docs/user/thread-sidebar.md#L139-L145`).
- **Diffs inside the chat** are rendered by Pierre's `FileDiff` (`MessagesTimeline.tsx#L79`), using
  `getRenderablePatch`/`resolveDiffThemeName` (`#L98-L103`). Turn diff summaries come from
  `thread.checkpoints` (`ChatView.tsx#L9846-L9849`).
- **Plan display:** `ProposedPlanCard` (badge "Plan", title, markdown body, collapse if > 900 chars
  or > 20 lines, copy / download-as-markdown / **save-to-workspace** actions)
  (`apps/web/src/components/chat/ProposedPlanCard.tsx#L36-L260`). Plans are persisted with an
  `implementedAt`/`implementationThreadId` lifecycle (`orchestration.ts#L590-L601`).
- **Rollback:** each user message can carry a revert action (`RevertUserMessageButton`,
  `onRevertToTurnCount`, `MessagesTimeline.tsx#L2236-L2306`), gated by
  `supportsConversationRollback` (`ChatView.tsx#L9857-L9863`) — the provider must be able to roll
  back its conversation or the checkpoint boundary rejects the revert
  (`docs/internals/providers.md#L93-L96`).

### 3.3 Composer, model/effort pickers

- `ChatComposer.tsx` (7,056 lines) with sub-parts for pending-approval actions, pending-user-input,
  plan follow-up, banners, usage limits, context-window meter, queued messages, stashes, and
  attachments (`apps/web/src/components/chat/`).
- **Model picker:** trigger + `ModelPickerContent`; supports multi-select (fan-out), locked-provider
  continuation, per-instance icons/badges, and unavailable-model labeling
  (`ProviderModelPicker.tsx#L28-L314`; `ModelPickerContent.tsx`).
- **Effort/reasoning picker:** `TraitsPicker.tsx` renders provider option descriptors as menus with
  a "Default" badge (`#L94-L170`).
- Keyboard: `mod+shift+m` model, `mod+shift+h` host, `mod+shift+e` effort, `mod+shift+a` access
  mode, `mod+shift+x` workspace, `mod+shift+g` branch, `mod+shift+l` previous worktree
  (`docs/user/keybindings.md#L17-L26`).
- Rich-text composer is Tiptap-based with a hand-rolled coordinate/serialization model that keeps
  chip identity stable (`apps/web/src/components/chat/ComposerPromptEditorTiptap.tsx`;
  `docs/internals/composer-editors.md#L1-L27`).

### 3.4 Diff review / accept flow and source control

- `DiffPanel.tsx` (1,205 lines) is the review surface: file tree, collapse/expand, line-stat,
  whitespace and layout toggles, base-ref combobox, and Pierre `CodeView` via
  `AnnotatableCodeView` and `StyledDiffCodeView` (`DiffPanel.tsx#L1-L93`).
- `StyledDiffCodeView` documents virtualization geometry explicitly (header 32px, hunk separator
  24px, padding-bottom 8px, zero spacing) — a hard-won list-height contract
  (`apps/web/src/components/diffs/StyledDiffCodeView.tsx#L280-L324`).
- The diff renderer runs in a **worker pool**: `DiffWorkerPoolProvider` wires
  `WorkerPoolManager` + `@pierre/diffs/worker` (`DiffWorkerPoolProvider.tsx#L1-L3`).
- Inline review comments and "mark file viewed" exist (`DiffCommentAnnotation.tsx`,
  `pullRequestViewedFiles.ts`); GitHub viewed marks round-trip with github.com
  (`docs/user/source-control.md#L130-L142`).
- Commit/push/PR from the UI plus message/title/description generation and repo conventions:
  `GitActionsControl.tsx`, `GitWorkflowService.ts#L1-L50`, `docs/user/source-control.md#L94-L100`.
  Multi-host: GitHub, GitLab, Forgejo/Gitea, Bitbucket, Azure DevOps (`source-control.md#L1-L6`).

### 3.5 Sidebar, terminals, notifications, theming, polish

- **Thread sidebar** groups Pinned / Active / Snoozed / Settled with drag-to-change-state and
  bounded undo (`docs/user/thread-sidebar.md#L28-L115`); `thread.undo` (`mod+z`) reverses the last
  reversible action for five seconds (`docs/user/keybindings.md#L114-L118`).
- **Terminals:** `ThreadTerminalDrawer.tsx` renders a resizable drawer (min 180px, max 75% viewport,
  `#L93-L105`) hosting a **Ghostty** surface (`apps/web/src/terminal/ghostty/surface`, `core.ts`),
  with split/new/close and clear shortcuts (`ThreadTerminalDrawer.tsx#L1-L120`,
  `docs/user/keybindings.md#L127-L135`). Server-side PTY history is incremental, capped at 5,000
  lines / 8 MiB per terminal, with a separate 512 KiB client buffer
  (`docs/internals/terminal-runtime.md#L8-L28`).
- **Notifications** for approvals/background work and thread badges
  (`ThreadNotificationCoordinator.tsx`).
- **Theming:** Tailwind 4 with multiple built-in themes (`html[data-theme-id="t3-chat" | "grove" |
  "ocean" | "ember" | "iris"]`, `apps/web/src/index.css#L689-L817`), a theme editor, and VSCode/
  Open-VSX theme import (`ThemeEditorPanel.tsx`, `vscodeThemeImport.ts`, `openVsxThemes.ts`).

### 3.6 Performance tricks (explicit, with citations)

- **Virtualized timeline:** `LegendList` from `@legendapp/list/react`, with custom end-follow /
  `maintainScrollAtEnd` tuning (`MessagesTimeline.tsx#L74-L79`, `#L1292`, `#L3100`;
  `ChatView.tsx#L9821` comment "LegendList handles virtualization and scrolling internally").
- **Lifecycle-only work:** tasks run when scrolled into view via
  `observeVisibleAnimation` (`MessagesTimeline.tsx#L59`).
- **Cheap long lists:** sidebar rows use CSS containment —
  `[content-visibility:auto] [contain-intrinsic-size:auto_36px]` (`Sidebar.tsx#L1606`) and
  `...auto_78px` (`#L1762`); PR rows use `[contain-intrinsic-block-size]`
  (`PullRequestSummaryTab.tsx#L215`).
- **Diff work off the main thread:** worker pool (`DiffWorkerPoolProvider.tsx`).
- **No continuously repainting animations:** called out as a hard product rule because users "notice
  a dropped frame, a lying spinner, and a stale label" (`AGENTS.md#L164`); scroll/measurement code
  avoids per-frame React work.
- **Data budget:** "often caused by sending too much data over websockets" is audited
  (`AGENTS.md#L17`); subscriptions send only what a client needs, and thread detail is windowed and
  paginated (`docs/internals/overview.md#L16-L18`; `OrchestrationThreadDetailWindow`,
  `orchestration.ts#L1045-L1082`).

### 3.7 What feels notably polished and why

- **Per-turn revert is one click away on the user message itself** (`RevertUserMessageButton`), not
  buried in a menu — and it is guarded by a capability check so it cannot half-apply.
- **The plan card is an artifact, not a message:** collapsible, copyable, downloadable, and
  saveable into the workspace (`ProposedPlanCard.tsx`).
- **The sidebar is a state machine you can drag:** dragging a row into another section shows the
  action it will perform with an icon, other rows slide aside, section labels stay readable, and it
  respects reduced motion (`docs/user/thread-sidebar.md#L48-L77`).
- **Keyboard everywhere:** every entry point also has a command id and a customizable binding with
  a `when` mini-language (`keybindings.ts#L160-L252`, `docs/user/keybindings.md#L53-L107`).
- **Terminal and diff are real products**, not read-only embeds: Ghostty surface, worker-pooled
  Pierre viewer, annotated review comments.

---

## 4. Feature delta vs Ferry

### 4.1 Features T3 has that Ferry lacks

| Feature | T3 evidence | Ferry status |
|---|---|---|
| Worktree-per-thread + branch per thread | `orchestration.ts#L802-L803`; `docs/user/thread-sidebar.md#L1-L26` | No worktree code found (`grep worktree packages/workspace packages/core` empty); Ferry session has no branch/worktree field (`packages/shared/src/domain/session.ts#L15-L28`) |
| Commit / push / create-PR from the UI | `GitWorkflowService.ts`, `GitActionsControl.tsx`, `docs/user/source-control.md#L94-L100` | Ferry `git.ts` only has status/diff/log/branch (`packages/workspace/src/git.ts#L22-L34`) |
| Multi-host PR review (GitHub/GitLab/Forgejo/Bitbucket/Azure) | `apps/server/src/pullRequest/*`, `sourceControl/*` | None |
| Hidden-ref turn checkpoints + revert coordinated with agent state | `CheckpointStore.ts#L51-L99`, `orchestration.ts#L631-L651` | Ferry has `ShadowCheckpoints` in a **separate bare repo** (`packages/workspace/src/git.ts#L35-L165`) and a checkpoint message part, but no per-turn diff summary in the read model |
| First-class terminals (Ghostty + node-pty) | `ThreadTerminalDrawer.tsx`, `apps/server/src/terminal/Manager.ts` | `BottomPanel.tsx` stub; STATUS notes xterm is still code-split todo (`docs/STATUS.md#L18`) |
| Command palette | `CommandPalette.tsx` | STATUS A4 lists "palette" as in progress (`docs/STATUS.md#L9`) |
| File-based, when-clause keybindings | `keybindings.ts`, `~/.t3/userdata/keybindings.json` | `KeyboardShortcutsDialog.tsx` only |
| Remote / web / mobile clients | `AGENTS.md#L23-L31`, `packages/{ssh,tailscale}`, relay | None (Ferry Gateway is API-compat, not a client control plane) |
| Shared client runtime across surfaces | `packages/client-runtime` | UI is desktop-only today |
| Drag-to-settle/snooze/archive thread shelves | `docs/user/thread-sidebar.md#L28-L115` | Pinned/starred only (`packages/shared/src/domain/session.ts#L21-L23`) |
| Proposed-plan artifact lifecycle + "implement plan" | `orchestration.ts#L590-L601`, `ProposedPlanCard.tsx` | Plan exists as `PlanItem` in a `TaskRecord` (`session.ts#L137-L151`) but no artifact card lifecycle |
| Interaction mode (plan) distinct from permissions | `ProviderInteractionMode = default\|plan` (`orchestration.ts#L136`) | None |
| Subagents/Agents panel | `AgentsPanel.tsx`, `subagentRuntime` | Ferry has delegation lanes but no in-chat agents panel |
| In-app browser preview | `preview/`, `previewUrl` on scripts (`orchestration.ts#L438-L444`) | None |
| Voice input | `docs/internals/voice-input.md` | None |

### 4.2 Features Ferry has that T3 lacks (positioning)

- **Cross-provider free/paid routing with a quota ledger and cooldowns** (`docs/ROUTING.md`,
  `docs/GATEWAY.md`). T3 deliberately does **not** route or account for quota; it drives one
  signed-in subscription at a time (`README.md#L9`).
- **Planner/editor role split** and **structured edit-plan handoff** (`docs/ROUTING.md#L16-L33`).
- **Handoff markers and briefings** when the model changes mid-task
  (`packages/shared/src/domain/session.ts#L77-L85`).
- **Output optimizer / context compression with recovery handles**
  (`session.ts#L43-L50`).
- **Local OpenAI- and Anthropic-compatible Gateway** so third-party clients (OpenCode, Cline,
  Aider, Continue, Claude Code) use Ferry's routing (`docs/GATEWAY.md`).
- **BYO API keys in the OS keyring**, free-tier capacity display, data-use warnings.
- **Delegation fleet lanes** to Codex/OpenCode/Claude/ACP with sandboxed paths and review
  (`docs/DELEGATION.md`).

Net: Ferry's moat is *routing + quota + gateway*; T3's moat is *harness UX + multi-surface control
plane*. They are complementary, and Ferry can adopt T3's harness UX without giving up routing.

---

## 5. Architecture notes worth copying

### 5.1 Event-sourced orchestration (biggest idea)

The in-tree summary is exact:

> "Clients send typed WebSocket requests. The server turns them into _commands_, a pure _decider_
> turns commands into persisted _events_, and a _projector_ derives the read model the UI renders.
> Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into
> orchestration events. Side effects run in queue-backed _reactors_ that emit _receipts_ when
> milestones land. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and
> restore." (`AGENTS.md#L143-L147`)

Properties Ferry should borrow for Part B:
- **Events, projections, and the accepted command receipt commit in one DB transaction**, and
  in-memory state changes only after commit (`docs/internals/overview.md#L53-L61`). This makes
  retries idempotent.
- **Decider is pure**; no provider or filesystem work in it. Runtime receipts are test-only signals,
  separate from durable command receipts (`overview.md#L53-L70`, `#L84-L92`).
- **Persisted events must remain decodable on replay**; schema changes are a compatibility surface
  for stored history, not just current traffic (`overview.md#L67-L70`).

### 5.2 Read models: shell vs thread detail, subscriptions with sequence resume

`OrchestrationShellSnapshot` / `OrchestrationThreadDetailSnapshot` split "everything" from "one
thread" (`orchestration.ts#L946-L952`, `#L1075-L1082`). Subscriptions accept `afterSequence` to
resume without a full snapshot and `requestCompletionMarker` for a synchronized barrier
(`orchestration.ts#L990-L1034`). Thread detail is windowed by `turnLimit`/`beforeCursor` with an
opaque cursor and a thread-scoped sequence watermark to prevent streaming deltas duplicating paged
text (`#L1036-L1073`). The client shares one live stream per thread and caches the replay cursor for
five idle minutes (`docs/internals/connection-runtime.md#L58-L62`).

### 5.3 Checkpoints and turn diffs

`CheckpointStore` captures a commit into a **hidden ref inside the user's repo** using an isolated
temporary index, restores workspace+staging, and computes patch/numstat diffs between refs
(`CheckpointStore.ts#L51-L99`). `OrchestrationCheckpointSummary` stores `turnId`, a monotonic
`checkpointTurnCount`, `checkpointRef`, status, and per-file add/delete counts in the read model
(`orchestration.ts#L631-L651`). Revert must coordinate workspace state with the provider
conversation; a provider that cannot roll back its conversation must reject the op **before**
touching the filesystem (`overview.md#L79-L82`).

### 5.4 Persistence and transport

- **SQLite** with numbered migrations and separate projection tables
  (`apps/server/src/persistence/{Layers,Services,Migrations}`; e.g. `001_OrchestrationEvents.ts`,
  `005_Projections.ts`). Event store: `OrchestrationEventStore.ts`.
- **One WebSocket transport** carrying 144 typed `Rpc.make` methods in a single contract group
  (`packages/contracts/src/rpc.ts`, 1,539 lines; `apps/server/src/ws.ts#L3828-L3893` uses Effect
  `RpcServer.makeProtocolWithHttpEffectWebsocket`). Same contract serves HTTP for snapshots
  (`apps/server/src/http.ts`).
- **Client runtime is shared** across web/desktop/mobile: one connection owner per environment, a
  transport-retry supervisor, and domain state services (`packages/client-runtime/src/`; documented
  in `docs/internals/connection-runtime.md#L1-L83`).

### 5.5 Keeping the UI fast

Rule of thumb: **render from a projection, stream deltas, virtualize, and contain.** Concrete
examples are in §3.6. Two transferable specifics: (a) a versioned diff viewer with a declared
`itemMetrics` layout contract (`StyledDiffCodeView.tsx#L300-L321`); (b) CSS `content-visibility` for
long non-virtualized lists (`Sidebar.tsx#L1606`).

---

## 6. License: what Ferry may legally reuse

- T3 Code is **MIT** (`LICENSE#L1-L3`). Ferry is **MIT** (`LICENSE`; `package.json` `"license":
  "MIT"`). MIT permits use, copy, modify, merge, publish, distribute, sublicense, and sell, with the
  single obligation that the copyright notice and permission notice be included in copies or
  substantial portions (`LICENSE#L6-L11`).
- **Code:** Ferry may copy/adapt T3 source **if** it keeps the T3 copyright notice — so add T3 Code
  to `NOTICE` and, where whole files are adapted, keep a header crediting `Copyright (c) 2026 T3
  Tools Inc.` and the MIT text.
- **Ideas/patterns:** interface designs, layout, event-sourced architecture, hidden-ref checkpoints,
  keybinding `when`-language — freely reusable; not copyrightable as ideas.
- **Caveats:** (1) do not copy T3 brand names/logos or the `T3` wordmark; (2) T3's own
  `third-party-licenses.config.json` and vendored `.repos/` references carry other licenses — check
  per dependency (e.g. `@pierre/diffs` is a dependency, not T3 code, and has its own license);
  (3) some T3 features wrap third-party CLIs whose terms govern the wrapping, not the code.
- **Practical recommendation:** re-implement patterns in Ferry's own idioms (zod vs Effect/Schema,
  Promise vs Effect) rather than transliterating files; this avoids carrying Effect 4-RC, TS 7, and
  shadcn lint assumptions into Ferry's stricter token/lint regime.

---

## What Ferry should adopt

Ranked by impact vs effort. "Effort" is rough engineering days for one implementer inside Ferry's
current Part-A/Part-B split; UI items are mock-compatible now.

### Quick UI wins (mock-compatible, days)

1. **Virtualize/paint-guard the long lists** — *Low effort, high felt speed.*
   `apps/desktop/src/renderer/app/Sidebar.tsx` already maps session rows; add
   `[content-visibility:auto] [contain-intrinsic-size:auto_*]` (pattern:
   `apps/web/src/components/Sidebar.tsx#L1606`, `#L1762`). In
   `packages/ui/src/components/chat/index.tsx`, keep `ToolStepGroup`/`ToolCallBlock` virtualized
   when expanded (pattern: `MessagesTimeline.tsx#L2939`). Ferry already uses
   `@tanstack/react-virtual` in `Canvas.tsx#L13`, so extend it rather than adding `@legendapp/list`.
2. **Command palette** — *Low-medium.* `apps/desktop/src/renderer/app/` (new `CommandPalette.tsx`)
   + a `Ctrl/K` binding in `KeyboardShortcutsDialog.tsx`. Mine the structure of
   `apps/web/src/components/CommandPalette.tsx` (commands + projects + sessions; `>` prefix).
   STATUS already lists it as A4 work (`docs/STATUS.md#L9`).
3. **Effort/variant picker as typed option descriptors** — *Low-medium.* Extend Ferry's model
   picker (`SessionPowerControls.tsx` `ModelPickerPopover`) with the `TraitsPicker.tsx` pattern:
   provider-supplied `select`/`boolean` descriptors (`effort`, `reasoningEffort`, `variant`,
   `agent`, `contextWindow`, `fastMode`, `thinking`) rendered as menus with a "Default" badge
   (`TraitsPicker.tsx#L45-L170`). Add the field to `ModelRef`/session options in
   `packages/shared/src/domain/provider.ts`.
4. **Plan card actions** — *Low.* Ferry has `PlanItem`; give the plan a real card (collapse,
   copy, download, save-to-workspace) modelled on `ProposedPlanCard.tsx#L36-L260`, and store plan
   artifacts in `packages/shared/src/domain/session.ts` (mirroring `OrchestrationProposedPlan`,
   `orchestration.ts#L590-L601`).
5. **Sidebar shelves + drag state changes** — *Low-medium.* Add Snoozed/Settled shelves and
   drag-to-settle/pin to `Sidebar.tsx`; reuse `docs/user/thread-sidebar.md#L48-L77` interaction
   details. Pairs with Ferry's existing 5s Undo contract (`design/archive/DESIGN-v1.md#L284`).
6. **Undo-toast for reversible thread actions + `mod+z`** — *Low.* Align Ferry's 5s Undo
   (`design/archive/DESIGN-v1.md#L284`) with a command-style `thread.undo` (`docs/user/keybindings.md#L114-L118`).
7. **Diff review polish** — *Medium.* Ferry already has `ReviewCanvas.tsx`/`reviewActions.ts` and
   `MONACO` diff. Add: file tree, mark-viewed, inline comments, whitespace toggle, and (if needed)
   a worker to keep big diffs off the main thread (pattern: `DiffWorkerPoolProvider.tsx`). Do not
   re-tune Pierre; Ferry's Monaco is fine.
8. **File-based keybindings with `when` clauses** — *Medium.* Ferry's `KeyboardShortcutsDialog.tsx`
   is the UI; add a `packages/config`-owned `keybindings.json` parser like `keybindings.ts`
   (`#L160-L252`) documented per `docs/user/keybindings.md#L53-L107`. Reuse the `terminalFocus`,
   `editableFocus`, `isWeb`, `isDesktop` context keys.

### Bigger features (Part B / engine + workspace)

9. **Worktree-per-thread** — *High impact, medium-high effort.* This is T3's single best feature and
   Ferry has nothing. Add `worktreePath`/`branch` to `SessionSchema`
   (`packages/shared/src/domain/session.ts`), worktree create/list/remove to
   `packages/workspace/src/git.ts`, and a "New worktree" affordance in `Canvas.tsx` /
   `SessionPowerControls.tsx`. T3 evidence: `orchestration.ts#L802-L803`,
   `ThreadTurnStartBootstrapPrepareWorktree` `#L1303-L1309`.
10. **Event-sourced core + idempotent command receipts** — *High impact, high effort.* Adopt the
    command→decider→event→projector→reactor loop (`AGENTS.md#L143-L147`,
    `docs/internals/overview.md#L53-L70`) in `packages/core/src/domains/*` behind
    `RpcFerryClient` (`docs/ARCHITECTURE.md#L5-L7`). Transactionally commit events + projection +
    command receipt; keep the decider pure. This directly de-risks `packages/agent`'s current
    in-process `AgentEvent` stream (`packages/agent/src/loop.ts#L74-L88`).
11. **Hidden-ref turn checkpoints + turn diff summaries** — *High impact, medium effort.* Ferry's
    `ShadowCheckpoints` already snapshots to a bare repo (`packages/workspace/src/git.ts#L35-L165`);
    upgrade to **hidden refs in the user's repo** so checkpoints survive and appear in `git log`
    tooling, and store per-turn summaries (files, additions/deletions, `checkpointRef`,
    `checkpointTurnCount`) in the read model like `OrchestrationCheckpointSummary`
    (`orchestration.ts#L631-L651`; `CheckpointStore.ts#L51-L99`). Enforce the "reject revert before
    touching files when the provider cannot roll back" rule (`overview.md#L79-L82`).
12. **Git actions from the UI (commit/push/PR)** — *High impact, medium effort.* Extend
    `packages/workspace/src/git.ts` past status/diff/log/branch to commit, push, branch, and PR
    creation, and surface it in `Canvas.tsx`/`ChatHeader`-equivalent. T3's split
    (`GitWorkflowService.ts#L1-L50`, `GitActionsControl.tsx`) plus `SourceControlProvider`
    registry is a good shape. Start with GitHub CLI (`gh`), then add bare Git remotes.
13. **First-class terminals** — *Medium-high impact, medium-high effort.* Replace the
    `BottomPanel.tsx` stub with a PTY-backed terminal (node-pty or `execa` fallback) owned by the
    core, with bounded, incremental history (T3: 5,000 lines / 8 MiB, `terminal-runtime.md#L8-L28`)
    and per-thread terminal state in `apps/desktop/src/renderer/app`.
14. **Remote/web client control plane** — *High impact, very high effort.* T3's environment/client
    separation (`AGENTS.md#L23-L31`, `docs/internals/overview.md#L1-L6`) and shared
    `client-runtime` (`connection-runtime.md`) are the blueprint. Ferry's Gateway is API-compat,
    not a control plane; a browser client would need Ferry's typed RPC exposed over the loopback
    listener with auth, plus the same shared-state layer. Defer until Part B lands.
15. **Streaming/reconnect contract** — *Medium impact, medium effort.* Adopt `afterSequence` resume,
    completion markers, and windowed thread detail (`orchestration.ts#L990-L1082`) for
    `RpcFerryClient` so a reconnecting desktop client does not re-download history and de-dupes
    deltas correctly.
16. **Permission modes + plan interaction mode** — *Medium impact, low-medium effort.* Ferry already
    has `ask`/`auto_edit`/`full_auto` (`docs/ARCHITECTURE.md#L49-L51`); add an explicit
    `interactionMode: default|plan` distinct from permissions (`orchestration.ts#L136`) and a
    per-thread runtime-mode selector in the composer.

### Risks and what to avoid

- **Do not adopt Effect 4 / TS 7 / Vite+ wholesale.** T3's stack is bleeding-edge
  (`pnpm-workspace.yaml#L47-L53`). Ferry is stricter (zod, Promise, token lint); transliterating
  Effect code will fight Ferry's gates (`AGENTS.md`). Copy shapes, not imports.
- **Do not copy the giant components.** `ChatView.tsx` (10k lines) and `ChatComposer.tsx` (7k)
  are the opposite of Ferry's "small files, one responsibility" rule (`AGENTS.md`). Take module
  boundaries (`MessagesTimeline.logic.ts` pure projector, `timelineScrollAnchoring.ts`) not the
  monoliths.
- **Do not blindly adopt `@legendapp/list`.** It is React-Native-oriented (patched in T3,
  `pnpm-workspace.yaml#L187`); Ferry already has `@tanstack/react-virtual`. Only switch if a real
  benchmark demands it.
- **Do not weaken Ferry's differentiators chasing parity.** Worktrees, PRs, and terminals are
  harness features; Ferry's routing/quota/gateway must not be deprioritized. T3 explicitly has no
  routing/quota — that is Ferry's moat (`README.md#L9`).
- **Provider-term risk:** T3 relies on unofficial subscription OAuth for some providers (Antigravity
  sign-in, Cursor/Grok CLIs). Ferry already documents this risk for its own OAuth lanes
  (`README.md#L33`); do not copy setups that increase account-suspension exposure.
- **Compatibility debt is real.** T3 carries multi-generation wire compatibility (`ModelSelection`
  decode transform, optional fields everywhere, legacy PR flags; `orchestration.ts#L60-L126`,
  `overview.md#L21-L38`, `#L98-L108`). Ferry should design its RPC contract with explicit versioning
  from the start instead of retrofitting transforms.
- **Don't ship stale UI state.** T3 treats "the Working indicator never persists as stale UI"
  (`orchestration.ts#L929-L934`) and "a late checkpoint must not keep the client showing provider
  work as active" (`overview.md#L72-L77`) as invariants. Ferry's mock `SessionStatus` should adopt
  the same rule before real streaming lands.
- **Attribution obligation:** add T3 Code (MIT, T3 Tools Inc.) to Ferry's `NOTICE` for any adapted
  code, and never copy brand assets.

---

### Files read for this report (primary evidence)

Ferry: `README.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/ROUTING.md`, `docs/DELEGATION.md`,
`docs/GATEWAY.md`, `docs/STATUS.md`, `design/archive/DESIGN-v1.md`, `LICENSE`, `package.json`,
`packages/shared/src/domain/{session,provider,quota}.ts`, `packages/agent/src/loop.ts`,
`packages/delegate/src/index.ts`, `packages/workspace/src/git.ts`,
`apps/desktop/src/renderer/app/{Canvas,Sidebar}.tsx`, `packages/ui/src/components/chat/index.tsx`.

T3 Code (at `d2c9281`): `README.md`, `AGENTS.md`, `LICENSE`, `package.json`, `pnpm-workspace.yaml`,
`docs/internals/{overview,glossary,providers,model-manifest,connection-runtime,terminal-runtime,composer-editors}.md`,
`docs/user/{keybindings,permission-modes,thread-sidebar,source-control}.md`,
`packages/contracts/src/{orchestration,rpc}.ts`,
`apps/server/src/{config.ts,ws.ts,http.ts,provider/{ProviderDriver,builtInDrivers,model-manifest.json,acp/AcpSessionRuntime.ts}},{orchestration/{decider,projector}.ts,checkpointing/CheckpointStore.ts,git/GitWorkflowService.ts,persistence/**}`,
`packages/effect-acp/src/agent.ts`,
`apps/web/src/{keybindings.ts,index.css,components/{ChatView,Sidebar,DiffPanel,CommandPalette,ThreadTerminalDrawer}.tsx,components/chat/{MessagesTimeline,TraitsPicker,ProviderModelPicker,ProposedPlanCard,ChatHeader}.tsx,components/diffs/{StyledDiffCodeView,AnnotatableCodeView}.tsx,components/DiffWorkerPoolProvider.tsx}`.
