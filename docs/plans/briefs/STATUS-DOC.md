# Bring the status docs up to date (docs only, no commit)

Branch `feat/cli-parity` in `C:\dev\ferry` now contains everything since the clean clone: `git log --oneline 42c04f2..HEAD` (N1 multi-key, N2 gateway protocols, main-green fixes plus installer PATH plus the CLI-to-desktop local control channel, beta.36, CLI parity, free-model consistency). Read `docs/STATUS.md`, `docs/plans/v0.11-fixes-and-gateway.md`, `docs/CLI.md`, `docs/GATEWAY.md`, `docs/PROVIDERS.md`, `docs/SECURITY.md` and the commit messages.

Update:
1. `docs/STATUS.md`: last-updated date 2026-10-04; v0.11 is **done** (Wave F, N1-N5, CLI parity, free consistency) with beta.36 as the first green release since N3-N5; replace the "Resume point" table with the current state (no WIP branches except `wave/p3-caching`, which is parked and must renumber its migration because 0004 is now `provider_key_entries`); refresh "Known gaps" (remove the fixed ones: Codex `/v1/responses` and the Ubuntu ACP race; keep or add real ones, for example the packaged TTI above target, P3 caching, catalog prices changing outside Ferry's control, free-tier coverage needing upkeep as providers change terms); list the remaining v0.10 items as next.
2. `docs/plans/v0.11-fixes-and-gateway.md`: status line set to complete, with commit references.
3. Check `README.md` feature bullets for anything now stale (multi-key, Codex via Gateway, CLI shares the desktop engine, PATH option) and fix it.
Keep the existing tone and structure; concise; no marketing language; no mojibake. Prettier on the changed files. No commit.
