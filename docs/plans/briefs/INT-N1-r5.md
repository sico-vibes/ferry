# INT-N1 round 5: finish the Providers UI (no commit)

Round 4 is a clear improvement: no overflow, copy is right, no wall of primary buttons. Two gaps and one broken capture:

1. **Density:** at 1024x680 each provider takes two rows (name/note/status, then Manage key, Test and a toggle underneath), so only about 4 providers fit. Use one row per provider whenever the content column allows: name plus note on the left; status, toggle, Manage key and Test on the right. Stack only below a real breakpoint (container query on the section, not the window). The actions must still read as buttons (ghost with hover/focus states and an icon, e.g. lucide `KeyRound` / `PlugZap`) rather than plain text.
2. **Toggle meaning:** the toggle has no visible meaning. Give it an accessible name ("Enable <provider>") and a visible cue (tooltip or a small "On"/"Off" label), consistent with how other v2 settings label switches.
3. **Screenshot state broken:** the orchestrator ran `FERRY_SHOT_STATES=settings-provider-key-dialog,settings-providers pnpm --filter @ferry/desktop shots:v2`. `settings-providers` captured, but all 4 `settings-provider-key-dialog-*` failed with `page.evaluate: Error: Mock Ferry client is unavailable`. Seed the two keys through whatever mechanism the other shots-v2 states use (look at how existing states seed mock data) instead of a global that isn't exposed in this build. Log: `.dev/runs/shots2.log`.

Typecheck, lint and prettier; no commit.
