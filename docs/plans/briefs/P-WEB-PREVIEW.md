# Lane P: web preview with a fake backend + visual QA harness (no commit)

Worktree `C:\dev\ferry`, branch `feat/web-preview`. Read `AGENTS.md`, **`docs/plans/v0.12-ui-and-updates.md` (workstream P, product principles)**, `design/DESIGN-v2.md`, the references in `design/references/2026-10-04/`, `packages/client/src/mock` (existing mock client), `apps/desktop/scripts/e2e*.mjs` and `apps/desktop/scripts/shots-v2.mjs` (the existing web UI flows already run the renderer with the mock in a browser; build on that, don't fork it). Non-ASCII as JS escapes, no mojibake. Sandbox: vite/esbuild/playwright can't spawn; typecheck, lint and prettier; the orchestrator runs the browser checks. You may add `workspace:*` deps; for external packages, list them and stop only if truly needed.

Deliver:
1. **`pnpm preview:web`** (root script): serves the real renderer at a fixed port (e.g. 5199) with the mock client. Add a `.claude/launch.json` entry named `ferry-web-preview` for it.
2. **Rich fake data** (deterministic, seeded; no network, no keys), selectable by `?scenario=`:
   - `busy` (default): 8+ chats across 3 projects, with long transcripts including markdown, code blocks, thinking, tool calls, approvals (pending and resolved), handoffs and an error; a chat that **streams a new reply** when you send a message (fake tokens over time, with tool activity); providers in every state (healthy, cooling, invalid, missing key, disabled, paid, trial), 2+ keys on some; a realistic model catalog slice; profiles; usage history for 30 days; gateway on with 3 keys and a **live fake request stream** (new requests every few seconds); some delegation lanes.
   - `empty`: first run, no providers, no chats (onboarding).
   - `errors`: offline core, rate-limited providers, failed delegation.
   - Also `?theme=light|dark|system` and `?route=` to open a specific screen.
3. **Desktop chrome in the browser:** the preview renders a simulated Windows title bar and window-control area at the real size, so the shell's top strip can be reviewed. It must use the same layout code path as Electron (where the Electron window has a title-bar overlay), not a separate fake layout.
4. A small **dev-only overlay** (toggle with a keyboard shortcut, hidden by default and excluded from screenshots) to switch scenario, theme and size.
5. **`pnpm shots:review <area>`** (area = `shell|settings|models|home|gateway|all`): captures the states that matter for that area (light and dark, 1024x680 and 1440x900, hover and open states such as menus, tooltips and the picker hover card) into `.dev/review/<area>/`, plus a `REVIEW.md` listing each capture, the matching reference image path from `design/references/2026-10-04/`, and the product principles checklist. That file is the brief a visual reviewer will read. Keep the area-to-states map in one config file so later lanes extend it.
6. `docs/PREVIEW.md`: how to run, the scenarios, and how the visual review loop works.

Don't change product UI in this lane (that's lanes S/T/M/H/G); only the preview, fake data, harness and any minimal hooks the renderer needs. Typecheck, lint and prettier; no commit. Report the commands, scenarios and capture map.
