# Lane U: updates that feel like updates (no commit)

Worktree `C:\dev\ferry-upd`, branch `feat/fast-updates`. Read `AGENTS.md`, `docs/plans/v0.12-ui-and-updates.md` (workstream U), `apps/desktop/electron-builder.yml`, `apps/desktop/nsis/installer.nsh`, `apps/desktop/scripts/after-pack.mjs`, `apps/desktop/scripts/dist.mjs`, `apps/desktop/scripts/install-smoke.mjs`, the auto-update code in `apps/desktop/src/main` (electron-updater), and `.github/workflows/beta.yml`. Sandbox: no builds or NSIS; the orchestrator builds and measures.

User report: every update feels like installing the whole app again and takes a long time. Ferry is unsigned, per-user NSIS (assisted installer, `oneClick: false`), and publishes to GitHub Releases on every merge.

Step 1, **diagnose** (report before changing anything big): what happens today on update? Does electron-updater do a differential download (is the previous release's `.blockmap` published and found, and is `latest.yml` correct)? Does the update run the full assisted NSIS wizard (options page, progress, etc.) instead of a silent update? How big is the payload, how many files are installed, and is anything forcing a slow reinstall (uninstall-then-install of the old version, data copy, PATH/Explorer steps re-running, Defender scanning many loose files)?

Step 2, **implement best practice** (as VS Code, Slack, Discord and other electron-updater apps do):
- Background download, differential via blockmap with full download as fallback; check on start and every few hours; no UI until ready.
- **Silent install** for updates: `quitAndInstall(isSilent=true, isForceRunAfter=true)`, and an installer that detects update mode (`${isUpdated}`) and skips the custom options page and any wizard UI, keeps the user's previous PATH/Explorer choices (already stored in HKCU), and doesn't uninstall user data.
- "Update ready, restart to apply" as a small non-blocking affordance (sidebar footer or a toast with an action) plus an auto-install on quit; respects an "update channel" setting if one exists.
- Packaging: keep resources compact (asar, no huge unpacked trees), so the install step writes fewer files.
- The first install keeps the assisted wizard with the PATH and Explorer checkboxes.
- Make sure the GitHub release assets include what differential updates need (blockmaps for the installer and the previous version), and that the beta workflow publishes them.

Step 3, **measurement plan**: a script (`apps/desktop/scripts/update-smoke.mjs` or an extension of install-smoke) that installs version N silently, then updates to N+1 the way the app does (silent mode), and records bytes downloaded (differential vs full), install wall time, and that the app relaunches with data intact and the PATH choice preserved. Wire it into the install-smoke workflow if feasible.

Typecheck, lint and prettier; tests where code is testable (update state machine, installer mode detection via a test switch). No commit. Report the diagnosis first, then the changes, then what the orchestrator must run to measure.
