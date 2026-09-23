# Ferry status

| Phase | State | Notes |
|---|---|---|
| A0 Bootstrap | done | scaffold, strict lint + token rule, CI (Win + Ubuntu), lanes, DESIGN.md; repo public |
| A1 Contract + mock data | done | FerryClient contract, MockFerryClient + fixtures, scripted playback, QA + fixes |
| A2 UI kit | done | tokens, effects, nav, canvas, chat parts, React Bits accents (Thinking line, Status mark, Count up, Toasts, Spotlight…) |
| A3 Shell + Home (**Checkpoint C1: GO** 2026-09-23) | done | Electron + web renderer, Home + live Session, Ferry logo/app icon |
| A4 All screens on mock | in progress | Explore/Usage · Library/Settings/Onboarding · delegation review, palette, diff, terminal |
| A5 Polish & quality | — | |
| A6 Shippable mock (**GO/NO-GO**) | — | |
| Part B | blocked on GO | |

## Known gaps / accepted risks
- Raw-color lint rule flags hex-like strings such as `'issue #123'` (accepted).
- Deep-import guard only blocks `@ferry/*/src/**`.
- ESLint-inside-vitest test takes ~40s under load (timeout 120s) — replace with a lighter rule test in A5.
- Renderer bundle ~1.7 MB (code-split Monaco/xterm/shiki/recharts in A5).
- `design/reference/` is third-party and local-only (gitignored).
