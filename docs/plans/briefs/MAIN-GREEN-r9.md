# MAIN-GREEN round 9: stale CLI bundle in tests (no commit)

QA diagnosed round 8's gate run (`.dev/runs/qa-timeouts/final.txt`, read it):
- The ~45 timeouts were machine load, not a channel deadlock (start/stop overhead is single-digit ms). No action on the channel.
- **Real bug:** `apps/cli/test/global-setup.ts:10-18` decides whether to rebuild `apps/cli/dist/ferry.js` from an `inputs` list that omits `packages/core/src` and most of the `@ferry/*` packages the bundle inlines. So the CLI tests ran a stale bundle still containing round 7's `icacls`/identity code (the deterministic `Cannot secure the local core endpoint file: Windows user identity is missing.` failures).

Fix: derive the staleness inputs from what the bundle actually inlines (every workspace package the CLI bundles, transitively: their `src` plus `package.json`, and the bundler config), not a hand-kept list. Or rebuild whenever any workspace source is newer, if that's simpler and still cheap. Add a test or assertion that fails if a bundled workspace package isn't covered. Also check `apps/cli/package.json` / `turbo.json` so `@ferry/cli#test` depends on `^build` (or on the bundle task) and Turbo's cache can't serve a stale bundle.

Typecheck, lint and prettier; no commit.
