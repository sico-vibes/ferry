# QA: diagnose the streamed-run assertion over the CLI to desktop-core channel

Repo `C:\dev\ferry-inst` (branch `fix/main-green`, uncommitted work in progress; **don't commit or stash**).
Failing test: `apps/cli/test/client.test.ts > CLI client engine selection > uses one desktop-style core for CLI status, Gateway, and a streamed session run`, which fails with `AssertionError: expected '{"type":"session.message","sessionId"...' to contain 'shared core stream'`. Run it alone: `./tools/pnpm.cmd --filter @ferry/cli exec vitest run test/client.test.ts -t "desktop-style core"`.

Determine whether this is (a) a **test bug** (wrong expectation about the output format, for example the text arriving in `session.delta` events rather than the final `session.message`, or the fake provider configured with different text) or (b) a **product bug** (deltas or the final message dropped or reordered over the local control channel compared with in-process).
- If (a): fix the test only, keeping the assertion's intent (the streamed text reaches the CLI), run it until it passes 3 times in a row, and report the diff.
- If (b): **don't change source**. Report the exact place where text is lost (file:line), with evidence (what the in-process path emits versus the channel path).
Leave no temporary edits behind besides an allowed test fix.
