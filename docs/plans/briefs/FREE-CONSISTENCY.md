# One definition of "free" across catalog, picker, router and paid guardrails (no commit)

Worktree `C:\dev\ferry-free`, branch `fix/free-consistency` from `main` (`24b4851`). Read `AGENTS.md`, `docs/PROVIDERS.md`, `packages/catalog`, `packages/router/src/index.ts` (around `isFreeForRouting` / `providerAllowed`, ~lines 730-750) and the paid-guardrail code in `packages/core` first. Non-ASCII as JS escapes. Sandbox can't spawn vitest; typecheck, lint and prettier; tests for the orchestrator.

Problem found by QA: the catalog marks some OpenRouter models `free: true` (e.g. `openrouter/stealth/space-bunny-alpha`), but the router only treats OpenRouter refs matching `/:free(?:$|:)/i` as free. So for the Auto-Free profile the model picker (and anything else reading the catalog flag) can show a model as free that routing will never use, and the opposite mismatch may exist elsewhere. The user sees "free" and gets "All free candidates exhausted".

Required:
1. **Single source of truth:** one exported function (in `@ferry/shared` or `@ferry/catalog`) decides whether a model is free for a given provider and plan, using catalog data (flag, pricing, provider plan, OpenRouter `:free` variants, promotional or time-limited free models). The router, model picker/Models page, onboarding, paid guardrails (confirmation, caps), the gateway `/v1/models` listing and spend estimates all call it. Remove the duplicated heuristics.
2. **Decide the OpenRouter rule from evidence:** OpenRouter bills `:free` variants at $0 with free-tier rate limits; some non-suffixed models (stealth/promotional) are also $0 for a limited time. Use the catalog's pricing data plus the flag, and document the rule in `docs/PROVIDERS.md`. If a non-suffixed model is $0 now, it's free for routing **only** if its catalog pricing is 0 for both input and output, and the paid guardrails must still treat any unknown or non-zero price as billable (never weaken guardrails).
3. **Catalog check:** extend `catalog:check` to fail when a model's `free` flag contradicts its pricing or the rule, and fix any catalog entries it flags.
4. **Audit every provider**, not just OpenRouter, for the same flag-vs-router mismatch, and list what you found.
5. Tests: the shared function (table-driven per provider), the picker and router agreeing for the same catalog entries, the guardrails still requiring confirmation for priced/unknown models, and a regression for `stealth/space-bunny-alpha`-style entries.

Report the rule as implemented, every call site switched, and the catalog fixes.
