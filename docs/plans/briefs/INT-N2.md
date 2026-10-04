# Integrate N2 (gateway protocols) on top of N1 (no commit)

Read `docs/plans/briefs/N-common.md` (rules, AGPL idea-only rule) and `docs/plans/briefs/N2-body.md` (the N2 spec). Worktree `C:\dev\ferry`, branch `int/n1-n2`: main + N1 (verified, green) + `origin/feat/n2` just merged (`git log -3`). N2 was written by an earlier Luna run, branched **before** N5 landed and before N1, and never verified. Git auto-merged everything except a doc.

Bar: N2 must work as specified **and** keep everything N3/N4/N5/N1 do on the gateway path. Audit and fix:
1. **N5 gateway key budgets:** tokens/min, tokens/day and concurrency caps with success-only counting must apply identically to `/v1/chat/completions`, `/v1/messages`, the new `/v1/responses` and the Gemini endpoints (both streaming and non-streaming), with each protocol's native error shape on 429. Cached-token pricing must flow through the canonical usage model.
2. **N3 mapping and overrides:** logical model names and gateway aliases resolve the same way for every inbound protocol; param strip/force and header overrides apply after canonical conversion, once.
3. **N4 and N1:** priority/weight, key affinity and per-key rotation apply to gateway requests from every protocol (the canonical layer must not bypass the router path the old endpoints used).
4. **`/v1/models`** lists what Codex and Gemini clients need.
5. **Codex end-to-end shape:** a `/v1/responses` streaming request in the exact form Codex CLI sends (tool calls, reasoning items, `response.completed` with usage) round-trips through the canonical layer; golden fixtures cover streaming tool calls and errors mid-stream.
6. `docs/GATEWAY.md`: document the new endpoints, how to point Codex CLI and Gemini clients at the Gateway, and the limits.

Tests for each point (unit plus gateway integration with the fake provider). Typecheck, lint and prettier; the orchestrator runs vitest and e2e. Report the semantic conflicts you found and how you resolved them.
