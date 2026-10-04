# INT-N1 round 6: Providers row polish (no commit)

The orchestrator captured `settings-providers-light-1024x680.png` from your round-5 code. It's one row per provider now, but it's still below the v2 bar:
1. **Header row collapsed:** it renders as "StatusManage keyTestEnabled" with no gaps, and the headers don't line up with the columns. Either align a real grid (the header uses the same column template as the rows) or drop the header entirely; action buttons and a labelled toggle don't need column headings. Prefer dropping it.
2. **Names truncated** ("OpenRouter (fre...", "Mistral (Ex...") while the actions take most of the width. The provider name must never truncate at 1024x680; the note may clamp to 1-2 lines. Give the name and note column priority (`minmax(0,1fr)`) and shrink the actions: `Manage key` stays a compact ghost button with icon and label (size sm); `Test` becomes an icon button with tooltip and accessible name "Test <provider>" (keep the e2e accessible names working); the status badge sits next to the name or on the right with fixed width.
3. Vertical rhythm on the 4 px grid; the row height should be about 56-64 px.

Check it against `design/DESIGN-v2.md`. Typecheck, lint and prettier; no commit. Don't touch `apps/desktop/scripts/shots-v2.mjs` (QA is editing it).
