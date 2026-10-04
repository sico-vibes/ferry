# Windows CI: path case in the lock-owner error (no commit)

Branch `int/n1-n2` in `C:\dev\ferry` (all local gates green). GitHub CI passes on Ubuntu, but Windows fails:
`apps/cli/test/client.test.ts > CLI client engine selection > fails clearly instead of starting a second local core on an owned database`:
`expected [Function] to throw error including 'Ferry core PID 8048 owns C:\Users\RUN...' but got 'Ferry core PID 8048 owns C:\Users\run...'`.
On the runner the temp dir is reached through an 8.3 short path (`RUNNER~1`) and its case differs from the resolved long path. Windows paths are case-insensitive, and the product may print any equivalent spelling. Fix it properly: the product prints the canonical long path (`fs.realpathSync.native`) for the data dir in that message, and the test builds its expectation from the same canonicalisation, comparing case-insensitively on win32. Check the CLI's other path-bearing messages and tests for the same pattern (the install smoke had 8.3 path bugs before). Typecheck, lint and prettier; no commit.
