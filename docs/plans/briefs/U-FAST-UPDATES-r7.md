# Lane U round 7: `__dirname` in the ESM bundle (no commit)

Good: `resolveFerryRuntimePaths` and its 4 temp-tree tests **pass** (the orchestrator ran them). The packaged CLI still fails:
```
resources/cli/ferry.cmd status
ferry: __dirname is not defined
```
`resources/cli/ferry.js` is an ESM bundle and contains `__dirname` 4 times. In ESM, derive it from `import.meta.url` (`fileURLToPath(new URL('.', import.meta.url))`), or inject it with a tsup/esbuild banner (`const __dirname = ...`) that's valid for ESM. Fix the source, not just the bundle: find every `__dirname`/`__filename`/`require(` in code that ends up in the CLI bundle (including `runtime-paths.js` and the generated native bridges), and make each ESM-safe.

Also, **the smoke still prints an empty reason**: `Packaged CLI default-engine smoke failed: ` with nothing after it. Your stdout/stderr change didn't reach this path; make that exact failure print the CLI's stderr.

Add a regression check that would have caught this without a full `dist`: a test that runs the built CLI bundle (`apps/cli/dist/ferry.js`) with `--version` and `status` under plain `node` with a temp `FERRY_DATA_DIR` and asserts exit 0 (the CLI tests already build the bundle). Typecheck, lint and prettier; no commit.
