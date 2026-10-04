# MAIN-GREEN round 5: router ordering still differs on Linux (no commit)

Round 4 (local control channel) is received; the orchestrator gates it together with this round.

GitHub CI on `84aff90` (your round 1-3 code): Windows passes, and the ACP race test passes on Ubuntu. **Ubuntu still fails** `packages/router/test/router.test.ts > step classification and routing > keeps the historical deterministic ordering when provider knobs are at their defaults`: `expected [ 'groq/llama', 'gemini/llama' ] to deeply equal [ 'gemini/llama', 'groq/llama' ]`.

The UTF-16 tie-break didn't fix it, and under that order `gemini` < `groq` anyway, so the two candidates are **not** reaching the tie-break as equals on Linux: something upstream gives them different scores or order there. Candidates to check: anything time-based (`Date.now()`, quota windows, day boundaries, the local timezone; CI runs in UTC), path- or env-dependent config (HOME, catalog lookup, platform branches), floating-point accumulation order, `Math.random` without injection, or iteration over a structure filled asynchronously. Make the router's score computation a pure function of its inputs, have the test pin every environmental input (clock, timezone, env), and add a test that runs the same ordering under `TZ=UTC` and a non-UTC zone (or a forced clock near midnight) so this can't regress silently.

Typecheck, lint and prettier; no commit. Report the actual cause.
