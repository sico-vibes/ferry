# Lane U round 6: make packaged path resolution testable, then fix it (no commit)

Still failing after the rebuild:
```
resources/cli/ferry.cmd status
ferry: Could not find bundled catalog data from ...\release\win-unpacked\resources\cli
```
Packaged facts: `resources/cli/ferry.cmd` is `set ELECTRON_RUN_AS_NODE=1` then `"%~dp0..\..\Ferry.exe" "%~dp0ferry.js" %*`. So `process.execPath` is `<app>\Ferry.exe`, the entry is `<app>\resources\cli\ferry.js`, `process.resourcesPath` **may be undefined under ELECTRON_RUN_AS_NODE**, and the data lives at `<app>\resources\app.asar\out\data\`. `resources/cli` contains only `ferry.cmd`, `ferry.js` and `migrations/`.

You've been guessing because you can't build here. Stop guessing: make it testable without a build.
1. Put the resolution in one pure function (inputs: entry file path, execPath, env, resourcesPath if any, and an `exists` predicate) that returns the data dir, the migrations dir and native-module locations, and use it everywhere.
2. Unit tests that build **temp directory trees mimicking each real layout** (packaged win-unpacked with app.asar as a file, which you can simulate with a plain directory named `app.asar` since the function only needs `exists`; dev monorepo; CLI test bundle in `apps/cli/dist`) and assert the resolved paths. Include the exact packaged layout above.
3. Error messages list every candidate path tried, so a failure is self-explanatory.
4. In `smoke-packaged.mjs`, print the CLI's stderr and stdout on failure (it printed an empty reason because `error?.message` was empty).
Typecheck, lint and prettier; tests for the orchestrator; no commit.
