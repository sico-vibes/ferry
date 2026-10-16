# Current status and release evidence

Snapshot: 2026-10-16; merged revision `7ce91a0816517bcb704882ae96c1a8a0cbe81e8e` on `main`; the validated implementation source is `98ddecc`. PR [#6](https://github.com/sico-vibes/ferry/pull/6) has merged. Hosted CI [workflow 38864343508](https://github.com/sico-vibes/ferry/actions/runs/38864343508) passed its full Linux and Windows gates after early runtime preflights. The local checks and hosted result validate the release candidate; beta publication and downloadable artifacts are reported by the [Beta workflow](https://github.com/sico-vibes/ferry/actions/runs/38866982892) and [GitHub Releases](https://github.com/sico-vibes/ferry/releases). A successful Beta workflow publishes the installer, portable package, and updater feed. The beta version and publication result must match those sources.

## Verified behavior

- Ferry connects installed Codex CLI, Claude Code, and OpenCode to native Ferry chat, Ferry CLI, and Gateway through separate explicit opt-ins. Native tools run under Ferry permissions; Gateway returns tool calls to the external API client, which executes them and sends real results. All three clients completed native and Gateway caller-tool/result rounds, with anonymous OpenCode Big Pickle verified in the tested environment.
- Auto routing is free-first. Included subscription capacity requires profile opt-in; metered or unknown CLI capacity is not authorized by that toggle. Installed CLI Fast/priority fails closed when a separately billed charge cannot be bounded with a known-price reservation.
- Model/provider views surface installed CLI discovery, verification, usage, limits, profile routing, and supported effort/speed options. Cached inventory keeps refresh responsive. Usage history attributes the producer when known, marks missing evidence, and avoids inventing older totals. Explicit conversation deletion removes attributable optimizer recovery output; pre-existing orphan rows are not proactively purged.
- Installed CLI transports support text and caller-tool handoffs. The Workspace browser tool loads a fresh document for each viewport and follows the session/frame/loader lifecycle; it rejects downloads or missing loaders and ignores untagged events. The PowerShell Unicode test retains its original assertion and timeout; its test harness now uses installer-aligned `spawnSync` and phase diagnostics. The production PowerShell encoding helper is unchanged; the refreshed desktop and CLI builds include the browser-tool correction.
- CI and Beta workflows run two real runtime preflights before their full required gates, without retries, skips, or prewarming. Beta tags are pinned to `github.sha`.

## Validation

- Local independent full gate: 67/67 tasks; Core 584 tests in 64 files, Desktop 249, CLI 179, Workspace 141 with one baseline skip, root 12, no-BOM for 1,365 files, and Prettier. Focused Workspace checks passed 19 tests.
- Production desktop build and packaged CLI e2e passed; the packaged many-file case completed in 2,383 ms. The 708-screen/12-keyboard UI matrix passed. All 10 installer, update, CLI, uninstall, and portable smoke checks passed while preserving settings, sessions, custom profiles, and a retrievable Gateway key.
- Hosted Linux and Windows full gates passed in the workflow linked above. The runtime preflights also passed: browser checks on both platforms and both PowerShell test cases on Windows.

## Supported limits

- Installed CLI connections use the user's current signed-in client account. Ferry does not enroll accounts or import their prior conversation histories.
- CLI transports do not support images or structured output. Explicit request controls are rejected when the selected bridge cannot enforce them. Fast/priority is unavailable when Ferry cannot bound its separate charge with a known-price reservation.
- Unavailable quota means unknown; it proves neither exhaustion nor capacity. Missing usage evidence is reported as incomplete rather than estimated. Partial earlier history cannot be proven complete from timestamps alone.
- Client credentials remain in their client-owned stores. Ferry's locally stored recovery output is removed on explicit conversation deletion when attributable to a valid session ID. Older orphaned recovery rows are not swept; no TTL or startup purge is implemented.
- These checks cover the named clients and tested paths. They do not guarantee universal free access, unlimited capacity, or failure-free service.

## Maintaining this record

For later fixes or features, update this page only after the relevant behavior and checks are accepted. Record the exact source revision, gates, evidence locations, and user-visible limits. Keep provider/client support detail in [SUPPORT-MATRIX.md](SUPPORT-MATRIX.md) and setup steps in [CLI-CONNECTIONS.md](CLI-CONNECTIONS.md). Treat local `.dev` logs as supporting evidence; do not copy credentials or raw provider output into documentation.
