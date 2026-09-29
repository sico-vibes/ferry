# Performance and accessibility budget

Scope: original B10 + A5.4 baseline. This document records the UI-first Ferry mock and local workspace tools; it does not include the later v0.10 performance wave.

## Budgets

| Area | Target | Measurement |
|---|---:|---|
| Packaged startup, warm | < 2,000 ms to an interactive composer | `pnpm --filter @ferry/desktop perf:start`; performs one warm-up launch, then reports the second launch's JSON `warmInteractiveMs`. |
| Long transcript | 10,000 messages; virtualized scroll and append; no long task > 100 ms | `pnpm --filter @ferry/desktop perf:long`; records append latency, p95 frame time, long tasks, rendered row count, and JS heap delta. |
| Large repo | 50,000 files; repo map, glob, grep, list_dir, checkpoint snapshot | `pnpm --filter @ferry/desktop perf:workspace`; creates fixtures and checkpoint data under the OS temp directory, records per-operation latency and process memory, then removes both directories. No per-operation time limit was specified in B10; use the first successful run as the baseline for a later budget. |
| Accessibility | WCAG 2.1 A/AA axe scan on all requested screens; no serious/critical violations; body/meta text ≥ 4.5:1 | `pnpm --filter @ferry/desktop test:e2e` includes the accessibility and keyboard flows. Token contrast is also tested by `@ferry/ui`. |

Each `perf:start`, `perf:long`, and `perf:workspace` run prints one JSON summary line with a `benchmark` identifier. Workspace timings are in `operations[].elapsedMs`; `memoryBytes` uses Node's byte-valued `process.memoryUsage()` fields.

## Measurements in this checkout

| Check | Result | Status |
|---|---|---|
| Catalog vendored data | Snapshot date 2026-09-27; 2 days old on 2026-09-29; no configured provider keys were available, so live lists were skipped. | Pass; vendored datasets are fresh, and live model comparison was skipped because no keys were configured. |
| Packaged warm startup | Not measured: sandbox prevented child process launch (`spawn EPERM`). | Blocked here; `perf:start` now launches the packaged app twice and fails when the warm TTI is ≥ 2,000 ms. |
| 10k transcript scroll + append | Not measured: sandbox prevented the TS loader's esbuild child process (`spawn EPERM`). | Blocked here; script is ready to run outside the sandbox. |
| 50k-file workspace operations | Not measured: sandbox prevented the TS loader's esbuild child process (`spawn EPERM`), before fixture creation. | Blocked here; no fixture was left behind. |
| Axe and keyboard e2e | Not measured: the Playwright runner requires child processes, which this sandbox rejects with `spawn EPERM`. | Blocked here; run `pnpm --filter @ferry/desktop test:e2e` outside the sandbox. |

Token contrast is tested against all nine solid surface tokens used for text: app, rail tile, active rail tile, panel, canvas, card, raised, input, and dark pill. With the current token values, the minimum is 4.51:1 in dark mode (`--bg-rail-tile-active`) and 4.50:1 in light mode (`--bg-rail-tile-active`). The UI contrast test checks every listed surface in both themes. The dark `--text-3` is `#9C9EA7`, the darkest tested value that passes AA and remains dimmer than secondary; light `--text-3` is `#5D697D`, lighter than secondary while meeting AA on all listed surfaces.

Gate results in this sandbox:

- `pnpm check`: failed because the Catalog and Workspace Vitest configs invoke Vite, which failed to spawn `realpath` (`spawn EPERM`). Catalog, Workspace, and UI TypeScript checks completed successfully; full Prettier check completed successfully. `scripts/check-text.mjs` could not launch its `git ls-files` child process (`spawn EPERM`).
- `pnpm --filter @ferry/desktop test:e2e`: all three phases were attempted; the Vite build config, fixture `git init`, and Electron launch failed with `spawn EPERM` before axe or keyboard audit could run.
- `perf:start`, `perf:long`, `perf:workspace`, and `smoke:packaged`: attempted; required Vite, TS loader/esbuild, or packaged child processes failed with `spawn EPERM`.
- `pnpm catalog:check`: passed, with zero configured provider keys and all vendored datasets fresh.

These are execution-environment failures, not passing performance or accessibility results. Run the commands above on Windows with process spawning enabled before accepting the numeric budgets.

## Changes and follow-ups

- Capped the process-wide repo-map parse cache at 5,000 entries so opening many workspaces cannot retain every parsed source file indefinitely. Repo-map newest-file calculation no longer spreads a potentially large array into `Math.max`; glob now sorts the filtered results once.
- The long-transcript probe now appends through the composer and captures browser long tasks alongside scroll frame samples.
- The packaged smoke enforces the 2,000 ms startup budget.
- The e2e accessibility flow audits Home, Session, Explore, Usage, Library, Onboarding, Review, overlays, and all Settings sections (including Providers & Keys/OAuth and Gateway). The keyboard flow also checks dialog focus containment and Escape dismissal.
- The current repo-map implementation still stats every candidate and parses supported files sequentially. Consider a bounded worker pool and a persistent incremental file index if the 50k baseline is too slow. Keep parsing and Git access asynchronous; no sync file calls were found in the inspected workspace tool paths.
- Transcript message history remains intentionally available for session navigation; virtualization bounds rendered DOM rows. If the 10k append/scroll measurement misses budget, profile query-cache retention and per-message rendering before changing history semantics.
- The storage schema has a timestamp index for usage retention and timestamp-ordered request listing. No missing index was evidenced for a hot query in this pass; add indexes alongside a measured query plan if a new filter is introduced.
