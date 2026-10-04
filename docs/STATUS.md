# Ferry status

Last updated: 2026-10-04. Ferry is a Windows-first desktop + CLI coding agent: local core over JSON-RPC,
SQLite storage, free-first provider routing with quota tracking and handoffs, workspace tools with
checkpoints, measured token optimizers, delegation to Codex / OpenCode / Claude / ACP agents, a local
OpenAI/Anthropic-compatible Gateway, and subscription OAuth (opt-in). Public beta channel on GitHub
Releases (`v0.9.0-beta.N`, auto-published on every merge to `main`; installed apps auto-update).

## Where we are

1. **Original master plan: complete** (integrated on `main` 2026-09-30; milestones below).
2. **v0.10 upgrade waves: first batch on `main`** (`41eb69c`, beta `v0.9.0-beta.10`): P0/P2, P1, U1, U5, U2. P3/P6 parked (see below).
3. **UI remake v2: complete on `main`** (2026-10-02, `a649d0a`): UI-0 foundation, UI-1 shell/Home/Session/drawer (user-approved at checkpoint C-UI, with seamless tone-based separation), UI-2 Library/Models/Settings/Onboarding/Review/palette/states, UI-3 legacy cleanup + polish. Gates: check 63/63, e2e 5/5 phases, 20/20 web flows, screenshots `design/screenshots/v2/` (both themes, 1440 and 1024). Remaining v0.10 work is listed below.
4. **v0.11 (`docs/plans/v0.11-fixes-and-gateway.md`): complete.** Wave F, N1–N5, CLI parity with v0.11 settings, and shared free-model classification are integrated. `v0.9.0-beta.36` (`24b4851`) is the first green release since N3–N5; N1/N2 integration and the final main-green fixes are included. CLI parity (`e8c60ce`) and free consistency (`826d3a8`) landed after beta.36 on `feat/cli-parity`.

## Current state

| Area | State | Detail |
|---|---|---|
| v0.11 | Complete | Wave F and N1–N5 integrated; CLI parity and free-model consistency are on `main`. No v0.11 work remains. |
| WIP branches | None, except parked P3/P6 | `wave/p3-caching` is parked. Its migration must be renumbered when resumed: `0004` is now `provider_key_entries`, so P3/P6 must use `0005`. |

## Milestones (original plan)

| Milestone | Result | Evidence |
|---|---|---|
| M1 real free models finish tasks | ✅ 6/8 live evals on free tiers | `.dev/evals-archive`, `docs/OPTIMIZERS.md` |
| M2 cross-provider handoff in the UI | ✅ live handoff chain | `design/screenshots/app/m2-live-handoff.png` |
| M3 optimizer savings | ✅ 304,550 → 69,489 tokens on 23 realistic outputs (correctness-checked); live parity 6/8 vs 6/8 | `pnpm bench:optimizers`, `docs/OPTIMIZERS.md` |
| M4 real delegations | ✅ Codex rework/accept + reject/restore, OpenCode accept, Claude accept | `scripts/live-delegation.mjs` |
| M5 CLI | ✅ local engine default, `ferry status`, gateway commands | CLI tests |
| B6.6 paid guardrails | ✅ confirmation (incl. zero/unknown-price billable), caps gate every candidate incl. handoffs, hard stop, spend vs caps | `design/screenshots/app/paid-*.png` |
| B10 hardening | ✅ crash-resume + reconnect, DB salvage, offline mode, chaos; security review fixes (`docs/SECURITY-REVIEW.md`); perf budget + axe gate; catalog:check | e2e phases, `docs/PERFORMANCE.md` |
| B11 release | ✅ unsigned NSIS + portable, auto-update beta channel, CLI on PATH; clean-VM install smoke workflow green (install, hello, CLI status, upgrade keeps data, default/opt-in uninstall, PATH) after fixing 8.3 short-path handoff and silent `/ADD_TO_PATH` / `/REMOVE_DATA` flags | `.github/workflows/beta.yml`, `install-smoke.yml` |

Quality gates on `main`: `pnpm check` (63 tasks) + desktop e2e in 5 isolated phases (web UI flows;
real domains: core flows, crash resume, paid guardrails; Electron core smoke); GitHub CI on Windows +
Ubuntu.

## Remaining v0.10 work (docs/plans/v0.10-upgrade.md)

| Item | State | Branch / worktree |
|---|---|---|
| RP1 reasoning-exposure matrix | ✅ on main | `docs/research/reasoning-matrix.md` |
| P0 perf baseline + budgets, P2 no polling | ✅ on main | `wave/perf-a` |
| U1 structured agent events (migration 0003) | ✅ on main | `wave/u1-events` |
| U5 thinking + tool-call timeline (+ paged "show full output", `sessions.readOutput`) | ✅ on main | `wave/u5-timeline` |
| P1 pagination / Show more / virtualization (+ paid billing metadata for paged models) | ✅ on main | `wave/perf-b` |
| U2 command palette + keybindings | ✅ on main | `wave/u2-palette` |
| P3 caching + P6 storage/memory | ⏸ parked: check 63/63 green, but real-domains core flows failed (model picker option never "stable"); bisected to its `renderer/data/events.tsx` handlers. Picker changes were reverted and rebuilt in UI-1. On resume, rebase against the current picker and renumber its migration to `0005` (`0004` is `provider_key_entries`) | `wave/p3-caching` |
| P4 lighter startup/bundle, P5 render hygiene, P7 smaller install | Not started | — |
| U3 speed/honesty pass, U4 delegate safety (min versions, CODEX_HOME symlink) | Not started | — |
| U6 subscription-CLI models + traits picker, U7 plan cards + plan mode | Not started | — |
| Wave 3 (U8 worktree per thread, U9 per-turn checkpoints, U10 diff review, U11 git actions) | Not started | — |
| Wave 4 (U12 rich CLI transports, U13 terminals, U14 sidebar shelves, U15 reconnect contract) | Not started | — |

Integration rule: merge green lane branches on an integration branch in `C:\dev\ferry`, run all gates,
fast-forward `main` only when green; migrations are numbered uniquely (0003 agent events, 0004 provider key
entries) and must ship in all build targets.

## Known gaps

- Legacy palette tokens remain in a few components after the partial UI-3 cleanup.
- Packaged time-to-interactive remains above the 2 s target on cold CI runners (advisory warning; fails above 10 s).
- grep and checkpoint snapshots on a 50k-file repo are slow on this laptop with Defender real-time
  scanning (see `docs/PERFORMANCE.md`).
- Gemini is not signed in on the dev machine, so ACP Gemini delegation is untested live.
- P3/P6 caching and storage work remains parked on `wave/p3-caching`.
- Catalog prices, provider availability, and free-tier limits change outside Ferry's control. Free-tier coverage needs ongoing upkeep as providers change terms and model access.
- Code signing is deferred (the unsigned beta is a documented, accepted risk in `docs/SECURITY.md`).
