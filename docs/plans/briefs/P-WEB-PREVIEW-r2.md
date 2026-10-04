# Lane P round 2: preview bugs found by QA (no commit)

QA made `pnpm shots:review` work (60 captures over 5 areas, 138 s; their changes in `apps/desktop/scripts/shots-v2.mjs`, `shots-review.mjs` and `docs/PREVIEW.md` stay). They found two bugs in your preview (report: `.dev/runs/qa-shots-review/final.txt`):
1. **Seeded chats are broken:** `apps/desktop/src/renderer/web-preview.ts:134` adds an error part without the required `kind`, so `SessionDetailSchema.parse` fails and `sessions.get` rejects for every seeded session (1-8). The user would open a chat and see it fail. Fix the seed so **every** seeded part validates against the shared schemas, and add a unit test that parses every seeded session and part with the real schemas, so fixture drift fails fast. Then switch QA's workaround in `shots-v2.mjs` (they start an idle session through the composer) back to opening the rich seeded sessions directly, and add the `session-interrupted` state to the map.
2. **Simulated window chrome is wrong:** the window controls render top-left as a lone red close glyph. They must look like Windows 11 controls at the right of the top strip (minimise, maximise and close, real size 46x32 each, hover states), and occupy exactly the area the Electron title-bar overlay reserves, so the shell layout in the preview equals the app's.
3. Make the dev-only preview toggle not overlap app controls (bottom-right corner, small, and hidden in captures as QA did).

Typecheck, lint and prettier; no commit.
