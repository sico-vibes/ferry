# MAIN-GREEN round 8: the control channel must never stop the core from starting (no commit)

Round 7 made it worse. Gates: e2e now **fails 4/5** (core flows, crash resume, paid guardrails, Electron smoke), and `@ferry/core` / `@ferry/cli` tests still fail. Every one has the same error: `FERRY_CORE_ERROR Error: Cannot secure the local core endpoint file: could not query the current user SID.` The `whoami.exe` spawn fails inside the Electron utility process (no console; see also `AttachConsole failed` in the log), so the core never becomes ready. Logs: `.dev/runs/mg7-check.log`, `.dev/runs/mg7-e2e.log`.

Decisions (follow these):
1. **No child processes for ACL hardening.** Don't spawn `whoami`, `icacls` or PowerShell on core start-up (fragile and slow, with antivirus in the way).
2. **Windows:** the endpoint file lives in the per-user Ferry data dir under `%APPDATA%`/`%LOCALAPPDATA%`, which already inherits an owner-only ACL (user, SYSTEM, Administrators). Rely on that inheritance and don't rewrite the ACL. The named pipe keeps Node's default (the creating user's token). The token authentication is the real gate. If `FERRY_DATA_DIR` points somewhere else, document that the user owns that directory's permissions. On POSIX keep `0600` (and the socket in a `0700` dir).
3. **Fail open for the channel, never for the core:** if publishing the endpoint fails for any reason, log one warning, skip the channel (the CLI then gets its clear "desktop core owns the lock, channel unavailable" message), and the core starts normally. Add a test that forces an endpoint-publication failure and asserts the core still becomes ready.
4. Update `docs/SECURITY.md` to match (inheritance-based ACL on Windows, token as the gate, fail-open channel).
5. Remove the round-7 SID code and its test assertions that require explicit ACEs; keep a test that the token is required.

Typecheck, lint and prettier; no commit.
