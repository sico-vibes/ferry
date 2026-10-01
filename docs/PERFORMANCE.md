# Performance and accessibility budget

Scope: original B10 + A5.4 baseline and the v0.10 Wave P performance baseline. `pnpm perf` runs the startup, idle CPU/RSS, 10k transcript, 50k workspace, renderer chunk, DB query, and React Profiler measurements, then updates this document and `docs/perf-results.json`.

## Budgets

| Area | Target | Measurement |
|---|---:|---|
| Packaged startup, warm | < 2,000 ms to an interactive composer | `pnpm --filter @ferry/desktop perf:start`; performs one warm-up launch, then reports the second launch's JSON `warmInteractiveMs`. |
| Long transcript | 10,000 messages; virtualized scroll and append; append < 100 ms and no long task > 100 ms | `pnpm --filter @ferry/desktop perf:long`; records append latency, p95 frame time, long tasks, rendered row count, and JS heap delta. |
| Large repo | 50,000 files; repo map, glob, grep < 5,000 ms, list_dir, checkpoint snapshot | `pnpm --filter @ferry/desktop perf:workspace`; creates fixtures and checkpoint data under the OS temp directory, records per-operation latency and process memory, then removes both directories. |
| Idle process footprint | 60 s CPU average and RSS for Electron main, renderer, and core after startup and after opening a session | `pnpm perf`; uses Electron process metrics sampled once per second. |
| Renderer chunks and screen commits | JavaScript bytes per manifest chunk; React Profiler commit counts for Home, Session, Explore, and Settings | `pnpm perf`; chunk sizes come from the renderer build manifest and counts run in a dev-only harness. |
| DB query sample | `sessions.list` elapsed time after opening a benchmark session | `pnpm perf`; includes the local core RPC round trip and storage read. |
| Accessibility | WCAG 2.1 A/AA axe scan on all requested screens; no serious/critical violations; body/meta text ≥ 4.5:1 | `pnpm --filter @ferry/desktop test:e2e` includes the accessibility and keyboard flows. Token contrast is also tested by `@ferry/ui`. |

Each `perf:start`, `perf:long`, and `perf:workspace` run prints one JSON summary line with a `benchmark` identifier. Workspace timings are in `operations[].elapsedMs`; `memoryBytes` uses Node's byte-valued `process.memoryUsage()` fields.

## Benchmark runs

The 2026-09-30 baseline ran on the user's Windows laptop while under load, with Microsoft Defender real-time scanning enabled. It is an environmental baseline, not an idle-machine comparison. The raw output is `.dev/perf-run-1.txt`.

| Metric | Target | Before fix (2026-09-30) | Run 2 (2026-09-30) | Run 3 (2026-09-30) | Current changes |
|---|---:|---:|---:|---:|---:|
| Packaged warm startup TTI | < 2,000 ms | Readiness locator timed out after 30,000 ms; no TTI captured. | Timed out again; no TTI captured. | Warm-up showed Settings; no TTI captured. | Probe now verifies the packaged host/engine handshake, navigates to Home, then waits for the composer. Pending outside-sandbox rerun. |
| Transcript rendered rows | ≤ 40 | 8 | 8 | 8 | Pending outside-sandbox rerun. |
| Transcript append | < 100 ms | 1,154 ms | 248.5 ms | 183.5 ms | Pending; stable virtualizer callbacks and event-driven Changes data avoid repeated 10k-row work. |
| Transcript average / p95 frame | p95 ≤ 33.3 ms | 23.11 / 30.3 ms; 7 frames exceeded 33.3 ms | 17.33 / 19.4 ms; 4 frames exceeded 33.3 ms | 17.12 / 19.7 ms; 4 frames exceeded 33.3 ms | Pending outside-sandbox rerun. |
| Transcript long tasks | 0 over 100 ms | 6; longest 863 ms | 4; longest 128 ms | 4; longest 138 ms | Pending; the probe records long-task timing and browser attribution for profiling. |
| Transcript JS heap | report usage and delta | 26,000,000 bytes before and after; delta 0 | 26,000,000 bytes before and after; delta 0 | 26,000,000 bytes before and after; delta 0 | Pending outside-sandbox rerun. |
| 50k fixture generation | report time | 20,915.9 ms | Not present in captured run2 output. | Not present in captured run3 output. | Pending; script emits each result as soon as it completes. |
| Repo map | report time | 1,337.9 ms (100 files) | Not present in captured run2 output. | 6,281.3 ms (100 files) | Pending outside-sandbox rerun. |
| Glob | report time | 1,525.4 ms (5,000 results) | 1,170.9 ms (5,000 results) | 3,638.7 ms (5,000 results) | Pending outside-sandbox rerun. |
| Grep via Ferry | < 5,000 ms | 58,248.1 ms (1 match) | 74,075.1 ms (1 match) | 75,675.1 ms (1 match) | Probe logs the vendored ripgrep binary and exact args and separately times ripgrep alone. |
| ripgrep alone | diagnostic | Not measured | Not measured | Probe crashed before timing: `stdout` was null and `.resume()` threw. | Fixed to use piped stdout/stderr; timing pending outside-sandbox rerun. |
| list_dir | report time | 4,684.2 ms (50,100 entries) | 13,238.2 ms (50,100 entries) | Not run; probe stopped at ripgrep error. | Removed one sequential `stat` per entry by checking ignore patterns against `Dirent` type and relative path. |
| Checkpoint snapshot | report time | Not recoverable: captured output ended at `checkpointSnapshot`. | 157,592.5 ms | Not run; probe stopped at ripgrep error. | Pending outside-sandbox rerun. |
| Workspace process memory | report memory | Not recoverable: captured output ended before memory. | Not present in captured run2 output. | Not present in captured run3 output. | Script includes the complete `process.memoryUsage()` object in its final JSON summary. |

The run2 capture `.dev/perf-run-2.txt` did not include repo-map, fixture-generation, or memory values. The run3 capture `.dev/perf-run-3.txt` did not reach list_dir, checkpoint, or memory because the ripgrep-only probe threw before those steps. The fixed workspace probe emits each operation as it completes, followed by the complete JSON summary. The machine was the user's Windows laptop under load with Microsoft Defender real-time scanning enabled, so file-heavy timings include that environmental cost.

## Earlier measurements in this checkout

| Check | Result | Status |
|---|---|---|
| Catalog vendored data | Snapshot date 2026-09-27; 2 days old on 2026-09-29; no configured provider keys were available, so live lists were skipped. | Pass; vendored datasets are fresh, and live model comparison was skipped because no keys were configured. |
| Packaged warm startup | The earlier in-sandbox attempt was blocked by child process launch (`spawn EPERM`). | Superseded by the outside-sandbox 2026-09-30 baseline above. |
| 10k transcript scroll + append | The earlier in-sandbox attempt was blocked by the TS loader's esbuild child process (`spawn EPERM`). | Superseded by the outside-sandbox 2026-09-30 baseline above. |
| 50k-file workspace operations | The earlier in-sandbox attempt was blocked by the TS loader's esbuild child process (`spawn EPERM`), before fixture creation. | Superseded by the outside-sandbox 2026-09-30 baseline above. |
| Axe and keyboard e2e | The earlier in-sandbox attempt was blocked by child process launch (`spawn EPERM`). | Outside-sandbox rerun passed all three e2e flows, including axe (reported 2026-09-30). |

Token contrast is tested against all nine solid surface tokens used for text: app, rail tile, active rail tile, panel, canvas, card, raised, input, and dark pill. With the current token values, the minimum is 4.51:1 in dark mode (`--bg-rail-tile-active`) and 4.50:1 in light mode (`--bg-rail-tile-active`). The UI contrast test checks every listed surface in both themes. The dark `--text-3` is `#9C9EA7`, the darkest tested value that passes AA and remains dimmer than secondary; light `--text-3` is `#5D697D`, lighter than secondary while meeting AA on all listed surfaces.

Gate results in this sandbox:

- `pnpm check`: failed because the Catalog and Workspace Vitest configs invoke Vite, which failed to spawn `realpath` (`spawn EPERM`). Catalog, Workspace, and UI TypeScript checks completed successfully; full Prettier check completed successfully. `scripts/check-text.mjs` could not launch its `git ls-files` child process (`spawn EPERM`).
- `pnpm --filter @ferry/desktop test:e2e`: all three phases were attempted; the Vite build config, fixture `git init`, and Electron launch failed with `spawn EPERM` before axe or keyboard audit could run.
- `perf:start`, `perf:long`, `perf:workspace`, and `smoke:packaged`: attempted; required Vite, TS loader/esbuild, or packaged child processes failed with `spawn EPERM`.
- `pnpm catalog:check`: passed, with zero configured provider keys and all vendored datasets fresh.

The earlier in-sandbox failures above were execution-environment failures, not passing performance or accessibility results. The outside-sandbox axe result and performance baseline are recorded separately above; numeric after-fix results remain pending.

Follow-up gate attempt on 2026-09-30: desktop and workspace typechecks passed. Full `pnpm check` reached 47 successful tasks and failed at `@ferry/desktop#test` because esbuild could not spawn its service (`spawn EPERM`); the focused workspace test hit the same sandbox restriction in Vite's `realpath` helper.

## Changes and follow-ups

- Capped the process-wide repo-map parse cache at 5,000 entries so opening many workspaces cannot retain every parsed source file indefinitely. Repo-map newest-file calculation no longer spreads a potentially large array into `Math.max`; glob now sorts the filtered results once.
- Session cache events now patch session metadata, appended messages, and task records instead of refetching and cloning the full transcript. Appending no longer triggers a second full-session invalidation, and the transcript's latest assistant message lookup no longer copies/reverses all 10k messages.
- Successful and failed agent tool calls now emit their final `session.part` after storage replacement. Before this, core emitted only the initial `running` part; the file edit and task record persisted, but the renderer never received changed paths for its Changes cache.
- The long-transcript probe enforces append < 100 ms and no long task > 100 ms, and captures browser long tasks alongside scroll frame samples.
- The packaged smoke enforces the 2,000 ms startup budget.
- The e2e accessibility flow audits Home, Session, Explore, Usage, Library, Onboarding, Review, overlays, and all Settings sections (including Providers & Keys/OAuth and Gateway). The keyboard flow also checks dialog focus containment and Escape dismissal.
- The current repo-map implementation still stats every candidate and parses supported files sequentially. Consider a bounded worker pool and a persistent incremental file index if the 50k baseline is too slow. Keep parsing and Git access asynchronous; no sync file calls were found in the inspected workspace tool paths.
- Transcript message history remains intentionally available for session navigation; virtualization bounds rendered DOM rows. If the 10k append/scroll measurement misses budget, profile query-cache retention and per-message rendering before changing history semantics.
- Grep traversal and matching run in ripgrep with `.gitignore` and `.ferryignore` handling; Node reads only matched files when context lines are requested. The new benchmark compares Ferry grep with ripgrep alone on the same fixture. If ripgrep alone remains over five seconds under Defender, a persistent incremental content index is the larger follow-up rather than a Node-side scan.
- Checkpoint snapshot is Git's first complete `git add -A` plus tree and commit creation over all 50k fixture files. The measured 158-second run remains a redesign candidate if it persists when ripgrep-alone timings and the AV environment are separated.
- The packaged HTML title was hard-coded as `Ferry (demo)` for all builds. Packaged startup now requires the desktop host/engine/hybrid-client handshake, and a `file:` renderer without the preload bridge shows an engine error instead of silently mounting the mock client. The probe routes explicitly to Home and measures the composer there.
- The storage schema has a timestamp index for usage retention and timestamp-ordered request listing. No missing index was evidenced for a hot query in this pass; add indexes alongside a measured query plan if a new filter is introduced.
