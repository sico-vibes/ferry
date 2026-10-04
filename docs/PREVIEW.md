# Ferry web preview

Run `pnpm preview:web` and open [http://127.0.0.1:5199](http://127.0.0.1:5199). This serves the real renderer and uses the existing mock client and playback runner. The preview does not call providers or require credentials.

The default `busy` scenario has the seeded multi-project data, provider states, long transcripts, sample approvals and handoffs, a live local-only request event stream, and a streaming playback response. Select a scenario with `?scenario=busy`, `?scenario=empty`, or `?scenario=errors`. Theme is selected with `?theme=light|dark|system`; route is selected with `?route=/models` or another renderer path. `?size=1024x680` or `?size=1440x900` selects the simulated window size.

- `busy`: populated mock workspace, deterministic transcript samples, providers and model catalog.
- `empty`: first-run onboarding with no chats or providers.
- `errors`: offline banner, cooling providers, interrupted sessions, and a failed request sample.

The title strip and simulated Windows controls sit inside the renderer's normal title-strip layout. `Ctrl+Shift+P` opens the dev-only preview tools; the panel starts hidden. Use the panel to select scenario, theme and target review size.

## Visual review loop

Run `pnpm shots:review shell|settings|models|home|gateway|all`. It reuses a running web preview on `http://127.0.0.1:5199`, or starts one and stops it afterwards, then drives the existing `shots-v2.mjs` flow and writes light/dark captures at 1440x900 and 1024x680 under `.dev/review/<area>/`. `review-areas.mjs` is the single state-to-area map, and `all` captures every state in every area. The dev-only preview controls are hidden in captures. Each `REVIEW.md` lists every capture, pairs the state with its reference image from `design/references/2026-10-04/`, and carries the product-principles checklist from `docs/plans/v0.12-ui-and-updates.md`. Review the images and brief, record findings, update the map if a lane adds states, then repeat.

`shots:review` uses the installed Playwright setup and does not build another renderer. Session states are opened through the `explain` playback rather than the seeded showcase sessions, which the renderer refuses to open directly because one preview fixture part fails schema validation.
