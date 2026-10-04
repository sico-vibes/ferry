# INT-N1 round 7: key dialog polish (no commit)

Round 6 is accepted: the Providers rows look right. QA fixed the dialog capture (`apps/desktop/scripts/shots-v2.mjs`; keep their change). Review `design/screenshots/v2/settings-provider-key-dialog-dark-1024x680.png`. Remaining gaps:
1. **Raw enums shown to users:** key status renders as "ok" / "disabled". Use the same status badge component and wording as the provider rows ("Healthy", "Cooling down 2m", "Disabled", "Invalid", ...), next to the key name, with the usage line separate. Numbers formatted with the locale (12,400 tokens).
2. **Ambiguous key actions:** "On"/"Off" look like buttons, not state; "Up" is cryptic. Per key: a labelled switch ("Enabled", accessible name "Enable <key label>"); reorder with icon buttons "Move up" / "Move down" (lucide `ArrowUp`/`ArrowDown`, tooltips, disabled at the ends); Remove as a ghost destructive icon button with confirmation. Keep the e2e accessible names working or update the e2e steps to the new names without loosening assertions.
3. **Dialog intro:** "Set the provider routing tier and relative share, then manage its key." is jargon in the wrong order. Lead with keys: something like "Add, order and pause keys for OpenAI. Ferry rotates between enabled keys in this order." Routing gets its own one-line helper (it already has one).
4. Make sure "Add key" is visible without scrolling at 1024x680 (or pinned in the dialog footer as the single primary action).

Typecheck, lint and prettier; no commit.
