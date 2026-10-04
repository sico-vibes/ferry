# QA: make `pnpm shots:review` work end to end (test tooling only)

Repo `C:\dev\ferry`, branch `feat/web-preview` (uncommitted Lane P work; **don't commit**). Only edit the preview/screenshot tooling under `apps/desktop/scripts/` (`shots-review.mjs`, `shots-v2.mjs`, the review area map) and `docs/PREVIEW.md`. Don't change product UI.

`./tools/pnpm.cmd shots:review all` fails: `ReferenceError: resolve is not defined` inside the shots-v2 flow, then `Existing shots-v2 flow exited with code 1` (log: `.dev/runs/shots-review-all.log`). The code was written without being able to run it, so expect more issues after this one.

Goal: for each area (`shell`, `settings`, `models`, `home`, `gateway`) and for `all`, the command produces PNGs for every state in the map (light/dark x 1024x680/1440x900, including open menus, tooltips and the picker) in `.dev/review/<area>/`, plus a `REVIEW.md` that lists each capture with its matching reference image from `design/references/2026-10-04/` and the principles checklist from `docs/plans/v0.12-ui-and-updates.md`. Every listed state must actually show what it claims (a "user menu open" capture really has the menu open). Open a few PNGs to confirm. Run until `all` passes; report the per-area capture counts, the total runtime, and anything you couldn't capture and why.
