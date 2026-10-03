# Integrate N1 (multi-key providers) onto current main (no commit)

Read `docs/plans/briefs/N-common.md` first (rules), then `docs/plans/briefs/N1-body.md` (the N1 spec).

State of this worktree (`C:\dev\ferry`, branch `int/n1-n2`): branched from `main` (`42c04f2`, which has Wave F + N3/N4/N5), and `origin/feat/n1` has been merged in **with one unresolved conflict**: `apps/desktop/src/renderer/app/ProviderKeyDialog.tsx`. `feat/n1` was branched before the last two N3-N5 fix rounds, so its code may also silently disagree with main in non-conflicting files.

Tasks:
1. Resolve the `ProviderKeyDialog.tsx` conflict. Keep **both**: main's single `Manage <provider> key` dialog with its Routing section (N4 priority/weight, key affinity) and N1's multi-key management (add/remove/reorder keys, per-key health/status, auto-disable toggle). One dialog, one primary action, v2 components, `design/DESIGN-v2.md` rules. Do not reintroduce a second "Manage key" button on `ProviderCard`.
2. Audit the auto-merged files for semantic conflicts with N3/N4/N5 on main, especially: N4 key/account affinity must now pick among N1's per-key entries (affinity to a key index, falling back when that key is cooling down or disabled); N5 cached-token pricing and gateway key budgets are unaffected by provider-key rotation; `model-discovery.ts` keeps main's F1 failure backoff (do not reintroduce catalog-model merging into routing; see the RF-3 note in `docs/plans/v0.11-fixes-and-gateway.md`). Migration `0004_provider_key_entries.sql` is the next free number on main; keep it, ensure it ships in all build targets, and that existing single-key users are migrated as key index 0 from the OS keyring without losing their key.
3. Mock client (`packages/client/src/mock`) and e2e flows: update any flow selectors that the merged dialog changes (`apps/desktop/scripts/e2e*.mjs`, the Electron smoke opens `Manage OpenAI API key`; keep that dialog name working).
4. Typecheck, lint and prettier for the affected packages. Add or adjust unit tests for the affinity-with-multi-key behaviour. The orchestrator runs vitest, check and e2e outside the sandbox.

Report: the conflict resolution, every semantic fix you made outside the conflict file, and anything left uncertain.
