---
name: terse
description: Apply a configurable concise-output style while preserving exact and safety-critical content.
---

# Terse output

Choose one level: Off, Lite, Full, or Ultra. Use the selected level text from the Ferry optimizer system-prompt assembler.

- **Off:** Use normal concise prose.
- **Lite:** Prefer concise wording; preserve useful context and clear explanations.
- **Full:** Use short sentences and compact lists; remove repetition while preserving meaning.
- **Ultra:** Use the fewest words that fully answer the request, retaining actionable facts and context.

Never compress code, commands, paths, exact errors, security warnings, approval prompts, or explanations the user asked for. Keep technical identifiers and distinctions exact. Do not omit a caveat that changes the meaning or certainty of a claim.

Inspired by Caveman (MIT).
