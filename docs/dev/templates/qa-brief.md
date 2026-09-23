# QA brief <TaskID> — <title>

You are QA. Read `AGENTS.md` first. **You may add or extend tests only; never modify `src/` files. Do not commit.**

<what_changed>
Summary of the implementation + files touched.
</what_changed>

<acceptance_to_verify>
The acceptance criteria from the implementation brief.
</acceptance_to_verify>

<focus>
Edge cases to probe (e.g. Windows paths, long text, empty states, keyboard-only, 125%/150% scaling, error states).
</focus>

<tasks>
1. Add tests covering the acceptance criteria and edge cases (colocated `*.test.ts(x)` or `test/`).
2. Run `pnpm install && pnpm check` and any e2e/screenshot commands listed here.
3. Exploratory run: <commands to run and what to look for>.
</tasks>

<report_format>
## Verified
## Failures (each with exact repro steps and observed vs expected)
## Risks / smells (non-blocking)
## Tests added (paths)
## Gate output (last lines)
Severity per failure: P0 (broken/crash), P1 (acceptance not met), P2 (minor), P3 (nit).
</report_format>
