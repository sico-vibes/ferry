# QA: make the `settings-provider-key-dialog` screenshot state capture (test tooling only)

Repo `C:\dev\ferry` (branch `int/n1-n2`; don't commit, don't switch branches). Only edit `apps/desktop/scripts/shots-v2.mjs`. Don't change app source; if the app itself is wrong, stop and report it.

Run: `FERRY_SHOT_STATES=settings-provider-key-dialog FERRY_SKIP_WEB_BUILD=1 ./tools/pnpm.cmd --filter @ferry/desktop shots:v2` (drop `FERRY_SKIP_WEB_BUILD=1` on the first run so the web build is fresh).

Current failure for all 4 variants: `locator.waitFor: Timeout 30000ms` waiting for `getByRole('dialog', { name: 'Manage OpenAI API key', exact: true }).getByRole('region', { name: 'Saved provider keys' }).getByText('ok', { exact: true })`. The state seeds two OpenAI keys (one healthy, one disabled) into persisted `ferry.mock.v1` mock data and reloads. Find out what the dialog actually renders (dump its accessibility text on failure) and make the seeding and waits match the real UI. Goal: 4 PNGs `settings-provider-key-dialog-{light,dark}-{1024x680,1440x900}.png` in `design/screenshots/v2/`, showing the dialog with 2 keys (healthy plus disabled) and the Routing section visible.

Report: the root cause, the change, the run output (pass), and the 4 file paths. If the seeded data never reaches the UI because of an app/mock bug, say exactly where.
