# MAIN-GREEN round 10: last failing test (no commit)

Round 9 is accepted. Gates: e2e 5/5, check 63/64. One failure left, in your round-4 integration test:
`apps/cli/test/client.test.ts > CLI client engine selection > uses one desktop-style core for CLI status, Gateway, and a streamed session run` -> `RpcError: Workspace path does not exist` (781 ms). Log: `.dev/runs/mg9b-check.log`.
Decide whether the test sets up its workspace incorrectly (for example a temp dir that isn't created, or a path resolved relative to the wrong process cwd over the channel) or the channel passes the CLI's cwd/workspace incorrectly to the desktop core. **The latter would be a real product bug**: `ferry run` in a project folder while the app is open must use that folder. Fix the right one, and if it's the product, add a test with a CLI cwd that differs from the core's cwd. Typecheck, lint and prettier; no commit.
