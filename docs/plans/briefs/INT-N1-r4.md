# INT-N1 round 4: Providers UI to the v2 bar (no commit)

Round 3 is accepted: combined with the main-green fixes, gates are 63/63 and e2e 5/5 (committed `f9d0cb2`). Now the UI. `design/screenshots/v2/settings-providers-light-1024x680.png` doesn't meet `design/DESIGN-v2.md`:

1. **Horizontal overflow:** at 1024x680 the providers table is wider than its card and the Test column is clipped. It must fit at 1024 px and degrade cleanly at narrower widths (stack or collapse secondary columns; no horizontal scroll).
2. **Too many primary buttons:** every row has a filled violet "Manage key". One primary action per view: row actions are secondary/ghost (or the whole row opens the dialog, with an explicit button for keyboard and screen-reader users). Keep exactly one Manage-key control per row (no duplicate controls), and keep the accessible names the e2e flows use.
3. **Copy conflict:** the card warns "Avoid multi-account workarounds, shared keys …" right above N1's multi-key feature. Rewrite the help text, and add a short note in the key dialog, so it's clear that multiple keys are meant for keys the user owns on one account (for example separate project keys); pooling several accounts to multiply free tiers breaks provider terms and Ferry doesn't support it. Keep it short and calm.
4. **Separation:** the table sits in an outlined card; v2 separates with tone and spacing, using hairlines (`--border`) at most. Match the other settings sections.
5. **Screenshot coverage:** add `shots-v2` captures for the Manage key dialog with 2+ keys (one healthy, one cooling down or disabled) and the Routing section visible, in light and dark, so this UI can be reviewed going forward.

Use v2 components only; lucide icons; no mojibake. Typecheck, lint and prettier; no commit. Report what changed and which screenshots to look at.
