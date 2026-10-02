# Ferry UI remake plan (v2)

Status: **planned, starts after the in-flight v0.10 lanes are integrated** (WP-A, WP-B, WP-C, W1-A, W1-B, U5).
Spec: `design/DESIGN-v2.md` (authoritative). Decisions: Ferry violet accent, on-demand drawer, Geist,
dark + light together. Library: **shadcn/ui** (Radix + Tailwind v4, MIT) — Ferry already uses Radix,
Tailwind v4, cmdk, lucide and sonner, so this is an evolution of the stack, not a new one.

Goal: rebuild every screen of the desktop app (same routes, same core/client contracts, same
accessible names where possible so the e2e suite carries over) in the simple, minimal style of the
reference, with no duplicate controls, one primary action per view, and strict spacing/alignment.

## Phases and lanes

| Phase | Lanes | Scope | Exit |
|---|---|---|---|
| **UI-0 Foundation** | 1 | Tokens (both themes) per DESIGN-v2 §2; Geist + Geist Mono self-hosted; shadcn/ui base components generated into `@ferry/ui` and themed; theme switching (system / dark / light, remembered); Ladle gallery shows every base component in both themes; contrast test over all surfaces in both themes; lint rule still forbids raw colours outside tokens | Gallery screenshots both themes; check + e2e green |
| **UI-1 Shell + Home + Session** | 1 | AppSidebar (collapsible, chats list, capacity card, user menu), ChatHeader, Composer (attach, profile/model picker, workspace picker, send/stop), Home empty state + quick-start chips, Session transcript restyle including the U5 AgentTimeline, approval/handoff/delegation cards, drawer shell (Plan / Changes / Terminal) | **Checkpoint C-UI: user reviews screenshots (both themes, 1440 and 1024) before UI-2 starts** |
| **UI-2 Screens** (parallel after C-UI) | 4 | (a) Library + project detail; (b) Models: Providers / Models (paged) / Usage; (c) Settings (all sections incl. OAuth list, Gateway, Shortcuts) + Onboarding; (d) Review page + DiffView + Terminal + Plan/Changes drawer content, command palette, toasts, empty/error/offline/interrupted/paid states | Per-lane screenshots both themes; check + e2e green |
| **UI-3 QA + polish** | OpenCode QA + 1 fix lane | Screenshot sweep of every screen × both themes × 1440/1280/1024 × 125 %; axe; symmetry/duplicate-control audit against DESIGN-v2 §6; e2e selector updates; perf (bundle size, startup, long transcript) vs `docs/PERFORMANCE.md` budgets | Audit clean; beta published |

Each lane: works in its own worktree from the integrated main, keeps routes and client contracts,
adds/updates screenshots in `design/screenshots/v2/`, and must pass full `check` + desktop
`test:e2e` (run by the orchestrator outside the sandbox). Old components are deleted only after no
screen uses them; `design/DESIGN.md` has been archived as `design/archive/DESIGN-v1.md`.

## Duplicate-control audit (today → v2 home)

| Action | Today | v2 |
|---|---|---|
| New chat | sidebar button, right-panel button, tabs "+", rail pencil | sidebar only (+ palette, Ctrl N) |
| Settings | rail gear, sidebar row, avatar menu | user menu only (+ palette, Ctrl ,) |
| Search chats | right-panel search, sidebar search icon | palette only (sidebar shows a "Search  Ctrl K" row that opens it) |
| Model / profile | canvas header picker, composer chip, configuration sheet | composer chip only |
| Add provider | capacity card link, Explore header, onboarding | capacity card on most screens; Models page header is the primary there (card hidden on Models) |
| Share | canvas header, right-panel share | chat header only |

## Order of work

1. Integrate the in-flight v0.10 lanes into main and publish a beta (current task).
2. Document the backend state (`docs/STATUS.md`, `docs/plans/v0.10-upgrade.md` status column).
3. UI-0 → UI-1 → **C-UI checkpoint with the user** → UI-2 (4 lanes) → UI-3.
4. Resume the remaining v0.10 backend items (see `docs/plans/v0.10-upgrade.md`) after the remake.
