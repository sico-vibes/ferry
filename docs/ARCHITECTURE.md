# Ferry architecture

## Principle: contract-first client
The UI (desktop renderer, later the CLI) talks **only** to the typed `FerryClient` interface (`@ferry/client`), whose types live in `@ferry/shared` (zod).

- **Part A (now):** `MockFerryClient`: in-memory fixtures, scripted session playback, simulated quota countdowns.
- **Part B:** `RpcFerryClient` speaks JSON-RPC 2.0 (`ferry/1`) to the core service. A `HybridClient` routes each domain (`providers`, `quota`, `sessions`, …) to mock or RPC, so the engine is wired into the finished UI one domain at a time. One contract test suite runs against both.

## Packages
```
apps/
  desktop/      Electron main + preload + React renderer        (Part A)
  cli/          `ferry` CLI (Ink TUI + headless + admin)        (Part B)
packages/
  shared/       zod domain types, protocol types, ids, errors    (Part A)
  client/       FerryClient interface, MockFerryClient, fixtures, playback (Part A); RpcFerryClient, HybridClient (Part B)
  ui/           design tokens, Tailwind preset, components, effects, brand assets (Part A)
  config/ storage/ secrets/ testkit/ catalog/ providers/ quota/ router/
  workspace/ optimizer/ agent/ delegate/ core/                    (Part B)
skills/         bundled skills (terse, delegate, handoff, review) (Part B)
design/         reference/, DESIGN.md, screenshots/
```

## Runtime (target)
```
Electron renderer (React) ── FerryClient ──► HybridClient ──► MockFerryClient
                                                   └─────────► RpcFerryClient ─MessagePort─► core (utilityProcess)
CLI (Ink) ─────────────── FerryClient ──► RpcFerryClient ─stdio/WebSocket─► core
core: agent loop · router · quota ledger · providers (AI SDK) · workspace tools · optimizer · delegation · SQLite
```

## Engine data flow per agent step (Part B)
1. Tag the step kind.
2. `router.select` picks a model using profile, quota capacity, context fit and reliability.
3. The provider call goes through a fetch interceptor, producing a `UsageRecord`.
4. The ledger and reconciler record it and emit `quota.update`.
5. Tool calls are validated, pass the permission check and execute.
6. The optimizer filters the output and keeps a recovery handle.

## Provider telemetry contracts

`@ferry/shared` owns the Zod schemas and types for `RawCallObservation`, `UsageRecord`, `QuotaObservation`, and `ProbeResult`; provider and quota packages import these shared contracts. The richer shared fields are canonical: calls use `modelRef` and `statusCode`, usage adds stable identity and occurrence time plus optional session, task, cost, and plan data, and quota observations include source and observation time. Provider-specific header or endpoint parsers return `ParsedQuotaWindow` snapshots that the adapter normalizes into `QuotaObservation` before deriving display windows. Probe results include key validity, discovered models, and a typed provider error kind.
7. The step and the task record are persisted.
8. If the model changes, a handoff briefing and a `handoff_marker` are produced.

## Dangerous command permissions

Commands classified as dangerous require explicit confirmation in `ask` and `auto_edit` modes. The approval request includes a danger warning and the detected reason. `full_auto` denies dangerous commands without executing them.

## Where to register a new screen / shot / e2e flow / mount / store slice

- **Screen:** add a route fragment in `apps/desktop/src/renderer/app/routes/` and register its factory in `routeRegistry` in `app/routes/index.ts`.
- **Screenshot:** add a `{ name, run(page, ctx) }` module under `apps/desktop/scripts/shots/`; the `shot` runner applies optional name filters.
- **E2E flow:** add a `{ name, run(page, ctx) }` module under `apps/desktop/scripts/e2e/flows/`; the `e2e` runner applies optional name filters.
- **App mount:** add a React component to `app/mounts.tsx` and append it to `appMounts`.
- **UI state:** add the concern's state/actions in its own `state/ui-*.ts` slice and compose it from `state/ui.ts`.
- **UI kit exports:** add folder exports to that folder's `index.ts`; the package root re-exports folder barrels.

## Adding a real domain

Add `packages/core/src/domains/<domain>.ts` with an exported `register(host, services)` function, then add that registrar as one line in `packages/core/src/domains/index.ts`. Validate positional params and returned values with the corresponding `@ferry/shared` Zod schemas, and emit shared-contract events when state changes. Add or extend the `FerryClient` contract test for the domain, run it against both mock and in-process RPC clients, then flip the domain in the desktop `FERRY_REAL_DOMAINS` default after its end-to-end flow passes.
