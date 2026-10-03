# INT-N1 round 3: closer, still red (no commit)

Good root cause in round 2: the core starts again. Orchestrator gates now:
- `check:tasks`: 58/63. Failed: `@ferry/cli#lint`, `@ferry/router#test` (pre-existing on main, fixed in another lane; ignore). `@ferry/cli#test` partly pre-existing (unsettled top-level await from logger shutdown, fixed in the other lane; ignore only that signature). **Yours:** `@ferry/core#test`, `@ferry/desktop#test`, and any `@ferry/cli#test` failure with a different signature.
- e2e: core flows, crash resume and paid guardrails **pass**. **web UI flows FAIL, Electron core smoke FAILS** (the Electron smoke previously drove the `Manage OpenAI API key` dialog; check its steps against the merged dialog).

Logs: `.dev/runs/int-n1b-check.log`, `.dev/runs/int-n1b-e2e.log`. Fix the root causes; map each failing test to its fix. Where an e2e step's selector must change because the dialog legitimately changed, update the step to the new accessible names (don't loosen assertions). UI must still follow `design/DESIGN-v2.md`. Typecheck, lint and prettier; no commit.
