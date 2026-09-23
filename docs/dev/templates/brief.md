# Brief <TaskID> — <title>

You are the implementer. Read `AGENTS.md` first. You will NOT commit; the orchestrator will.

<goal>
One or two sentences: what exists when you're done.
</goal>

<current_state>
What already exists (packages, files, APIs) that this task builds on.
</current_state>

<scope>
Exact files/packages to create or modify, and what goes in each.
</scope>

<do_not_touch>
Files and areas out of scope.
</do_not_touch>

<interfaces>
Types/signatures to honor (pasted verbatim).
</interfaces>

<design>
UI tasks only: DESIGN.md sections to follow (e.g. §2 tokens, §4.2 sidebar) and the reference crops to OPEN with your image viewer:
- design/reference/crops/<name>.png
Numbers in DESIGN.md are authoritative. Use tokens only — no raw color literals.
</design>

<acceptance>
- Observable, checkable criteria.
</acceptance>

<gates>
pnpm install && pnpm check
(+ task-specific commands)
</gates>

<report>
Summary · files touched · decisions not specified by the brief · deviations · last lines of gate output.
</report>
