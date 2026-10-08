# Changelog

All notable changes to Ferry are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Ferry waits a few seconds for short per-minute limits instead of switching to a weaker model,
  keeps the model that started a task, and gives up on a provider that does not answer in 25 s.
- A run that already changed files now finishes with a warning instead of failing, and every run
  ends with a report: models, switches and why, waits, tokens, files and the requirement checklist.
- Requests with several requirements get a checklist that Ferry verifies before it finishes, and a
  `check_page` tool checks web pages in a real browser at phone and desktop widths.
- Failed requests are counted per provider and model; a provider that fails 5 different requests
  is paused with Resume, Check key and View failures actions.
- Caveman compression shortens older conversation and replies on free profiles to stretch limits.
- Messages you send while Ferry works join the running turn.
- What's new, a context strip above the composer (project, branch, changes), transcript width
  and motion settings, and Integrations in Settings.

### Changed

- Chats read like Claude Code: one quiet line per stretch of tool work, the scrollbar at the window
  edge, a round jump-to-latest button, real Markdown lists and single-surface code blocks.
- Settings are flat sections with grouped navigation; loading states show skeletons.

### Fixed

- Groq models no longer fail on their second step, the CLI can attach to an engine with large
  provider lists, and quota events no longer fire every second.

## [0.9.0-beta.71] - 2026-10-08

### Added

- "No profile" option: chats and Gateway keys can skip profiles and use a model you pick.
- Gateway keys can route across a hand-picked, ordered list of connected models.

### Changed

- Rebuilt Profiles settings: one profile at a time from a dropdown, plain-language sections,
  read-only built-ins with "Duplicate to customize".
- The model picker's details card is now a hover tooltip.

### Fixed

- "Get a key" opens the provider's page for every catalog provider.
- Dialog close buttons work when the dialog sits over the window title area.
- "Jump to latest" no longer appears when the latest message is already visible.

### Changed

- Merges to `main` publish a public `0.9.0-beta.N` pre-release. Installed beta
  builds check this channel at startup and every six hours, with automatic
  downloads enabled by default. Windows beta installers remain unsigned and may
  show a SmartScreen warning.

## [0.9.0-beta.38] - 2026-10-04

### Added

- Packaged CLI runtime bridges and smoke coverage for local-engine startup, Gateway, doctor, streaming, and app-core attachment.
- Regression coverage for title-bar overlay geometry, installer update preservation, and the collapsed navigation shell.

### Changed

- Refined the full-width title bar, collapsed rail, accessible navigation, themed dialogs, and shell captures.
- Preserve PATH and Explorer options across silent update passes while keeping normal uninstall cleanup.

### Fixed

- Resolve packaged CLI/runtime paths independently of the source checkout and keep the Theme submenu visible in shell captures.
- Place the drawer below the title bar and preserve update relaunch behavior.

## [0.9.0] - 2026-09-28

### Added

- Windows per-user installer and portable build, with optional CLI PATH and
  Explorer folder-menu integration.
- Beta update checks from the public GitHub Releases feed, with automatic
  downloads, restart-to-install, and an About settings page.
- Bundled `ferry` CLI, workspace-aware folder launch, and retained user data on
  uninstall unless removal is selected.
- First public beta packaging workflow and clean-install smoke coverage.

### Changed

- Released Ferry desktop and CLI as version 0.9.0 beta.
- Clarified provider, workspace, and data handling across the desktop and docs.
- Kept unsigned Windows releases explicit about SmartScreen and update-signature
  trade-offs.

### Fixed

- Improved packaged startup, native runtime dependency handling, workspace
  handoff, and settings recovery across recent releases.
