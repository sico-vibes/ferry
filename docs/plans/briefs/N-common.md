## Common rules for Wave N lanes (read first)
- Read `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/GATEWAY.md`, `docs/PROVIDERS.md`, `docs/plans/v0.11-fixes-and-gateway.md` and **`docs/research/newapi.md`** (the idea source, with New API file references).
- **License rule (hard):** New API is AGPL-3.0 with extra attribution terms; Ferry is MIT. You may read their docs/behaviour descriptions in our research report, but **never copy, translate or closely paraphrase their source code**. Design and implement from Ferry's own architecture.
- Keep RPC contracts backward compatible (add fields/methods, don't break existing ones); new DB columns/tables via a new numbered migration that ships in all build targets (check how migrations are bundled for main/core/CLI).
- UI changes follow `design/DESIGN-v2.md` (tone + spacing separation, one primary action, no duplicate controls, v2 components only).
- Non-ASCII: write symbols as JS escapes; no mojibake.
- Sandbox: vitest/electron/playwright can't spawn (EPERM). Typecheck, lint, prettier; write unit tests for the orchestrator to run. No commit.
