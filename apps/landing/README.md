# Ferry landing

Marketing site for Ferry. Next.js App Router, Tailwind CSS, and TypeScript.
It does not build or start the Electron desktop app.

## Local commands

From the repository root, install only this app and the workspace tooling:

```sh
pnpm install --filter ferry --filter @ferry/landing...
pnpm --filter @ferry/landing dev
pnpm --filter @ferry/landing build
```

From this directory, after dependencies are linked:

```sh
pnpm build
```

`pnpm build` runs `next build`. It does not run `electron-vite` or package the desktop app.

## Vercel

| Setting | Value |
| --- | --- |
| Framework preset | Next.js |
| Root Directory | `apps/landing` |
| Install command | `cd ../.. && pnpm install --filter @ferry/landing... --frozen-lockfile` |
| Build command | `pnpm build` |
| Output | Next.js default (do not set a static output directory) |
| Node.js | 22.x |

`vercel.json` in this directory sets the same install and build commands. The install filter links `@ferry/landing` and its npm dependencies. It does not install Electron, `better-sqlite3`, or `node-pty`.

Set `NEXT_PUBLIC_SITE_URL` to the production origin, including `https://`, so canonical, Open Graph, sitemap, and robots URLs stay absolute. If it is unset, the build uses `VERCEL_PROJECT_PRODUCTION_URL` or `VERCEL_URL`.

Include files outside the root directory can stay off. Brand marks and product screenshots are copied into `public/`.

## Page

1. Nav with the Ferry mark, section links, and Download.
2. Hero with a React Bits Gradient Waves background, ferry headline, dual CTAs, and the desktop home screenshot.
3. The crossing: Magic UI animated beams from provider marks through the Ferry mark to the desktop session and CLI.
4. Feature cards.
5. Three steps: add keys, pick a route, code.
6. Routing screenshot.
7. FAQ accordion.
8. Final download CTA and footer.

Reduced motion skips the WebGL sea and the traveling beam gradient. Narrow viewports use a lower wave detail setting.
