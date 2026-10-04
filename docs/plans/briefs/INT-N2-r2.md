# INT-N2 round 2: gateway tests red (no commit)

Gates on your round-1 tree: e2e **5/5 pass**, check-text and prettier pass, `check:tasks` 62/63. Only `@ferry/gateway#test` fails, with 5 tests:
- `canonical.test.ts > normalizes Codex Responses reasoning, function calls, and tool results`
- `canonical.test.ts > normalizes OpenAI Chat, Anthropic Messages, Responses, and Gemini requests` (`expected [ {role:'user',…}, …(3) ] to match object [ {role:'user',…}, …(2) ]`: an extra message is produced)
- `gateway.test.ts > applies token budgets to both stream modes for every inbound protocol`
- `gateway.test.ts > rejects unsupported images and maps SDK prompt errors to HTTP 400` (`expected 200 to be 400`)
- `gateway.test.ts > serves Responses and native Gemini requests, including their SSE forms`

Log: `.dev/runs/int-n2-check.log`. Decide for each whether the code or the test expectation is wrong, using the real client wire formats (Codex CLI Responses, OpenAI, Anthropic, Gemini) as ground truth, not whichever makes the test pass. Explain each call in the report. Never turn a client error that should be a 400 into a 200. Typecheck, lint and prettier; no commit.
