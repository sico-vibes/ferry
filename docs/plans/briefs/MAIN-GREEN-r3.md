# MAIN-GREEN round 3: gates red (no commit)

Orchestrator gates on your round-2 tree:
- `pnpm run check:tasks`: 60/63. Failed: `@ferry/cli#test`, `@ferry/core#test`, `@ferry/delegate#test`.
- e2e: web UI flows, core flows, paid guardrails and Electron smoke **pass**; **real domains: crash resume FAILS**.
- check-text and prettier pass.

`main` was 63/63 locally with all e2e phases green before this lane, so treat every failure as a regression from your changes (data-directory resolution/migration, `FERRY_DATA_DIR` now honored by the desktop core, lock handling, logger shutdown, ACP drain), unless the log proves otherwise. Crash resume restarts the core on the same data dir after a kill: suspect stale `core.lock` handling or the new data-dir resolution in the test harness. For delegate, check whether the bounded drain window broke existing ACP tests (timeouts, or a run that now never finishes).

Logs: `.dev/runs/mg-check.log`, `.dev/runs/mg-e2e.log`. Read them, fix the root causes, and map each failing test to its fix. Don't weaken tests. Typecheck, lint and prettier; no commit.
