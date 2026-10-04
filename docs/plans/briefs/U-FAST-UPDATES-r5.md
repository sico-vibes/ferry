# Lane U round 5: packaged CLI can't find the catalog (no commit)

Build now succeeds: **118 files, installer 110 MB (was 139 MB)**. The packaged smoke passes the shim, version and Gateway checks, then fails the default-engine check. Run directly:
```
FERRY_DATA_DIR=<tmp> resources/cli/ferry.cmd status
ferry: ENOENT: no such file or directory, open '...\release\win-unpacked\resources\data\models.snapshot.json'
```
You moved the catalog data into `app.asar/out/data`, but the CLI's catalog loader (in the bundle, likely the core/catalog path resolver) still resolves `resources/data`. Fix the resolution for the packaged CLI: under `ELECTRON_RUN_AS_NODE` Electron's `fs` can read inside `app.asar`, so point it at `resources/app.asar/out/data/...` via the same path helper the desktop core uses, not a hard-coded string. Then check **every** other file the bundled CLI reads at runtime (migrations, catalog limits YAML, schemas, keybindings schema, prompts or templates) for the same problem. Grep the bundle for `resources`, `__dirname`, `process.resourcesPath` and `data/`.

Also fix the smoke's locale reporting: it printed `locales: 0 files / 0 bytes`, but `win-unpacked/locales/en-US.pak` exists; the counter reads the wrong directory.

Typecheck, lint and prettier; no commit. The orchestrator rebuilds and runs the packaged smoke.
