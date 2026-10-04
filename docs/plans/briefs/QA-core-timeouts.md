# QA diagnosis: core and CLI test timeouts on `fix/main-green` (no code changes)

Repo `C:\dev\ferry-inst` (branch `fix/main-green`, uncommitted rounds 4-8 in the working tree: a local control channel (named pipe/socket plus token endpoint file) that every core now publishes on start). **Don't edit source or tests, and don't commit.** Diagnose and report only.

Symptom: in the full `check:tasks` run, about 45 tests in `@ferry/core` and `@ferry/cli` failed with `Test timed out in 30000ms` / `RPC request timed out: sessions.send` (log: `.dev/runs/mg8-check.log`). One round earlier only 7 failed, and before the channel existed these suites were green. E2E passes. The machine was busy during that run, so it may be load, or it may be a real hang (for example core shutdown waiting for the pipe server or socket to close, or a client connection holding the loop open).

Do:
1. With nothing else heavy running, run `./tools/pnpm.cmd --filter @ferry/core exec vitest run test/host.test.ts test/paid-guardrails.test.ts` and `./tools/pnpm.cmd --filter @ferry/cli exec vitest run test/qa-cli.test.ts`. Record pass/fail and durations.
2. If they fail or are slow, locate where time goes: run one failing test with `--reporter=verbose`, and add temporary `console.time` logs or `NODE_DEBUG=net` **in a scratch copy or reverted afterwards** to see whether core start or stop blocks on endpoint publication, pipe `server.close()`, the `whoami` leftovers, or file ACL calls. Revert any temporary edits (`git diff` must equal the state you found).
3. Compare with `git stash`-free evidence: the time to start and stop a core via `createCoreHost` with the channel enabled vs disabled (if there's an option or env to disable it; otherwise note that).

Report: whether it's load or a real hang, the exact blocking call (file:line), and per-test durations.
