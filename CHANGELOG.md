# Changelog

All notable changes to Ferry are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Merges to `main` publish a public `0.9.0-beta.N` pre-release. Installed beta
  builds check this channel at startup and every six hours, with automatic
  downloads enabled by default. Windows beta installers remain unsigned and may
  show a SmartScreen warning.

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
