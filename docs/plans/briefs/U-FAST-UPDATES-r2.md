# Lane U round 2: the real cause of slow installs (no commit)

Round 1 is accepted (silent update install, `${isUpdated}` guard, restart affordance, smoke extensions). The orchestrator measured what you couldn't:
- Release `v0.9.0-beta.37` assets: `beta.yml`, `Ferry-Setup-0.9.0-beta.37.exe` (139 MB), its `.blockmap`, and the portable exe. Differential metadata is published.
- **The installed app has 12,937 files, and 12,823 of them are `resources/cli`.** The CLI ships as a loose `node_modules` tree. That's why install and update are slow: NSIS writes about 13k files and Defender scans each one, and an update has to replace them all.

Fix (the main deliverable of this lane):
1. Ship the CLI as a **bundled single-file entry** (the esbuild bundle `apps/cli/dist/ferry.js` already exists and the CLI tests use it) plus only what can't be bundled: native modules (`better-sqlite3`, `@napi-rs/keyring`, `node-pty`, `@vscode/ripgrep` binaries, whatever the CLI really loads at runtime), the SQL migrations and catalog data. Prefer reusing the native modules the Electron app already ships (in `app.asar.unpacked`), resolved by the CLI at runtime, over duplicating them, if their ABI matches how the CLI runs (check whether the shim runs the CLI with Electron as Node via `ELECTRON_RUN_AS_NODE`; if so, the Electron-ABI builds are the right ones). Target: `resources/cli` under about 50 files.
2. Keep every CLI capability working from the packaged app: `ferry --version`, `status` (in-process engine and over the local control channel), `providers list`, `gateway start/status`, `run` with streaming, and `doctor`. The existing packaged smoke (`smoke-packaged.mjs`) checks several; extend it for the rest, and **assert the file count of `resources/cli` stays under a budget** so this can't regress.
3. Also report the total installed file count after the change, and anything else large in the install (unpacked asar contents, locales) that could be trimmed safely (for example Electron locales the app doesn't use; only if electron-builder supports excluding them cleanly).

Typecheck, lint and prettier; no commit. The orchestrator will build (`dist`), run the packaged smoke and count files.
