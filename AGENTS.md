# AGENTS.md — rules for every implementer and QA agent working on Ferry

Ferry is a desktop (Electron + React) and CLI coding agent that routes work across free and paid LLM providers. **Current stage: Part A — UI-first shippable mock.** The UI runs entirely on `MockFerryClient`; there is no engine yet. Architecture: `docs/ARCHITECTURE.md`. Design spec: `design/DESIGN.md` (authoritative for all UI work).

## Hard rules
1. **Never run `git commit`, `git push`, or change git config.** The orchestrator reviews and commits.
2. Stay inside the scope of your brief. If correct completion needs going beyond it, stop and say so in your report.
3. Do not edit `AGENTS.md`, `CLAUDE.md`, `design/DESIGN.md`, `design/reference/**`, or `.delegate/**` unless the brief says so.
4. No network calls in tests. No secrets anywhere in the repo.
5. QA agents: add or extend **tests only**; never modify `src/` files. Report bugs, don't fix them.
6. **Dependencies:** your sandbox has no network and no global `pnpm`. **Never run `pnpm install`.** The orchestrator installs every dependency your brief lists before you start. If you need a package the brief didn't list, stop and name it (with the reason) in your report — do not work around it.

## Gates (run all before reporting)
```
.\tools\pnpm.cmd check        # = typecheck + lint + test across the workspace (repo-local pnpm; works in the sandbox)
```
Single package: `.\tools\pnpm.cmd --filter @ferry/<pkg> test`.
UI tasks additionally: `.\tools\pnpm.cmd shot <screen>` when the brief asks for screenshots.

## Code conventions
- TypeScript strict, ESM only, `noUncheckedIndexedAccess`. No `any` in exported APIs.
- Package boundaries: import other workspace packages only through their public entry (`@ferry/<pkg>`), never deep paths.
- UI: **all colors, radii, shadows and spacing come from design tokens** (`packages/ui/src/styles/tokens.css` / Tailwind theme). No raw hex/rgb literals in components (lint-enforced).
- UI: icons from `lucide-react` (stroke 1.75); brand marks from `simple-icons`. Follow `design/DESIGN.md` numbers exactly; open the reference crops named in your brief with your image viewer.
- Pure logic separated from IO; pure functions get unit tests.
- Windows is the primary platform: use `node:path`, never string-concatenate paths; preserve existing line endings.
- Prefer small files with one responsibility; name things for what they do.

## Report contract (end of every run)
- Summary of what you did.
- Files created/modified.
- Decisions you made that the brief did not specify.
- Deviations from the brief and why.
- Full gate output (last lines of `pnpm check`).
