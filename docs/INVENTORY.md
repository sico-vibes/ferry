# Documentation inventory

Snapshot: 2026-10-15. This catalog indexes 108 maintained release Markdown/MDX documents and identifies nine excluded vendor, benchmark fixture/solution, or generated evaluation records. Two checkout-local user notes are classified separately and intentionally have no published links. Counts describe this collection snapshot and may change as documents are added or removed. This is a discoverability index, not a deep content review; maintained claims should be checked against the current source and [status record](STATUS.md).

The maintained guides below are first-party documents, including historical plans and research. Historical documents describe their original scope and may not reflect the current implementation. Vendor documentation, benchmark fixture/solution prompts, and generated evaluation outputs are listed separately as excluded content so they remain in their source locations and are not mistaken for maintained product guidance.

## Product and contributor entry points

| Document | Purpose |
| --- | --- |
| [Project README](../README.md) | Product overview, install, first run, and CLI quickstart. |
| [Documentation hub](README.md) | Maintained guide entry point and documentation workflow. |
| [Current status](STATUS.md) | Current branch evidence, open work, limits, and release-state updates. |
| [Support matrix](SUPPORT-MATRIX.md) | Provider/client labels and evidence scope. |
| [Agent instructions](../AGENTS.md) | Repository workflow rules for implementers and QA. |
| [Claude instructions](../CLAUDE.md) | Repository instructions for Claude-based contributors. |
| [Changelog](../CHANGELOG.md) | Version and release history. |
| [License](../LICENSE) | Project license, kept at the repository root. |
| [Third-party notices](../NOTICE) | Legal notices for dependencies and assets, kept at the repository root. |
| [Design v2](../design/DESIGN-v2.md) | Authoritative current UI design specification. |
| [Design v1 archive](../design/archive/DESIGN-v1.md) | Historical design specification. |

## User and technical guides

| Document | Purpose |
| --- | --- |
| [Architecture](ARCHITECTURE.md) | Original staged architecture proposal; labeled historical where it differs from current implementation. |
| [CLI connections](CLI-CONNECTIONS.md) | Setup and usage for installed Codex, Claude Code, and OpenCode clients. |
| [CLI commands](CLI.md) | Command syntax, flags, examples, and exit codes. |
| [Cloud mode](cloud/CLOUD-MODE.md) | Cloud mode behavior and data handling. |
| [Delegation](DELEGATION.md) | Delegation workflows and configuration. |
| [Gateway](GATEWAY.md) | Local Gateway protocols, configuration, and policies. |
| [Mock tour](MOCK_TOUR.md) | Mock/demo UI tour. |
| [OpenCode Zen CLI note](OPENCODE-ZEN-CLI.md) | Implementation-specific Zen CLI behavior; current UI steps are in CLI connections. |
| [Optimizers](OPTIMIZERS.md) | Prompt and output optimization behavior and evidence. |
| [Performance](PERFORMANCE.md) | Performance budgets, findings, and measurement notes. |
| [Preview](PREVIEW.md) | Preview environment and workflow. |
| [Protocol](PROTOCOL.md) | Ferry client/core protocol contracts. |
| [Providers](PROVIDERS.md) | Provider configuration, behavior, and constraints. |
| [Routing](ROUTING.md) | Profiles, candidate selection, quota, and fallback. |
| [Security review](SECURITY-REVIEW.md) | Findings and remediation from security review. |
| [Security](SECURITY.md) | Security and data-handling guidance. |
| [Troubleshooting](TROUBLESHOOTING.md) | Common setup and runtime troubleshooting. |
| [Keyboard shortcuts](user/keybindings.md) | User-facing keyboard bindings. |

## Cloud schema documents

These SQL files are schema artifacts, not prose guides. They remain versioned under `docs/cloud/schema/` in migration order.

- [0001 core schema](cloud/schema/0001_ferry_schema_core.sql)
- [0002 row-level security and grants](cloud/schema/0002_ferry_rls_and_grants.sql)
- [0003 provider keys vault](cloud/schema/0003_ferry_provider_keys_vault.sql)
- [0004 log retention cron](cloud/schema/0004_ferry_log_retention_cron.sql)
- [0005 owner admin](cloud/schema/0005_ferry_owner_admin.sql)
- [0006 event ordering defaults](cloud/schema/0006_ferry_event_ordering_defaults.sql)

## Plans and implementation briefs

These files preserve implementation intent, reviews, and historical task briefs. Consult [current status](STATUS.md) before treating a plan's state as current.

### Plans

- [UI remake](plans/ui-remake.md)
- [v0.10 upgrade](plans/v0.10-upgrade.md)
- [v0.11 fixes and Gateway](plans/v0.11-fixes-and-gateway.md)
- [v0.12 UI and updates](plans/v0.12-ui-and-updates.md)

### Implementation and QA briefs

- [ACP race](plans/briefs/ACP-race.md)
- [CLI parity](plans/briefs/CLI-PARITY.md), [revision 2](plans/briefs/CLI-PARITY-r2.md)
- [F common brief](plans/briefs/F-common.md)
- [Free consistency](plans/briefs/FREE-CONSISTENCY.md), [revision 2](plans/briefs/FREE-CONSISTENCY-r2.md), [revision 3](plans/briefs/FREE-CONSISTENCY-r3.md), [revision 3b](plans/briefs/FREE-CONSISTENCY-r3b.md), [revision 4](plans/briefs/FREE-CONSISTENCY-r4.md)
- [Windows CI path](plans/briefs/INT-CI-win-path.md), [revision 2](plans/briefs/INT-CI-win-path-r2.md)
- [Integration N1](plans/briefs/INT-N1.md), [revision 2](plans/briefs/INT-N1-r2.md), [revision 3](plans/briefs/INT-N1-r3.md), [revision 4](plans/briefs/INT-N1-r4.md), [revision 5](plans/briefs/INT-N1-r5.md), [revision 6](plans/briefs/INT-N1-r6.md), [revision 7](plans/briefs/INT-N1-r7.md)
- [Integration N2](plans/briefs/INT-N2.md), [revision 2](plans/briefs/INT-N2-r2.md)
- [Main green](plans/briefs/MAIN-GREEN.md), [revision 2](plans/briefs/MAIN-GREEN-r2.md), [revision 3](plans/briefs/MAIN-GREEN-r3.md), [revision 4](plans/briefs/MAIN-GREEN-r4.md), [revision 5](plans/briefs/MAIN-GREEN-r5.md), [revision 6](plans/briefs/MAIN-GREEN-r6.md), [revision 7](plans/briefs/MAIN-GREEN-r7.md), [revision 8](plans/briefs/MAIN-GREEN-r8.md), [revision 9](plans/briefs/MAIN-GREEN-r9.md), [revision 10](plans/briefs/MAIN-GREEN-r10.md)
- [N common brief](plans/briefs/N-common.md)
- [N1 body](plans/briefs/N1-body.md)
- [N2 body](plans/briefs/N2-body.md)
- [NSIS warning](plans/briefs/NSIS-warning.md)
- [Web preview](plans/briefs/P-WEB-PREVIEW.md), [revision 2](plans/briefs/P-WEB-PREVIEW-r2.md)
- [Core test timeouts QA](plans/briefs/QA-core-timeouts.md)
- [Shell captures QA](plans/briefs/QA-shell-captures.md)
- [Key dialog screenshot QA](plans/briefs/QA-shot-key-dialog.md)
- [Screenshot review QA](plans/briefs/QA-shots-review.md)
- [Stream channel QA](plans/briefs/QA-stream-channel.md)
- [S shell brief](plans/briefs/S-SHELL.md)
- [Status document brief](plans/briefs/STATUS-DOC.md)
- [Fast updates](plans/briefs/U-FAST-UPDATES.md), [revision 2](plans/briefs/U-FAST-UPDATES-r2.md), [revision 3](plans/briefs/U-FAST-UPDATES-r3.md), [revision 4](plans/briefs/U-FAST-UPDATES-r4.md), [revision 5](plans/briefs/U-FAST-UPDATES-r5.md), [revision 6](plans/briefs/U-FAST-UPDATES-r6.md), [revision 7](plans/briefs/U-FAST-UPDATES-r7.md), [revision 8](plans/briefs/U-FAST-UPDATES-r8.md)
- [UI 2 common brief](plans/briefs/UI-2-common.md)

## Research notes

Research is point-in-time analysis, not a current provider availability or pricing guarantee.

- [Agentic AI APIs](research/agentic-ai-apis.md)
- [Coding agents](research/coding-agents.md)
- [Community free LLMs](research/community-free-llm.md)
- [Free providers](research/free-providers.md)
- [Free routing impact](research/free-routing-impact.md)
- [FreeLLM API](research/freellmapi.md)
- [Gray practices](research/gray-practices.md)
- [Multi-CA](research/multica.md)
- [New API](research/newapi.md)
- [OpenCode Zen access](research/opencode-zen-access.md)
- [Provider and OAuth enhancements](research/providers-and-oauth-enhancements.md)
- [Reasoning matrix](research/reasoning-matrix.md)
- [Router comparison 2](research/routers-2.md)
- [Routing comparison](research/routing-comparison.md)
- [T3Code](research/t3code.md)

## Contributor templates, source notes, and skills

- [Implementation brief template](dev/templates/brief.md)
- [QA brief template](dev/templates/qa-brief.md)
- [Catalog vendor source attribution](../packages/catalog/data/vendor/SOURCES.md) — attribution maintained beside catalog data.
- [Provider asset source attribution](../packages/ui/src/assets/providers/SOURCES.md) — attribution maintained beside provider artwork.
- [Delegate skill](../skills/delegate/SKILL.md)
- [Handoff skill](../skills/handoff/SKILL.md)
- [Review skill](../skills/review/SKILL.md)
- [Terse skill](../skills/terse/SKILL.md)
- [Benchmark guide](../scripts/bench/README.md) — instructions kept with the benchmark runner.

## Excluded content and source-local records

These files are intentionally not maintained product guides. They remain beside their code or data and are not moved into `docs/`.

- **Third-party vendor documentation:** [`packages/ui/vendor/react-bits/`](../packages/ui/vendor/react-bits/) is vendored content; its README documents that dependency, not Ferry.
- **Benchmark prompts and expected solutions:** [`scripts/bench/tasks/`](../scripts/bench/tasks/) contains fixture/solution pairs for `long-task`, `multi-file-feature`, and `readme-from-code`. They are benchmark inputs and expected outputs, not product documentation.
- **Generated evaluation reports:** [`evals/results/`](../evals/results/) contains timestamped result snapshots. These are generated outputs, not maintained user guidance.
- **Design references and screenshots:** [`design/references/`](../design/references/) and [`design/screenshots/`](../design/screenshots/) are visual source assets used by the design specification and UI workflows.

## Checkout-local user notes

These two user-owned checkout-local notes are excluded from the publishable catalog and intentionally have no Markdown links here: `docs/plans/v0.13-free-capacity.md` is a local plan, and `docs/research/free-first-deep-dive.md` is a local research note. The plans and research directories may contain checkout-local notes in addition to the release documents catalogued above.
