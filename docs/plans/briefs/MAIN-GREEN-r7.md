# MAIN-GREEN round 7: local control channel tests red (no commit)

Round 6 is accepted (production randomness restored). Orchestrator gates on rounds 4-6: e2e **5/5 pass**, check-text and prettier pass, `check:tasks` 61/63. Failing:
- `@ferry/core` `test/local-control.test.ts > writes a private endpoint descriptor, rejects unauthenticated RPC, and rotates it on restart`
- `@ferry/cli` `test/bundle.test.ts > runs the local providers list command from the bundled ESM entry`
- `@ferry/cli` `test/client.test.ts > starts the local RPC core and keeps settings between client lifecycles`; `> uses one desktop-style core for CLI status, Gateway, and a streamed session run`
- `@ferry/cli` `test/qa-cli.test.ts > exits after the terminal status from the bundled CLI and embedded core`; `> refuses a first paid call in non-interactive mode without --yes-paid`; `> reports local as the default engine and fails clearly when no provider is configured`

Everything else in these suites passed before round 4, so this is the channel work (client selection, endpoint lifecycle, the bundled CLI picking up the channel code, Windows named-pipe and DACL behaviour, process exit while a pipe server or socket is still open). Log: `.dev/runs/mg6-check.log` (Windows, this machine). Find the root causes, map each failing test to its fix, and don't weaken tests. Pay special attention to the CLI still exiting promptly (no open pipe handles keeping the event loop alive, which is the same "unsettled top-level await" class of bug we fixed earlier). Typecheck, lint and prettier; no commit.
