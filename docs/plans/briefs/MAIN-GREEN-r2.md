# MAIN-GREEN round 2 (no commit)

Good work on round 1. Items 2-5 are accepted pending the orchestrator's gates. Two items don't meet the bar yet:

**A. Item 6, shared data dir: finish the design.** Pointing the CLI at the desktop `Ferry/engine` directory is right, but as it stands:
1. **Existing CLI-only users lose data.** Anyone who used the CLI before has sessions, settings and Gateway keys in `~/.ferry`. On first run with the new location: if `~/.ferry` has a database and the new location doesn't, migrate it (copy the DB plus WAL/SHM files and any other engine files, then leave a marker or README in the old directory; never delete the user's data). If both exist, use the new location and print a one-line notice naming the old path. Test both cases.
2. **Two engines on one database.** When the desktop app is running, its core owns that directory. The CLI's local engine must not run a second full core on the same DB (duplicate background work like model discovery, migrations racing, Gateway port clashes). Determine what exists today (is there a lock file, a running-core handshake, or a way for the CLI to connect to the desktop core?). Then implement the cleanest correct behaviour: connect to the running core if a supported channel exists; otherwise take an exclusive engine lock and fail clearly or fall back to read-only. If the right fix is larger than this lane, implement the safe minimum (a lock plus a clear message) and describe the full design in your report. Add tests.
3. `FERRY_DATA_DIR` (or whatever the existing override is) must still win over both paths.

**B. Item 1, lint caching:** don't disable Turbo caching for lint. Find why the cache key missed the change (missing `inputs` such as the ESLint config, `tsconfig`, or dependency package sources that typed lint rules depend on; `no-base-to-string` is type-aware, so the CLI's lint result depends on the types of its workspace dependencies) and declare the correct inputs/`dependsOn` so the cache is correct. Re-enable caching.

Same rules as round 1: typecheck, lint and prettier; tests for the orchestrator to run; no commit. Report what you found for A2 (what exists today) explicitly.
