# Ferry documentation

This folder is the canonical home for maintained Ferry documentation. Start here to find user guides, technical references, current release evidence, plans, and research. The repository root and design folder retain documents that tooling or contributors require at fixed paths; this index links to them rather than moving them.

For a complete file-by-file catalog, see the [documentation inventory](INVENTORY.md).

## Start here

- [Project README](../README.md) — product overview, installation, first run, privacy, and CLI quickstart.
- [Current status and release evidence](STATUS.md) — what this checkout has verified, what remains in progress, known limits, and how to update this record.
- [Support matrix](SUPPORT-MATRIX.md) — provider and client support labels, evidence scope, and certification commands.
- [CLI connections](CLI-CONNECTIONS.md) — installed Codex, Claude Code, and OpenCode setup and use.
- [CLI commands](CLI.md) — terminal commands, flags, and exit behavior.
- [Troubleshooting](TROUBLESHOOTING.md) — common setup, routing, and data questions.

## Product and technical guides

- [Architecture](ARCHITECTURE.md)
- [Routing](ROUTING.md)
- [Gateway](GATEWAY.md)
- [Providers](PROVIDERS.md)
- [Protocol](PROTOCOL.md)
- [Security](SECURITY.md) and [security review](SECURITY-REVIEW.md)
- [Delegation](DELEGATION.md)
- [OpenCode Zen CLI implementation note](OPENCODE-ZEN-CLI.md)
- [Optimizers](OPTIMIZERS.md)
- [Performance](PERFORMANCE.md)
- [Preview](PREVIEW.md) and [mock tour](MOCK_TOUR.md)
- [Cloud mode](cloud/CLOUD-MODE.md)
- [Keyboard shortcuts](user/keybindings.md)

## Plans and research

- [Plans and implementation briefs](plans/) — working plans and historical task briefs. A plan records intent or progress at the time it was written; it is not proof that the current checkout contains or passes that work. Check [current status](STATUS.md) for release claims.
- [Research notes](research/) — provider, routing, and product investigations. Treat availability, pricing, and third-party behavior as time-sensitive; verify them before relying on a note.
- [Cloud schema](cloud/schema/) — proposed or versioned SQL schema artifacts.

## Contributor references

- [Brief template](dev/templates/brief.md)
- [QA brief template](dev/templates/qa-brief.md)
- [Design specification](../design/DESIGN-v2.md) — authoritative for UI implementation.
- [Agent instructions](../AGENTS.md) and [Claude instructions](../CLAUDE.md) — repository workflow and agent constraints.

Other documents remain beside the code or at fixed repository paths when they serve a local purpose: [release history](../CHANGELOG.md), [license](../LICENSE), [third-party notices](../NOTICE), provider/catalog source attributions, benchmark fixtures and instructions, evaluation results, and bundled [agent skills](../skills/). Design references and screenshots also remain under `design/` because the design specification and UI workflows use those paths.

## Keeping documentation current

When a code change alters a user-visible command, support claim, limitation, or release gate, update the relevant guide in the same change. Keep release-specific evidence and open work in [STATUS.md](STATUS.md), and provider/client labels and evidence scope in [SUPPORT-MATRIX.md](SUPPORT-MATRIX.md). Link to those records instead of copying their changing status into several pages. Mark plans and research as snapshots, cite the code or test that supports implementation claims, and distinguish fixture coverage from live account verification. Validate relative Markdown links after moving or renaming a document.
