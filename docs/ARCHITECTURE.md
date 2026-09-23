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
7. The step and the task record are persisted.
8. If the model changes, a handoff briefing and a `handoff_marker` are produced.
