# Optimizers

Optimizer features aim to reduce repeated tool-output tokens while preserving access to source material. Savings shown in the app come only from token-counted optimizer events persisted for the current UTC day. Estimates and demo fixture values are not displayed as measured savings.

- **Tool-output filters:** trim or summarize repetitive command/search output and retain useful lines. Filters must not be treated as a substitute for checking the underlying files.
- **Recovery handles:** large output can be stored behind a short handle so the agent can retrieve selected lines or grep matches later. Recovery reads are recorded as token cost, not as savings. Handles are temporary/in-memory in the current implementation; they are not durable archival storage.
- **Terse modes:** prompt instruction token changes and response token volume are recorded. A response counterfactual is not available, so the response event records equal before/after counts and claims no response savings.
- **Context hygiene / compaction:** unchanged file rereads become short stubs with recoverable source; older large tool results become summaries; context compaction records its before/after token counts.

## Measured

### Live parity (2026-09-29)

The eight-scenario `main`, `auto-free` run alternated optimizers on and off. Both arms passed **6/8**, with the same two failures. For the six tasks that passed in both arms, input tokens were **112,849 with optimizers on** and **110,232 with optimizers off**. This is a **2,617-token increase** in the on arm, not a measured saving; routing variance dominates these small fixture repositories. The original on arm recorded **zero `optimizer_events`**, so it produced no event-based savings measurement. The two noisy parity scenarios added for M3 are intended to make future live runs exercise test and build filters.

### Deterministic replay (rerun 2026-09-30)

Run `pnpm bench:optimizers` to replay the checked-in large Vitest, Jest, Pytest, TypeScript, ESLint, Git status/diff/log, and pnpm install fixtures, plus generated 5,000-line logs, repeated file reads, and large JSON/HTML payloads. The replay also reports terse prompt overhead, response token volume, and the cost of reading a recovery handle. It asserts that runner summaries and complete failure details, errors, and paths survive filtering.

The replay produced these deterministic counts with the shared tokenizer (23 measured samples):

| Optimizer | Samples | Before | After | Net saved |
| --- | ---: | ---: | ---: | ---: |
| Test runners | 6 | 9,849 | 900 | 8,949 |
| Build and lint | 2 | 5,371 | 5,358 | 13 |
| Git status | 1 | 734 | 602 | 132 |
| Git diff | 1 | 8,209 | 3,189 | 5,020 |
| Git log | 1 | 6,623 | 2,679 | 3,944 |
| Package install | 1 | 1,984 | 1,206 | 778 |
| Generic output | 2 | 61,487 | 1,539 | 59,948 |
| Context hygiene | 4 | 210,253 | 10,453 | 199,800 |
| Recovery reads (cost) | 1 | 0 | 43,487 | -43,487 |
| Terse prompt | 3 | 15 | 51 | -36 |
| Terse response volume | 1 | 25 | 25 | 0 |
| **Total** | **23** | **304,550** | **69,489** | **235,061** |

The standard `pnpm bench:optimizers` launcher hit the sandbox's `spawn EPERM` restriction in tsx/esbuild. The same benchmark script completed directly under Node's TypeScript transform mode with the workspace resolver, and its correctness assertions passed. No fixed savings percentage is claimed.
