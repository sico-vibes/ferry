# QA diagnosis: shell captures fail after Lane S (report; fix only test tooling)

Repo `C:\dev\ferry`, branch `feat/ui-shell` (uncommitted Lane S work: a new full-width 44 px title bar with `-webkit-app-region: drag`, new user menu, ConfirmDialog/TextPromptDialog replacing native dialogs; read `.dev/runs/lane-s/final.txt`). **Don't commit and don't change product source** (`apps/desktop/src`, `packages/*/src`); you may fix `apps/desktop/scripts/shots-*.mjs` if the script is at fault.

`./tools/pnpm.cmd shots:review shell` now fails most states with `locator.click: Timeout 30000ms exceeded` (titlebar-collapsed, confirm-dialog, session-idle, about-dialog, drawer-open, ...). Log: `.dev/runs/s-shots.log`. In the browser pane at a narrow width, the orchestrator also saw the layout apparently shifted (sidebar off-screen to the left, empty title strip, content cut off on the right), which may be horizontal overflow from the new title bar.

Find out, with evidence (Playwright trace or `elementFromPoint` at the click target, computed widths, `document.documentElement.scrollWidth` vs `innerWidth` at 1024 and 1440):
1. Why the clicks time out: is the target covered by another element (which one), not rendered, renamed (selector stale), or is the page overflowing?
2. Whether the page has horizontal overflow at 1024x680 and 1440x900 and in a narrow window (800 px), and which element causes it.
3. Classify each failure as **product bug** (report file:line and the evidence) or **script bug** (fix it).
Then rerun `shots:review shell` and report which states capture and which still fail, with causes.
