# CLI parity round 2 (no commit)

Good surface overall. Two gaps against the brief's rule ("no new behaviour in the CLI itself; new RPC only if a capability is missing"):
1. **Effective overrides are computed in the CLI** by importing `@ferry/providers`. When the CLI talks to the desktop core over the local control channel, the CLI's local computation can disagree with what the core actually applies (different catalog/config state or version). Move it into the core: add a read-only RPC (e.g. `providers.effectiveOverrides(id)`, registered in `FERRY_METHODS` with a schema, plus the mock client) that returns exactly what the core applies, and have the CLI call it. Remove the `@ferry/providers` dependency from `apps/cli/package.json`.
2. **Affinity:** the desktop sets it per profile (soft/strict). Expose that where it lives: `ferry profiles affinity <profile> [soft|strict]` (show when no value), through the same RPC the desktop uses. Mention it in `docs/CLI.md` and in `providers routing --help` ("affinity is per profile, see `ferry profiles affinity`").

Tests for the new RPC (core and mock) and both CLI commands. Typecheck, lint and prettier (the orchestrator will run `pnpm install` before gating if deps change); no commit.
