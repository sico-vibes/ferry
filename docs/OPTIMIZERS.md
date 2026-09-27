# Optimizers

Optimizer features aim to reduce repeated tool-output tokens while preserving access to source material. There are no benchmark results in this checkout; savings and quality impact are **not yet measured**. See the optimizer implementation and tests for exact current filters (updating).

- **Tool-output filters:** trim or summarize repetitive command/search output and retain useful lines. Filters must not be treated as a substitute for checking the underlying files.
- **Recovery handles:** large output can be stored behind a short handle so the agent can retrieve selected lines or grep matches later. Handles are temporary/in-memory in the current implementation; they are not durable archival storage.
- **Terse modes:** Off, Lite, Full, and Ultra ask the model for progressively shorter prose. Code, commands, paths, exact errors, security warnings, approvals, and explicitly requested explanation are protected from compression.
- **Context hygiene / compaction:** (updating) compaction behavior and thresholds are still being finalized. Do not assume a fixed token saving or that all prior context remains verbatim.

No fixed token-saving percentage is claimed. A benchmark script/result is not yet present.
