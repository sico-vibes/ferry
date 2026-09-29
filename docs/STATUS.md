# Ferry status

Ferry is a Windows-first desktop and CLI coding agent with a local core, persistent SQLite data, provider routing, workspace tools, and native/ACP delegation. The desktop is connected to real core domains; the mock client remains for demos and UI tests.

## Phases

| Phase | State | Current evidence |
|---|---|---|
| A0 Bootstrap | Done | Workspace, CI, strict checks, design system |
| A1 Client contract and mock data | Done | Typed client, fixtures, playback |
| A2 UI kit | Done | Tokens, components, effects |
| A3 Desktop shell and Home | Done | Electron, React renderer, core handoff |
| A4 Screens and workflows | Done | Settings, providers, sessions, review, delegation |
| A5 Polish and quality | Done | E2E, accessibility, packaging checks |
| A6 Shippable desktop | Done | Packaged Windows installer and portable build |
| B0 Local core and protocol | Done | JSON-RPC core and utility process |
| B1 Persistent storage and settings | Done | SQLite repositories and migrations |
| B2 Providers and catalog | Done | Provider adapters, model discovery, secret store |
| B3 Quota and usage | Done | Capacity, observations, usage history |
| B4 Routing and profiles | Done | Free-first, fallback, resilience, reliability |
| B5 Agent loop and tools | Done | Planning, edits, permissions, recovery |
| B6 Workspace and checkpoints | Done | Workspace jail, diff, restore |
| B7 CLI | Done | Local engine, status, profiles, gateway commands |
| B8 Desktop real-domain integration | Done | Desktop core connection and real-domain RPC |
| B9 Delegation and review | Done | Codex, OpenCode, Claude, ACP, accept/reject/rework |
| B10 Gateway | Done | OpenAI and Anthropic-compatible local API |
| B11 Install, upgrade, uninstall | Implemented; live verification pending | Isolated Windows smoke covers clean install, upgrade persistence, keep/remove data, PATH, and registry cleanup |

## Milestones

| Milestone | State | Remaining evidence |
|---|---|---|
| M1 Core and protocol | Done | - |
| M2 Providers and routing | Done | Run the requested full gates for the latest routing changes |
| M3 Desktop and CLI | Done | Installer smoke is authored; execute it on Windows with a built installer |
| M4 Live delegation | Harness authored | Run against installed, authenticated native and ACP agents |
| M5 Gateway | Implemented | Verify typed mid-stream provider failure handling through tests |
| M6 Packaging and data lifecycle | Implemented | Run the full install/upgrade/uninstall matrix on Windows |
| M7 Release readiness | In progress | Full checks and desktop E2E; confirm live harnesses and platform packaging |

## Known gaps

- Provider availability, free limits, and model pricing change outside Ferry's control.
- Live delegation requires the relevant agent CLI/ACP adapter to be installed and authenticated; the harness skips unavailable agents and does not inspect credential files.
- The install smoke builds a higher-version installer and changes the current user's PATH only inside its opt-in test cycle; run it on a disposable Windows test account or a machine with no existing Ferry registry/config installation.
- Codex `/v1/responses` is not implemented by the Gateway.
- Renderer bundle splitting and broader release-platform validation remain follow-up work.
