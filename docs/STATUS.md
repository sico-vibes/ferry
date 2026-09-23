# Ferry status

| Phase | State | Notes |
|---|---|---|
| A0 Bootstrap | done | scaffold, strict lint + token rule, CI (Win + Ubuntu), lanes, DESIGN.md; repo public |
| A1 Contract + mock data | in progress | A1.1 contract → A1.3 mock client + fixtures → A1.5 playback |
| A2 UI kit | — | |
| A3 Shell + Home (**Checkpoint C1**) | — | |
| A4 All screens on mock | — | |
| A5 Polish & quality | — | |
| A6 Shippable mock (**GO/NO-GO**) | — | |
| Part B | blocked on GO | |

## Known gaps / accepted risks
- Raw-color lint rule flags hex-like strings such as `'issue #123'` (accepted; UI code rarely needs them).
- Deep-import guard only blocks `@ferry/*/src/**`; undeclared subpaths aren't caught until resolution (tighten when packages multiply).
- `design/reference/` is third-party and local-only (gitignored).
