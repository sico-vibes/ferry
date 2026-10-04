# Lane U round 8: pino worker transport in the packaged CLI (no commit)

Progress: past `__dirname`. Now:
```
resources/cli/ferry.cmd status
ferry: unable to determine transport target for "pino-roll"
```
Pino's transports run in a worker thread that resolves `pino-roll` by module name. That doesn't work from the bundled CLI in the packaged layout. Don't fight module resolution for a worker. A short-lived CLI shouldn't spawn a logging worker at all:
- For the CLI (and anywhere the core runs inside the CLI process), log through a **synchronous or in-process destination** (`pino.destination` / sonic-boom to the same log file the core uses today), with rotation done in-process: rotate by size or date at start-up, keep N files, the same retention as now. No `pino.transport()` in the CLI path.
- The desktop app may keep its current transport if it works there (Electron main/utilityProcess resolve it fine today), but prefer one code path if it's simpler and equally correct. Note that the earlier unsettled-await fix in logger shutdown must still hold (the CLI must exit promptly).
- Extend the plain-Node bundle regression test from round 7 so it would have caught this: run the bundle **from a copy outside the monorepo** (a temp dir containing only the files the packaged `resources/cli` has), so resolution can't fall back to the workspace `node_modules`.
Typecheck, lint and prettier; no commit.
