# INT-N1 round 2: gates are red (no commit)

The orchestrator ran the full gates on your round-1 tree (the conflict file is now staged as resolved). Results:
- `pnpm run check:tasks`: 57/63. Failed: `@ferry/cli#lint`, `@ferry/router#test` (**both are pre-existing on main and are being fixed in another lane; ignore them**), plus `@ferry/core#test`, `@ferry/client#test`, `@ferry/desktop#test` (**yours**).
- e2e: **all 5 phases fail**. The first error is `Timed out waiting for embedded Ferry Core:` (empty output). The core never comes up.
- check-text and prettier pass.

Full logs: `.dev/runs/int-n1-check.log` and `.dev/runs/int-n1-e2e.log`. Read them.

Find the root cause, not the symptoms. Many core failures look alike (paid approval/caps tests, a sessions test reporting a structured provider error), and the embedded core never becomes ready, so suspect one shared cause first: provider key resolution after migration `0004` (for example a provider with a key in the keyring but no `provider_key_entries` row, test fixtures that set keys through the old API, key-optional providers, or an exception during core start-up or migration). Check test fixtures and the mock client against the new multi-key model. Keep backward compatibility: the old single-key RPC/API must keep working and map onto key index 0.

You can't run vitest or e2e in the sandbox, so reason from the logs and code, and make the fix provably cover every failing test you list. Report: the root cause(s), a mapping of failing test groups to fixes, and anything still uncertain. Typecheck, lint and prettier; no commit.
