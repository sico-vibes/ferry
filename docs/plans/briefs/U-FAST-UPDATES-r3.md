# Lane U round 3: packaged build fails (no commit)

`pnpm --filter @ferry/desktop dist` fails while bundling the CLI:
`node_modules/.pnpm/ink@7.1.1.../ink/build/devtools.js:7:21: ERROR: Could not resolve "react-devtools-core"` (esbuild, ESM build). Log: `.dev/runs/u-dist.log`.
`ink` loads devtools only when `DEV=true`; mark `react-devtools-core` external (or alias it to an empty module) in the CLI bundle config the packaged build uses. Make sure the bundle never tries to load it at runtime in production. Check the same bundle config for other optional, dev-only or native imports that would fail the same way, so the next build gets past this step. Typecheck, lint and prettier; no commit.
