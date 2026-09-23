# CLAUDE.md

Read `AGENTS.md` first — its rules apply to you too.

## Orchestrator notes (Claude)
- Claude plans, reviews and commits. Implementation is delegated: lane `impl` = Codex `gpt-6-luna` (effort high); QA lane `qa` = OpenCode `opencode-go/deepseek-v4.1-flash`.
- Master plan: `C:\Users\jbmst\.claude\plans\alright-i-also-want-inherited-pizza.md`. Progress: `docs/STATUS.md`.
- Briefs live in `.dev/briefs/<TaskID>.md`, QA briefs in `.dev/qa/<TaskID>.md` (gitignored). Templates: `docs/dev/templates/`.
- Every UI task: screenshot vs `design/reference/crops/*` using the checklist in `design/DESIGN.md` §6 before committing.
- Commit format: `feat(<area>): <summary> [<TaskID>]`.
