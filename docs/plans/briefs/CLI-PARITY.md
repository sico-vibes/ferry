# CLI parity with the v0.11 settings (no commit)

Worktree `C:\dev\ferry`, branch `feat/cli-parity` from `main` (`24b4851`, beta.36). Read `AGENTS.md`, `docs/GATEWAY.md`, `docs/PROVIDERS.md`, `apps/cli/src/main.tsx` and the existing CLI tests first. Non-ASCII as JS escapes, no mojibake. Sandbox: vitest/esbuild can't spawn. Typecheck, lint and prettier; write tests for the orchestrator to run. You may add `workspace:*` deps; the orchestrator installs.

Goal: everything v0.11 added to the desktop app can be done from the CLI, through the same RPC methods (in-process or over the local control channel; no new behaviour in the CLI itself, and new RPC only if a capability is missing, then also registered in `FERRY_METHODS`).

Commands (adapt names to existing conventions; keep the `--json` output on every command):
1. **Gateway keys (N5):** `ferry gateway keys create <name> [profile] [--rpm N] [--concurrency N] [--tokens-per-min N] [--tokens-per-day N]`; `ferry gateway keys update <id> [same flags | --clear <limit>]`; `ferry gateway keys show <id>` (limits plus current usage). The secret is still shown once on create.
2. **Provider keys (N1):** `ferry providers keys <provider> list|add|remove|enable|disable|move`. `add` **never takes the secret as an argv value** (shell history leak): read it from a hidden interactive prompt, or from stdin with `--stdin`; `--label` optional. List shows label, last 4 chars, status, usage, never the secret. `remove` needs `--yes` when non-interactive.
3. **Routing knobs (N4):** `ferry providers routing <provider> [--priority N] [--weight N] [--affinity off|soft|strict]` (show when no flags).
4. **Model mapping and overrides (N3):** `ferry models map list|set|remove` for logical-name to per-provider upstream mappings and gateway aliases; `ferry providers overrides <provider>` shows effective param/header/status overrides (read-only unless the desktop allows editing them; match the desktop).
5. `ferry --help` and per-command help list the new commands with one-line descriptions; exit codes follow the existing convention (2 for usage errors).
6. Docs: update the CLI section in the relevant doc (find where CLI commands are documented; create `docs/CLI.md` if there's none, and link it from `README.md`).

Tests: argument parsing and usage errors; a round-trip for each command group against the in-process core (create a key with limits, then show/update; add 2 provider keys via stdin, move, disable, remove; set and show routing; set and list a mapping); a test that `providers keys add` refuses a positional secret and never prints the secret in human or JSON output. Report the command surface as built.
