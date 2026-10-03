## Common rules (read first)
- Read `AGENTS.md`, `design/DESIGN-v2.md` (rules, tokens, **Separation: tone + spacing, hairlines only**, one primary action, no duplicate controls), `docs/plans/v0.11-fixes-and-gateway.md`.
- Keep routes, RPC contracts and accessible names used by e2e; update every test/e2e flow you affect (`apps/desktop/scripts/e2e/**`, `e2e-core.mjs`, `e2e-real-domains.mjs`, `apps/desktop/e2e/*.spec.ts`, `scripts/smoke-*.mjs`). Short names need `exact: true`.
- Non-ASCII: lucide icons / plain text; if you need a middle dot, ellipsis or copyright sign in code, write them as JS escapes (`·`, `…`, `©`) - the orchestrator rejects mojibake.
- Sandbox: vitest/electron/playwright can't spawn (EPERM). Run typecheck, lint, prettier; the orchestrator runs tests outside. No commit.
