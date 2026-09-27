# Coding agents — what open-source agents do to make weak/free models work

**Research date: 2026-09-27.** Desk review plus direct source reading from GitHub at the
ref named per project. No API keys were used and no network calls were made from Ferry
code. Every claim is cited to a source URL, a file path, and (where the fetch exposed them)
line numbers; claims taken only from a README/site are marked **claimed (docs)** and things
I could not determine from code or published docs are marked **unknown**.

> Citation note: raw `raw.githubusercontent.com` fetches do not expose line numbers, so most
> citations below are `path` + function/identifier + a quoted snippet. Line numbers are given
> only where the fetched content actually showed them. Repo paths redirect: `sst/opencode` →
> `anomalyco/opencode` (branch `dev`), `sst/models.dev` → `anomalyco/models.dev` (branch
> `dev`), `block/goose` → `aaif-goose/goose`, `All-Hands-AI/OpenHands` → `OpenHands/OpenHands`
> (Python engine moved; see the repo-state caveats under the roster table),
> `yetone/avante.nvim` → `avante-corp/avante.nvim`.

Companion to `docs/research/routing-comparison.md` (routers) and
`docs/research/free-providers.md` (provider limits). This document covers the **agent loop,
tool/edit format, context economy, model metadata and safety UX** — not the provider
resilience layer.

---

## Ten-line summary (plain English)

1. Every agent has the same problem Ferry has: free/weak models call tools badly, so each
   project invents a **text encoding of tool calls** and repairs the output afterward.
2. Aider's answer is **edit formats chosen per model** (diff / whole / udiff / patch /
   architect+editor) plus a bounded "reflection" retry when an edit does not match.
3. Cline/Roo's answer is an **XML tool format** parsed while streaming, with partial blocks
   passed through; Roo has since switched to native tool calling only.
4. Gemini CLI, Crush, OpenCode, Roo and Zed all fall back to **layered fuzzy string-replace**
   (`old_string`/`new_string`) with model-facing "here is what the file really looks like"
   repair hints when the exact match fails.
5. Goose and OpenHands ship the strongest **text/JSON tool shims** (marker parsing, JSON
   repair, alias resolution, a small "interpreter" model for tool-less models).
6. Context is managed with **compaction/summarization tiers** (Gemini 50%/30%, OpenHands
   condenser pipeline, OpenCode turn-tail pruning, Codex 90% auto-compact) and hard output
   truncation limits.
7. Model capability is **per-model metadata** almost everywhere (Aider YAML, models.dev,
   Codex `ModelInfo`, Void's `VoidStaticModelInfo`, OpenHands `ModelFeatures`).
8. Free-model UX is uniform: BYOK + OpenRouter `:free` + Ollama/LM Studio + custom
   OpenAI-compatible base URLs; cost/limit display; architect/editor splits.
9. Safety is converging on **orthogonal axes**: sandbox mode, approval policy, and plan mode
   (Codex is the cleanest; Gemini's `DEFAULT/AUTO_EDIT/YOLO/PLAN` is the clearest enum).
10. Ferry should import a model-capability registry, adopt per-model edit/tool formats with
    repair + a planner/editor split, and layer compaction — all already implied by its
    `catalog/router/optimizer/workspace/agent` package plan.

---

## Projects surveyed (license)

| Project | Repo | Ref read | Lang | License (verified `LICENSE*`) |
|---|---|---|---|---|
| Aider | `Aider-AI/aider` | `main` | Python | **Apache-2.0** (`LICENSE.txt`) |
| Cline | `cline/cline` | `main` + tag `v3.0.0` | TS | **Apache-2.0** (repo metadata) |
| Roo Code | `RooCodeInc/Roo-Code` | `main` (archived 2026-05-15) | TS | **Apache-2.0** (`LICENSE`) |
| Kilo Code | `Kilo-Org/kilocode` | `main` | TS | **MIT** root; `packages/kilo-vscode` **Apache-2.0** |
| OpenCode | `sst/opencode` → `anomalyco/opencode` | `dev` | TS | **MIT** (`LICENSE`) |
| Crush | `charmbracelet/crush` | `main` | Go | **FSL-1.1-MIT** (`LICENSE.md`) |
| Goose | `block/goose` → `aaif-goose/goose` | `main` | Rust | **Apache-2.0** |
| OpenHands | `OpenHands/OpenHands` | tag `0.55.0` | Python | **MIT** (`LICENSE`) |
| Continue | `continuedev/continue` | `main` | TS | **Apache-2.0** |
| Plandex | `plandex-ai/plandex` | `main` | Go | **MIT** (`LICENSE`) |
| gptme | `gptme/gptme` | `master` | Python | **MIT** (`LICENSE`) |
| Codex CLI | `openai/codex` | `main` | Rust | **Apache-2.0** (`LICENSE`) |
| Qwen Code | `QwenLM/qwen-code` | `main` | TS | **Apache-2.0** (`LICENSE`) |
| Gemini CLI | `google-gemini/gemini-cli` | `main` | TS | **Apache-2.0** (`LICENSE`) |
| Zed agent | `zed-industries/zed` | `main` | Rust | **GPL-3.0-or-later** (per-crate `Cargo.toml`) |
| avante.nvim | `yetone/avante.nvim` → `avante-corp/avante.nvim` | `main` | Lua | **Apache-2.0** (`LICENSE`) |
| Void | `voideditor/void` | `main` (archived 2026-06-02) | TS | **Apache-2.0** additions + MIT VS Code |
| SWE-agent | `SWE-agent/SWE-agent` | `main` | Python | **MIT** (`LICENSE`) |
| mini-swe-agent | `SWE-agent/mini-swe-agent` | `main` | Python | **MIT** (`LICENSE.md`) |

> **Repo-state caveats that changed the findings (important):**
>
> - **OpenHands `main` is now a TypeScript/Electron monorepo.** The classic Python engine is
>   at the last Python tag, **`0.55.0`**; all OpenHands citations below use that blob ref.
>   The engine now lives in the separate `software-agent-sdk` project (not read → **unknown**).
> - **Roo Code is archived read-only (2026-05-15)** and current `main` is **native tool
>   calling only** — the XML parser was removed. Cline's XML parser citations use tag
>   `v3.0.0`; current Cline moved parsing into the `sdk/packages/*` monorepo (not enumerated
>   → partially **unknown**).
> - **Void is archived/deprecated (2026-06-02)** but its AI source is open and readable.
> - **Crush is FSL-1.1-MIT**, not a plain OSS license: source-available, converts to MIT
>   after two years per release. Ferry may read it but should not vendor it into an MIT core.

---

## 1. Tool calling for weak models

The convergent pattern: **one logical tool API, several wire encodings, chosen per model,
with tolerant parsing and a bounded repair loop.** No project trusts a weak model's tool
call on the first try.

### 1.1 Aider — edit formats as the tool protocol

Aider has **no active native-tool/function edit coder**; its "tool calling" is prompt-encoded
text. The formats are registered as coder classes and `--edit-format` choices are derived from
them (`aider/coders/__init__.py`; `aider/args.py` `edit_format_choices`).

| `edit_format` | Class | Meaning |
|---|---|---|
| `diff` | `EditBlockCoder` | SEARCH/REPLACE blocks |
| `diff-fenced` | `EditBlockFencedCoder` | SEARCH/REPLACE inside a fence |
| `whole` | `WholeFileCoder` | rewrite the file |
| `patch` | `PatchCoder` | OpenAI-style `*** Begin Patch` |
| `udiff` / `udiff-simple` | `UnifiedDiffCoder*` | unified diff |
| `architect` | `ArchitectCoder` | planner+editor split |
| `editor-diff` / `editor-whole` / `editor-diff-fenced` | `Editor*Coder` | editor half of the split |

- Per-model selection is data-driven. `ModelSettings` (`aider/models.py`) is the schema and
  `aider/resources/model-settings.yml` is the data. Verified fields: `edit_format`,
  `use_repo_map`, `weak_model_name`, `editor_model_name`, `editor_edit_format`, `lazy`,
  `overeager`, `reminder` (`sys`/`user`), `examples_as_sys_msg`, `extra_params`,
  `cache_control`, `caches_by_default`, `use_system_prompt`, `use_temperature`, `streaming`,
  `reasoning_tag`, `system_prompt_prefix`, `accepts_settings`. Example entries:
  `gpt-4.1: edit_format: diff, reminder: sys, examples_as_sys_msg: false`;
  `grok-3-mini-beta: edit_format: whole`; `o1: edit_format: architect` (in one entry) vs
  `edit_format: diff` elsewhere; `system_prompt_prefix: "Formatting re-enabled. "` for the
  o1/o3/o4 families.
- **Free/weak models are first-class in the same file**: `openrouter/deepseek/deepseek-r1:free`
  → `edit_format: diff, use_repo_map: true, examples_as_sys_msg: true, caches_by_default: true`;
  `openrouter/google/gemma-3-27b-it:free` → `use_system_prompt: false`.
- **Malformed-edit repair** (`aider/coders/editblock_coder.py`, read in full): `apply_edits`
  collects failed blocks and raises `ValueError` with `# N SEARCH/REPLACE block(s) failed to
  match!`, then `## SearchReplaceNoExactMatch: ...`, a `find_similar_lines` **"Did you mean to
  match some of these actual lines?"** hint, and an "The REPLACE lines are already in …!" check.
- **Tolerant matching** in the same file: `replace_most_similar_chunk` tries exact → uniform
  leading-whitespace outdent (`replace_part_with_missing_leading_whitespace`) → drop a spurious
  leading blank line ("GPT sometimes adds them spuriously (issue #25)") → `try_dotdotdots`
  (elided `...` regions). A `replace_closest_edit_distance` fuzzy matcher (SequenceMatcher
  threshold 0.8) is **dead code** (it sits after an unconditional `return`).
- **Bounded retry**: `aider/coders/base_coder.py` treats failures as "reflections" —
  `max_reflections = 3`, then "Only 3 reflections allowed, stopping." (`num_reflections = 0`,
  `max_reflections = 3`). `--auto-lint` (default **True**) and `--auto-test` (default False)
  feed lint/test errors back through the same `reflected_message` path
  (`base_coder.py:1599–1623`), as does a file-mention check (`:1560–1567`).
- **Latent function-calling**: `Coder.functions` exists and is schema-validated, and
  `parse_partial_args` repairs truncated JSON by appending `]}`, `}]}`, `"}]}`. But the only
  function-edit coder (`single_wholefile_func_coder`) is **commented out** in
  `aider/coders/__init__.py`, so shipped modes are text-only.

### 1.2 Cline / Roo Code — XML format, streaming parser, then native-only

- **The canonical weak-model XML format** (Cline `v3.0.0`, `src/core/prompts/system.ts`):
  tool name in tags, each parameter in its own tag, **one tool per message**:
  ```
  <tool_name>
  <parameter1_name>value1</parameter1_name>
  </tool_name>
  ```
  `replace_in_file` is documented as SEARCH/REPLACE with exact-match / first-match-only /
  empty-REPLACE-deletes rules, plus a `write_to_file` vs `replace_in_file` decision section.
- **The streaming partial-block parser** (`src/core/assistant-message/parse-assistant-message.ts`;
  identical in Roo `v3.0.0`, confirmed by direct read). It is a single-pass char accumulator:
  a param ends only when the accumulated suffix equals `</paramName>`; a tool ends at
  `</toolName>` (`partial = false`); text before a tool is trimmed and the half-written
  `<tool` prefix is stripped. **Unclosed blocks are still yielded** at end-of-stream with
  `partial: true`, and there is a special `write_to_file` workaround that takes the substring
  between the **first** `<content>` and the **last** `</content>`.
- **Roo today is native-only.** `src/core/assistant-message/presentAssistantMessage.ts`:
  `"Invalid tool call: missing tool_use.id. XML tool calls are no longer supported."`
  `NativeToolCallParser.ts` parses **incomplete streaming JSON** with `partial-json`'s
  `parseJSON`, emitting a partial `ToolUse` immediately and finalizing with
  `finalizeStreamingToolCall`; malformed args throw
  `[NativeToolCallParser] Invalid arguments for tool '<name>'…`.
- **Error feedback is structured JSON, not text** (`src/core/prompts/responses.ts`):
  `toolError → {"status":"error",...}`, `toolDenied → {"status":"denied",...}`,
  `toolDeniedWithFeedback`, `tooManyMistakes → {"status":"guidance",...}`. Every `tool_use`
  gets exactly one `tool_result` (even rejections are `is_error: true`), and duplicate
  `tool_use_id`s are dropped.
- **Diff strategies** (`src/core/diff/strategies/multi-search-replace.ts`): a marker state
  machine that detects malformed/merged markers; regex SEARCH/REPLACE parsing with optional
  `:start_line:`/`:end_line:`; **`fastest-levenshtein` fuzzy matching** (default
  `fuzzyThreshold = 1.0`, `BUFFER_LINES = 40`, middle-out search); line-number stripping;
  indentation preservation; and `DiffResult.failParts` so some blocks apply while others fail.
- **Tool repetition guard**: a `ToolRepetitionDetector` rejects identical consecutive calls.
- **Kilo is a hard filter, not a fallback** (`packages/kilo-gateway/src/api/models.ts`): models
  whose OpenRouter `supported_parameters` exists and lacks `tools` are **skipped from the
  catalog** ("Kilo requires tool calling"); missing array = optimistically tool-capable. It
  maps `architecture.input_modalities → attachment`, `supported_parameters → reasoning/
  temperature/tool_call`, and derives `max_completion_tokens`.

### 1.3 OpenCode — layered fuzzy replace (sourced from Cline + Gemini CLI)

- `packages/opencode/src/tool/edit.ts` takes `{filePath, oldString, newString, replaceAll}`
  and runs an **ordered list of replacers**: `SimpleReplacer`, `LineTrimmedReplacer`,
  `BlockAnchorReplacer`, `WhitespaceNormalizedReplacer`, `IndentationFlexibleReplacer`,
  `EscapeNormalizedReplacer`, `TrimmedBoundaryReplacer`, `ContextAwareReplacer`,
  `MultiOccurrenceReplacer`. `BlockAnchorReplacer` uses first/last-line anchors +
  Levenshtein middle-line similarity with `SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65`
  and `MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65`, guarded by
  `isDisproportionateMatch(search, oldString)`. A code comment credits **Cline's
  `diff-06-23-25.ts` and Gemini CLI's `editCorrector.ts`** as the source of the approaches.
- An alternate freeform `apply_patch` tool exists (`tool/apply_patch.ts` + `.txt`).
- **Malformed arguments become a model-facing message** (`tool/tool.ts`):
  `InvalidArgumentsError` → "The `<tool>` tool was called with invalid arguments: `<detail>`.
  Please rewrite the input so it satisfies the expected schema."; tools may override via
  `formatValidationError`.
- **Per-provider message repair** (`provider/transform.ts` `normalizeMessages`): sanitizes
  lone UTF-16 surrogates; drops empty text/reasoning parts for Anthropic/Bedrock; scrubs
  tool-call IDs for `claude` (`[^a-zA-Z0-9_-] → _`) and Mistral (strip non-alnum, 9 chars,
  `padEnd(9,"0")`); **injects a synthetic assistant `"Done."`** between a `tool` message and
  a following `user` message for Mistral ("tool messages cannot be followed by user
  messages"); forces an assistant `reasoning` part for DeepSeek. `unsupportedParts()`
  converts image/file parts to a text error when the model lacks that modality.
- Per-model **system prompts** (`session/system.ts`) switch on `model.api.id`
  (`anthropic`, `beast` for gpt/o-series, `gemini`, `kimi`, `trinity`, `meta`, …).
- Prompt-cache controls are injected per provider in `applyCaching`.

### 1.4 Crush — exact-then-whitespace-normalized, with diagnostics hints

- `internal/agent/tools/edit.go`: `EditParams{file_path, old_string, new_string, replace_all}`.
  Exact match first; if not `replace_all` and multiple matches, it errors
  "old_string appears multiple times… provide more context… or set replace_all to true";
  on exact miss it calls `normalizedReplace`. Enforces **read-before-edit** via
  `internal/filetracker`: "you must read the file before editing it. Use the View tool first"
  and a stale check ("file %s has been modified since it was last read"). LSP diagnostics are
  appended to the tool result.
- `internal/agent/tools/edit_whitespace.go`: `findNormalizedMatches` collapses whitespace runs
  and requires whole-line matches; `normalizedReplace` re-indents to the file's style
  (`detectIndentUnit`/`measureDepth`); `diagnoseMismatch` emits a self-correction hint that
  **visualizes whitespace** (`→` tab, `·` space), and `diagnoseBestLineMatch` shows the
  closest window.
- `edit.md` steers strong models to semantic edits (`lsp_replace_symbol`, `lsp_rename`) and
  `write` for large edits. Tools are exposed through `charm.land/fantasy` (native function
  calling); **no text/XML shim was found** (unknown/none).

### 1.5 Goose — the strongest tool shim (for tool-less models)

- `crates/goose/src/providers/toolshim.rs` is the reference implementation of "make a
  tool-less model call tools":
  - Token markers `TOOL_CALLS_SECTION_BEGIN/END`, `TOOL_CALL_BEGIN`, `TOOL_CALL_ARGUMENT_BEGIN/END`,
    `TOOL_CALL_END`.
  - `parse_tokenized_tool_calls_with_status`, `parse_inline_json_tool_calls`, and
    `resolve_tool_name` (tries `functions.` prefix, `name:index`, dotted `__`, suffix match).
  - **JSON repair**: `parse_json_value_tolerant` retries after
    `escape_invalid_backslashes_in_json_strings`.
  - `OllamaInterpreter` calls Ollama `/api/chat` with a **structured-output JSON schema**
    (`tool_calls[{name,arguments}]`, default model `mistral-nemo`); `LocalInterpreter` uses
    llama.cpp. Env: `GOOSE_TOOLSHIM`, `GOOSE_TOOLSHIM_OLLAMA_MODEL`, `GOOSE_TOOLSHIM_BACKEND`.
  - `convert_tool_messages_to_text` rewrites `ToolRequest`/`ToolResponse` into text for
    providers that reject tool blocks; `modify_system_prompt_for_tool_json` instructs
    one-tool-at-a-time JSON.
- `crates/goose/src/agents/tool_schema_normalize.rs`: `normalize_input_schema` →
  `collapse_const_unions` folds `oneOf`/`anyOf` of string `const`s into
  `{type:"string", enum:[...]}` and prunes unused `$defs`. Doc comment: schemars output is
  "~9x larger … and rejected outright by strict validators (notably Moonshot's)."

### 1.6 OpenHands — mock function calling + XML-ish format

- `openhands/llm/llm.py` sets `mock_function_calling = not self.is_function_calling_active()`
  and converts messages both ways (`convert_fncall_messages_to_non_fncall_messages`,
  `convert_non_fncall_messages_to_fncall_messages`) with `stop` words.
- The shim wire format (`openhands/llm/fn_call_converter.py`):
  ```
  <function=example_function_name>
  <parameter=example_parameter_1>value_1</parameter>
  </function>
  ```
  `STOP_WORDS = ['</function']`; an in-context worked example is injected
  (`TOOL_EXAMPLES` for bash/str_replace_editor/browser/finish). Parsing uses
  `FN_REGEX_PATTERN = r'<function=([^>]+)>\n(.*?)</function>'` and
  `FN_PARAM_REGEX_PATTERN`; `_extract_and_validate_params` checks required/allowed params and
  coerces `integer`/`array`/`enum`; `_fix_stopword` repairs a missing `</function>`;
  `_normalize_parameter_tags` repairs `<parameter=name=value>`. Execution results are folded
  back with `TOOL_RESULT_REGEX_PATTERN = r'EXECUTION RESULT of \[(.*?)\]:\n(.*)'`.
- Native path: `codeact_agent/function_calling.py` `response_to_actions()` raises typed
  `FunctionCallValidationError`/`FunctionCallNotExistsError`.
- **Short descriptions for old OpenAI models**: `SHORT_TOOL_DESCRIPTION_LLM_SUBSTRS = ['gpt-4',
  'o3', 'o1', 'o4']` in `codeact_agent.py` (old 1k-char function-description limit).
- Tools: `tools/bash.py` (`command`, `is_input`, `timeout`, `security_risk`; persistent shell,
  `-1` = still running), `tools/str_replace_editor.py`
  (`view|create|str_replace|insert|undo_edit`), `tools/browser.py` (BrowserGym `bid`+`nav`).
- Capability source: `openhands/llm/model_features.py` glob patterns
  (`FUNCTION_CALLING_PATTERNS` includes `qwen3-coder*`, `deepseek-chat`, `kimi-k2-*`, …);
  `LLMConfig.native_tool_calling` overrides the derived flag.

### 1.7 Gemini CLI — per-model schemas + secondary-LLM edit fixer

- `packages/core/src/tools/tool-registry.ts`: `getFunctionDeclarations(modelId?)` calls
  `tool.getSchema(modelId)`, so **the tool schema is model-dependent**; discovered tools run
  as subprocesses with JSON on stdin (output capped at 10 MB).
- `packages/core/src/tools/edit.ts`: parameters `{file_path, old_string, new_string,
  allow_multiple?, instruction?, ...}` and a **four-tier replacement** —
  `calculateExactReplacement → calculateFlexibleReplacement → calculateRegexReplacement →
  calculateFuzzyReplacement` — with `FUZZY_MATCH_THRESHOLD = 0.1`,
  `WHITESPACE_PENALTY_FACTOR = 0.1`, skip if `old_string.length < 10`, and a complexity guard
  `sourceLines.length * old_string.length**2 > 400_000_000`.
- **Weak-model repair**: on failure it calls `FixLLMEditWithInstruction(...)` — a *secondary
  LLM* rewrites `old_string`/`new_string`, then retries; skipped for
  `.json/.ipynb/.jsonc/.json5` or when `getDisableLLMCorrection()`.
- **Anti-lazy guard**: `detectOmissionPlaceholders(params.new_string)` rejects new
  placeholders ("rest of methods …") not present in `old_string`.
- A dedicated **`-customtools` model variant** exists for models using custom tooling
  (`gemini-3.1-pro-preview-customtools`, `{ useCustomTools: true }`).

### 1.8 Roo/OpenCode/Gemini convergence

All three independently implement `old_string`/`new_string` edit tools with exact-first then
fuzzy matching and model-facing failure hints. This is now the de-facto standard; the
differences are the fuzzy algorithm and the repair message.

### 1.9 Jupyter-style and windowed editors (SWE-agent)

- SWE-agent's ACI uses **pluggable parsers** (`sweagent/tools/parsing.py`): `ActionParser`,
  `ThoughtActionParser` (last non-nested fenced block), `XMLFunctionCallingParser`
  (`<function=...>/<parameter=...>`, aliases `execute_bash→bash`, `finish→submit`),
  `FunctionCallingParser`, `JsonParser`, `BashCodeBlockParser`, etc.
  `FunctionCallingParser` raises `FunctionCallingFormatError` with codes
  `missing/multiple/invalid_command/invalid_json/missing_arg/unexpected_arg`, each with a
  tailored Jinja `error_message`.
- The windowed edit tool (`tools/windowed_edit_linting/config.yaml`) is line-based:
  ```
  edit <start_line>:<end_line>
  <replacement_text>
  end_of_edit
  ```
  and `tools/windowed/lib/flake8_utils.py` runs flake8 after each edit, **filtering
  pre-existing errors by line shift** (`_update_previous_errors`) so only new lint is reported.
- mini-swe-agent's default is a **single native `bash` tool**
  (`models/utils/actions_toolcall.py` `BASH_TOOL`); `parse_toolcall_actions` raises
  `FormatError` on no calls / bad JSON / wrong tool / missing command. The text fallback
  (`models/utils/actions_text.py`) uses `action_regex =
  r"```mswea_bash_command\s*\n(.*?)\n```"` and requires exactly one action.

### 1.10 Plandex — same intent, two encodings per model

- Roles are first-class (`app/shared/ai_models_roles.go`): `planner`, `coder`, `architect`,
  `summarizer`, `builder`, `whole-file-builder`, `names`, `commit-messages`,
  `auto-continue`.
- The cleanest weak-model switch (`app/server/model/name.go`): if
  `baseModelConfig.PreferredOutputFormat == shared.ModelOutputFormatXml` it uses an **XML
  prompt** and parses with `utils.GetXMLContent(content, "planName")`; otherwise it sends a
  **forced native function tool** (`toolChoice` on `prompts.PlanNameFn`) and JSON-unmarshals.
- Plans are constrained text (`prompts/planning.go`): numbered `### Tasks`, a
  comma-separated ``Uses: `path` `` list per task, an explicit `<PlandexFinish/>` sentinel, and
  "you must NOT implement any code in the planning phase."
- Edits use anchor comments, not unified diffs (`prompts/update_format.go`): preserve
  unchanged regions with `// ... existing code ...`, deletions with `// Plandex: removed code`,
  output wrapped in `<PlandexBlock lang="javascript" path="example.js"> … </PlandexBlock>`.
  Execution goes into a `_apply.sh` block run once (`prompts/apply_exec.go`).

### 1.11 gptme — three wire formats, JSON repair

- `gptme/tools/base.py`: `ToolFormat = Literal["markdown", "xml", "tool"]` with global
  `tool_format = "markdown"` and `toolcall_re = re.compile(r"^@([\w.]+)\(([\w\-:\.]+)\):\s*({.*)")`.
  - **markdown**: fenced code block whose lang resolves to a tool.
  - **xml**: `<tool-use><ipython>…</ipython></tool-use>` *and* Haiku's
    `<function_calls><invoke name="…">`; lxml with an `xml.etree` fallback.
  - **tool**: `@tool_name(call_id): {json}` with `find_json_end` brace-counting and
    `json_repair.loads`; matches inside fences are skipped.
- Tool declarations auto-derive a Python-signature schema; `as_function_subtoolspecs()`
  expands each `ToolFunction` into `<parent>.<function>` so tools work without IPython.
  `execute_msg()` parses `ToolUse.iter_from_content(...)` and emits paired error results for
  non-runnable calls (to avoid Anthropic 400s).

### 1.12 Codex CLI — one canonical freeform patch format

- `codex-rs/apply-patch/src/lib.rs` defines the grammar:
  ```
  *** Begin Patch
  *** Add File: <path>
  +line
  *** Update File: <path>
  *** Move to: <path>
  @@
   context
  -old
  +new
  *** Delete File: <path>
  *** End of File
  *** End Patch
  ```
  against a delta model `ApplyPatchFileChange::{Add,Delete,Update{unified_diff,move_path,
  new_content}}`; fuzzy matching for Unicode punctuation (EN DASH / NON-BREAKING HYPHEN);
  file moves; line-ending modes (`NormalizeToLf` vs `PreserveLineEndings`).
- Per-model tool exposure is data (`codex-rs/protocol/src/openai_models.rs`):
  `ApplyPatchToolType::Freeform`, `shell_type` (`UnifiedExec`/`Disabled`), `web_search_tool_type`,
  `tool_mode` (`Direct`/`CodeMode`/`CodeModeOnly`), `experimental_supported_tools`.

### 1.13 Qwen Code

- `packages/core/src/tools/edit.ts`: `{file_path, old_string, new_string, replace_all?}` with
  unique-match required unless `replace_all`; error taxonomy
  `EDIT_NO_OCCURRENCE_FOUND`, `EDIT_EXPECTED_OCCURRENCE_MISMATCH`, `EDIT_NO_CHANGE`,
  `ATTEMPT_TO_CREATE_EXISTING_FILE`; **prior-read enforcement** (`checkPriorRead`, pre-/post-read
  and pre-write TOCTOU checks); secret scanning; BOM/line-ending preservation; per-path
  permissions. Tool set is a Gemini-cli fork plus `enterPlanMode`/`exitPlanMode`,
  `create-sub-session`, `advisor`, `notebook-edit`, `cron-*`, `image-gen`.

### 1.14 avante.nvim — ReAct fallback + two-model fast-apply

- `lua/avante/llm_tools/init.lua` lists ~30 tools and dispatches via
  `M.process_tool_use(tools, tool_use, opts)`. Its header documents weak-model support:
  disable tools per provider with `providers = { claude = { disable_tools = true } }`.
  `providers/init.lua` reads `disable_tools` and `use_ReAct_prompt` (default **true** for
  gemini, vertex, ollama).
- `lua/avante/llm_tools/edit_file.lua` is a **two-model fast-apply**: the main model emits
  `{path, instructions, code_edit}` with `// ... existing code ...` markers; avante sends
  `<instructions>…</instructions><code>…</code><update>…</update>` to the **morph** provider
  (`morph-v3-large`, `MORPH_API_KEY`) which returns the replacement, then pipes into
  `str_replace`. Gated by `mode == "agentic" and behaviour.enable_fastapply`.

### 1.15 Void — explicit "can't call tools" mode

- `src/vs/workbench/contrib/void/common/modelCapabilities.ts`: `VoidStaticModelInfo` has
  `specialToolFormat?: 'openai-style' | 'anthropic-style' | 'gemini-style'` where **`null`
  means the model "can't call tools by default", and Void asks it to output XML in agent
  mode**. Fast Apply uses `<<<<<<< ORIGINAL … ======= … >>>>>>> UPDATED` blocks applied by
  `editCodeService` (docs-claimed but explicit). `supportsFIM` and `reservedOutputTokenSpace`
  are also per-model.

### 1.16 Custom-tool shims in Kilo and Gemini

- Gemini CLI's `-customtools` variant and avante's `disable_tools` are the same axis Ferry
  needs: a per-model **tool protocol selector** (`native | xml | react | none`) rather than a
  global switch.

---

## 2. Context economy

### 2.1 Repo maps and file selection

- **Aider `aider/repomap.py`** is the canonical repo map: tree-sitter tags via `grep_ast`
  (`*-tags.scm`, `Tag(rel_fname, fname, line, name, kind)`, `def`/`ref`), pygments
  backfill for languages whose query yields only defs; a `networkx.MultiDiGraph` with edge
  weight `mul * sqrt(num_refs)`; **PageRank with personalization** (chat files +
  `100/len(fnames)`, mentioned identifiers `*10`, ≥8-char snake/kebab/camel `*10`, leading
  `_` `*0.1`, >5 definers `*0.1`, chat-file referencer `*50`). Token budget:
  `target = min(max_map_tokens * map_mul_no_files, max_context_window - 4096)`; binary-search
  the ranked prefix within 15% error; approximate token count for text ≥200 chars.
  `--map-tokens` default = `max_input_tokens / 8` clamped `[1024, 4096]`; `0` disables.
  `--map-multiplier-no-files` default 2.0; `--map-refresh auto|always|files|manual`; with
  `--cache-prompts` the map refresh is forced to `files`.
- Plandex loads **only the files each subtask lists under `Uses:`** (`prompts/planning.go`),
  with `.plandexignore` and a `ContextTokenLimit`.
- avante.nvim uses a **ChromaDB RAG service** (`lua/avante/rag_service.lua`, Docker
  `quay.io/yetoneful/avante-rag-service:0.0.11` or native) with separate embedding
  (`text-embedding-3-large`) and LLM (`gpt-4o-mini`) models, `top_k=10`; plus structural
  context via `read_file_toplevel_symbols` and `read_definitions` (`lua/avante/repo_map.lua`).
- Continue has context providers (`core/context/index.ts` `BaseContextProvider`) and
  codebase indexing/embeddings (`core/indexing/`), plus autocomplete FIM
  (`core/autocomplete/`, `_streamFim(prefix, suffix, …)`).

### 2.2 Compaction / summarization triggers

| Project | Trigger/default | Mechanism |
|---|---|---|
| Aider | `summarizer.too_big(done_messages)` when appending current messages | weak-model first, then main model; `max_chat_history_tokens = min(max(max_input_tokens/16,1024),8192)`; recursion depth 3 (`aider/history.py`) |
| Roo | `autoCondenseContextPercent`; `TOKEN_BUFFER_PERCENTAGE = 0.1`; `MIN/MAX_CONDENSE_THRESHOLD = 5/100` | condense first, then sliding window `truncateConversation(messages, 0.5)`; non-destructive `truncationParent`/`condenseParent`; forced retry at 75% (`FORCED_CONTEXT_REDUCTION_PERCENT = 75`, `MAX_CONTEXT_WINDOW_RETRIES = 3`) |
| OpenCode | `COMPACTION_BUFFER = 20_000`; `isOverflow()` vs `usable()` | `select()` keeps a recent turn tail (`min(15_000, max(2_000, floor(usable*0.25)))`); `prune()` erases old tool outputs only past `PRUNE_PROTECT = 40_000` and if `> PRUNE_MINIMUM = 20_000`; summaries cap each tool output at `TOOL_OUTPUT_MAX_CHARS = 2_000` |
| Goose | `GOOSE_AUTO_COMPACT_THRESHOLD` else default; `usage_ratio = current_tokens/context_limit` | turn summary + optional **tool-pair summarization** (`GOOSE_TOOL_PAIR_SUMMARIZATION`, batch 10, cutoff `clamp(3*effective_limit/20_000, 10, 500)`); audience projection `is_agent_visible` |
| Codex | `auto_compact_token_limit() = context_window*9/10`; `usable = context*95%` | `run_manual_compact_task`/`run_inline_auto_compact_task` "install a fresh context window"; per-model `TruncationPolicyConfig` (bytes/tokens, fallback `bytes(10_000)`) |
| Gemini CLI | `DEFAULT_COMPRESSION_TOKEN_THRESHOLD = 0.5`, preserve `0.3` | two-phase "Probe" self-correction (`<state_snapshot>` then verify); rejects if compression inflates tokens; function-response budget 50 k; collapse old responses >2 KB, protect last 3 turns; retrieval tools exempt |
| OpenHands | `LLMSummarizingCondenser` `max_size=100`, `keep_first=1`, `max_event_length=10_000` | pipeline of condensers; target `max_size//2`; summarizer prompt sections (USER_CONTEXT, TASK_TRACKING, COMPLETED, PENDING, CURRENT_STATE, CODE_STATE…); **disables prompt caching** because a rolling summary breaks it |
| SWE-agent | `LastNObservations` (`n=5` in 0.7) | replaces elided observations; `CacheControlHistoryProcessor` sets ephemeral cache on last N; `max_observation_length = 100_000` |
| gptme | `should_auto_compact` + `MIN_SAVINGS_RATIO` | `score_sentence`/`compress_content`/`extract_code_blocks`; `pinned` and `ephemeral_ttl` message flags; summary helper truncates to 400 head + 400 tail tokens |

### 2.3 Output truncation and token budgets

- Roo `read_file`: `DEFAULT_LINE_LIMIT = 2000`, `MAX_LINE_LENGTH = 2000`, plus a semantic
  `indentation` mode; mentions are formatted to look like a `read_file` result.
- OpenHands `LLMConfig.max_message_chars = 30_000`.
- SWE-agent `max_observation_length = 100_000` chars; `execution_timeout=30`,
  `install_timeout=300`, `total_execution_timeout=1800`.
- mini-swe-agent: if `output | length >= 10000`, emit `<output_head>` 5000 + `<elided_chars>`
  + `<output_tail>` 5000.
- Codex appends `ToolResultLogConfig.max_bytes = 2048`.

### 2.4 Prompt caching

- Aider `ChatChunks.add_cache_control_headers()` attaches `{"type":"ephemeral"}` to the last
  message of the examples/system, repo and chat-files chunks; `--cache-prompts` enables it
  only for `cache_control: true` models; `--cache-keepalive-pings` warms the cache every ~5 min;
  `caches_by_default` marks providers (deepseek/fireworks) as cached without the flag.
- OpenCode `applyCaching()` per provider and `prompt_cache_key`/`promptCacheKey = sessionID`.
- Roo `modelInfoSchema` exposes `supportsPromptCache`, `promptCacheRetention: "in_memory"|"24h"`,
  `cacheWritesPrice`, `cacheReadsPrice`, `minTokensPerCachePoint`.
- OpenHands disables caching while summarizing (`from_config` sets `caching_prompt = False`).

---

## 3. Model capability data

### 3.1 Aider

- **`aider/resources/model-settings.yml`** = per-model edit behavior (fields verified above).
  **`aider/resources/model-metadata.json`** = litellm-style cost/capability map with fields
  including `max_input_tokens`, `max_output_tokens`, `supports_function_calling`,
  `supports_tool_choice`, `supports_parallel_function_calling`, `supports_response_schema`,
  `supports_vision`, `supports_pdf_input`, `supports_audio_input/video_input`,
  `supports_system_messages`, `supports_prompt_caching`, `supports_assistant_prefill`,
  `supports_reasoning`, `rpm`, `tpm`, `deprecation_date`, `source`.
- Selection: `configure_model_settings(model)` exact match then generic substring rules
  (`apply_generic_model_settings`); default `edit_format="whole"` if nothing matches; if the
  final format is `diff`, `use_repo_map` is forced true. `MODEL_ALIASES` maps short names
  (`sonnet`, `deepseek`, `flash`, `r1`, …). `ModelInfoManager` downloads litellm's
  `model_prices_and_context_window.json` (24 h cache) and falls back to litellm, then
  OpenRouter scraping.
- Free/local handling: `onboarding.try_to_select_default_model()` checks OpenRouter's
  `is_free_tier` and picks **`openrouter/deepseek/deepseek-r1:free`** for free accounts; an
  OpenRouter PKCE OAuth flow stores the key. Ollama sets
  `num_ctx = int(token_count(messages)*1.25) + 8192`; LM Studio needs a dummy key.

### 3.2 models.dev (verified schema)

- Repo `anomalyco/models.dev` (branch `dev`), **MIT**. Data is TOML per provider/model; the
  API is generated: `https://models.dev/api.json` (provider catalog),
  `https://models.dev/models.json` (provider-agnostic), `https://models.dev/catalog.json`.
- Verified Zod schema (`packages/core/src/schema.ts`): `Provider{id, env[], npm, api?, name,
  doc, models}`; `Model` fields include `attachment: bool`, `reasoning: bool`,
  `reasoning_options: [{type:"toggle"}|{type:"effort",values[]}|{type:"budget_tokens",min,max}]`,
  `tool_call: bool`, `interleaved`, `structured_output`, `temperature`, `knowledge`,
  `release_date`, `last_updated`, `modalities{input[],output[]}` (enum
  `text|audio|image|video|pdf`), `open_weights`, `limit{context,input,output}`, `status:
  alpha|beta|deprecated`, `cost{input,output,reasoning?,cache_read?,cache_write?}`, `benchmarks[]`.
- This is **the single best capability gate** for Ferry: `tool_call`, `attachment`, `modalities`,
  `limit.context/output`, `temperature`, `reasoning`, `cost`.

### 3.3 Codex CLI

- `codex-rs/models-manager/src/lib.rs` loads a bundled JSON catalog via
  `serde_json::from_str(include_str!("../models.json"))`.
- `ModelInfo` (`protocol/src/openai_models.rs`): `slug`, `display_name`,
  `default_reasoning_level`, `supported_reasoning_levels`, `shell_type`,
  `apply_patch_tool_type`, `web_search_tool_type`, `truncation_policy`,
  `context_window`/`max_context_window`, `auto_compact_token_limit`,
  `effective_context_window_percent` (95), `input_modalities`, `tool_mode`,
  `supports_search_tool`, `supports_reasoning_effort_updates`. Unknown slug fallback:
  `UnifiedExec`, `context_window = 272_000`, `truncation_policy = bytes(10_000)`.
- `ReasoningEffort = none|minimal|low|medium|high|xhigh|max|ultra|persistent|Custom(String)`.

### 3.4 Others

- **Void** `VoidStaticModelInfo` is the most complete single-record capability table:
  `contextWindow`, `reservedOutputTokenSpace`, `supportsSystemMessage: false|'system-role'|
  'developer-role'|'separated'`, `specialToolFormat`, `supportsFIM`, `reasoningCapabilities`
  (including `openSourceThinkTags`), `cost{input,output,cache_read?,cache_write?}`,
  `downloadable`. Its `providerReasoningIOSettings` handles `nameOfFieldInDelta:
  'reasoning_content'` (DeepSeek) and `needsManualParse: true` (Ollama `<think>` tags).
- **OpenHands** `ModelFeatures` globs; **SWE-agent** uses `litellm.supports_function_calling`
  + `litellm.model_cost` + a custom registry via `litellm.register_model`.
- **Roo** `packages/types/src/model.ts` `modelInfoSchema` (`maxTokens`, `contextWindow`,
  `supportsImages`, `supportsPromptCache`, `inputPrice`, `isFree`, `excludedTools`,
  `includedTools`, `deprecated`) plus static provider registries under
  `packages/types/src/providers/*` and dynamic providers (openrouter, litellm, …).
- **Continue** `core/llm/toolSupport.ts` `PROVIDER_TOOL_SUPPORT` (per-provider regex),
  `modelSupportsNativeTools` prefers `modelDescription.capabilities.tools`,
  `@continuedev/llm-info` `findLlmInfo` for context/max tokens.
- **Gemini CLI** `defaultModelConfigs.ts`: `features {thinking, multimodalToolUse}`, `tier`,
  `family`, `isPreview`, `isVisible`; **fallback chains** `modelChains` with per-edge
  actions/state transitions (`sticky_retry`/`terminal`).
- **OpenRouter `/api/v1/models`** (live, 458 models at snapshot): `supported_parameters[]`
  (tool support = `tools`/`tool_choice`/`parallel_tool_calls`), `architecture.input_modalities[]`,
  `context_length`, `pricing`, `top_provider.max_completion_tokens`. License **unknown/ToS** —
  query live, do not vendor.

### 3.5 Benchmarks usable to rank free models

See §7 for the import table. The Aider **polyglot leaderboard** (`aider/website/_data/
polyglot_leaderboard.yml`) is directly relevant because it records free/weak models with
both a pass rate and a **format-compliance** rate. Verified rows include
`gpt-oss-120b (high): pass_rate_2 41.8%, well-formed 79.1%, 77 malformed`,
`Qwen3 32B: 40.0% / 83.6%`, `Qwen2.5-Coder-32B: 8.0% / 71.6%`,
`DeepSeek V3 (0324): 55.1% / 99.6%`, `DeepSeek-V3.2-Exp Chat: 70.2% / 98.2%`,
`gemma-3-27b-it: 4.9% / 100%`, `Codestral 25.01: 11.1% / 100%`.

---

## 4. Multi-provider + free-model UX

- **Provider lists are broad and uniform.** Continue/Roo/OpenHands/Ollama/LM Studio/custom
  OpenAI-compatible base URLs appear everywhere. Roo's `provider-settings.ts` enumerates
  openrouter, vercel-ai-gateway, litellm, requesty, unbound, poe, ollama, lmstudio, openai,
  anthropic, bedrock, deepseek, gemini, gemini-cli, mistral, moonshot, minimax, openai-codex,
  qwen-code, sambanova, xai, zai — and marks `retiredProviderNames = ["cerebras","chutes",
  "deepinfra","doubao","featherless","groq","huggingface","io-intelligence","roo"]`. **Groq
  and Cerebras free tiers are retired in current Roo** — relevant because Ferry lists them.
- **Free tiers observed in code**: avante's OpenRouter default is literally
  `model = "openrouter/free"`; Qwen Code's OpenRouter preset ships
  `z-ai/glm-4.5-air:free` and `openai/gpt-oss-120b:free`; Cline's SDK has a recommended-models
  `free` bucket (`GET /api/v1/ai/cline/recommended-models`, 5-min cache); Gemini CLI's OAuth
  "Log in with Google" path surfaces `userTier`/`paidTier` from the Code Assist backend;
  OpenHands rewrites `openhands/<model>` → its hosted `llm-proxy.app.all-hands.dev`.
- **Architect/editor (planner + cheap editor) splits** — the strongest weak-model pattern:
  - Aider `ArchitectCoder.reply_completed()` builds a new coder with
    `editor_model`, `editor_edit_format`, `map_tokens=0`, `cache_prompts=False`, empty
    history; recommended pairs live in `model-settings.yml` (o3→gpt-4.1, o1→gpt-4o,
    deepseek-reasoner→deepseek-chat, Gemini Pro→Flash, Claude Opus→Sonnet).
  - Plandex roles (planner/coder/architect/builder/whole-file-builder) in named **model
    packs** (`app/shared/ai_models_packs.go`: `daily-driver`, `reasoning`, `strong`, `cheap`,
    `oss`, `ollama`, …) with `LargeContextFallback`, `ErrorFallback`, `StrongModel`; every
    referenced model id is validated at startup (`panic("missing base model: …")`).
  - Zed `LanguageModelRegistry` has dedicated slots: `default_model`, `compaction_model`,
    `thread_summary_model`, `commit_message_model`, `inline_assistant_model`,
    `default_fast_model()`.
  - OpenCode per-model system prompts + `smallOptions`.
- **Cost/limit display**: Aider `/tokens` shows per-chunk `$cost` and remaining tokens; Roo
  computes cost into environment details ("# Current Cost"); Cline's OpenRouter handler
  fetches real cost from `/generation?id=…` after a 500 ms delay.
- **Local models**: Ollama/LM Studio are first-class in Aider, Roo, Continue, Void, avante,
  Plandex (Ollama `SkipAuth: true, LocalOnly: true`), OpenHands (`ollama_base_url`, local
  models treated as $0).
- **Provider config as data**: Plandex `ai_models_custom.go` supports custom models/providers/
  packs with published JSON Schemas and a deterministic SHA-256 `Hash()`; gptme's
  `PROVIDER_DEFAULT_MODELS` + lazy per-provider SDK import; Codex provider crates
  (`ollama`, `lmstudio`, `model-provider-info`).

---

## 5. Safety / UX

- **Approvals / modes**:
  - Gemini CLI `policy/types.ts`: `ApprovalMode = { DEFAULT, AUTO_EDIT ('autoEdit'),
    YOLO ('yolo'), PLAN ('plan') }`, `MODES_BY_PERMISSIVENESS = [PLAN, DEFAULT, AUTO_EDIT,
    YOLO]`, `PolicyDecision = { ALLOW, DENY, ASK_USER }`, plus `isTrustedFolder()`,
    `nonInteractive` (ASK_USER→DENY), and a sandbox manager (`macos-seatbelt`/`generic`).
  - Codex separates **three orthogonal axes**: `SandboxMode { ReadOnly (default),
    WorkspaceWrite, DangerFullAccess }`, `ApprovalsReviewer { User (default), AutoReview }`,
    `ModeKind { Plan, Default }`. `ShellEnvironmentPolicy` default-excludes `*KEY*`,
    `*SECRET*`, `*TOKEN*`.
  - Roo auto-approval categories (`alwaysAllowReadOnly`, `alwaysAllowWrite`, `alwaysAllowMcp`,
    `alwaysAllowExecute`, `allowedCommands`/`deniedCommands`); `updateTodoList`/`skill`
    always approved. avante ships `auto_approve_tool_permissions = true` by **default**.
- **Checkpoints / undo**:
  - Roo uses a **shadow git per task** (`RepoPerTaskCheckpointService`, `initShadowGit`,
    `checkpointSave/Restore/Diff` with preview/restore and `operation: delete|edit`); Roo's
    own comment says the implementation was "taken from Cline's implementation".
  - OpenHands `str_replace_editor` has an explicit **`undo_edit`** command.
  - Aider auto-commits every AI change, `/undo` refuses if pushed or dirty, `/diff` and
    `/commit` are first-class.
  - OpenCode `snapshot/index.ts` + `session/revert.ts`; gptme branches/views with dual-write.
- **Sandboxing**: OpenHands Docker/remote runtime (`remote_runtime_class` gvisor/sysbox,
  `trusted_dirs`, `enable_auto_lint`); SWE-agent `swerex` + `ToolFilterConfig` blocklist
  (vim/vi/nohup/less/gdb/`python -m venv`…); mini-swe-agent local `Popen(shell=True)` with
  process-group kill + docker/singularity/bubblewrap; Codex sandboxing/execpolicy/guardian/
  network-proxy/linux-sandbox crates.
- **Workspace restrictions**: Roo `.rooignore` (gitignore syntax, symlink resolution,
  `validateCommand` blocking `cat/grep/sed/...`), Cline `.clineignore`, Plandex
  `.plandexignore`, Gemini `isTrustedFolder`.
- **Plan mode**: Gemini `PLAN`; Codex `ModeKind::Plan`; OpenCode `plan.txt`/`plan-exit` with a
  build-switch prompt; Qwen Code `enterPlanMode`/`exitPlanMode`; Roo architect mode restricted
  to `.md` edits.

---

## 6. What Ferry should adopt (ranked, mapped to Ferry packages)

Ranked by expected gain for weak/free models per unit of risk. Package names are from
`docs/ARCHITECTURE.md`.

1. **Per-model capability registry + edit/tool protocol selection** — target
   `@ferry/catalog` + `@ferry/optimizer` + `@ferry/router`. One record per model carrying
   `tool_call`, `attachment`, `limit.context/output`, `temperature`, `reasoning`, `cost`,
   plus Ferry's own `edit_format` and `tool_protocol` (`native | xml | react | none`).
   Follow Aider's `ModelSettings`/`model-settings.yml` shape and Codex/Void's `ModelInfo`.
   License: import models.dev (MIT) + Aider's YAML/metadata (Apache-2.0) rather than copying
   Codex (Apache-2.0) wholesale. *Effort: M.* **Highest value.**

2. **Layered fuzzy edit matching with model-facing repair hints** — target
   `@ferry/workspace` (+ `@ferry/optimizer`). Adopt the ordered replacers from OpenCode
   `tool/edit.ts` (Simple → LineTrimmed → BlockAnchor → WhitespaceNormalized →
   IndentationFlexible → EscapeNormalized → TrimmedBoundary → ContextAware →
   MultiOccurrence) with the `isDisproportionateMatch` guard, and Crush's
   `diagnoseMismatch` whitespace-visualizing hint. Both credit/derive from Cline and Gemini
   CLI. Reimplement the ideas; code is Apache-2.0/MIT (Crush is FSL — ideas only). *Effort: S–M.*

3. **Text tool-call fallback + JSON repair for tool-less free models** — target
   `@ferry/agent` + `@ferry/shared`. Port Goose `toolshim.rs` (marker tokens, inline-JSON,
   alias resolution, `parse_json_value_tolerant` backslash repair) and OpenHands
   `fn_call_converter.py` (`<function=…>` format, `_fix_stopword`, `_normalize_parameter_tags`).
   Gate it on the per-model `tool_protocol`. License: Goose Apache-2.0, OpenHands MIT. *Effort: M.*

4. **Planner/editor split as a first-class step kind** — target `@ferry/router` +
   `@ferry/agent`. Aider's `editor_model_name`/`editor_edit_format` + Plandex's role packs
   prove a strong planner with a cheap editor beats a single weak model, and the split maps
   directly onto Ferry's "tag the step kind → `router.select`" flow (`ARCHITECTURE.md:32–36`).
   Encode recommended pairs as data. *Effort: M.*

5. **Tiered context compaction + tool-output pruning** — target `@ferry/optimizer`. Combine
   OpenCode's turn-tail preservation + erase-old-tool-outputs (`PRUNE_PROTECT=40_000`,
   `PRUNE_MINIMUM=20_000`, `TOOL_OUTPUT_MAX_CHARS=2_000`) with Codex's `context*9/10`
   auto-compact and OpenHands' condenser kinds (summarize / amortized forgetting / observation
   masking). Always expose a hard output truncation limit (Roo `2000` lines, Codex `bytes(10_000)`).
   *Effort: M.*

6. **Per-provider message + tool-schema normalization** — target `@ferry/providers` +
   `@ferry/shared`. Port OpenCode `normalizeMessages` (surrogate sanitize, empty-part
   filtering, tool-ID scrubbing, the Mistral synthetic `"Done."` turn, DeepSeek reasoning
   injection) and Goose `tool_schema_normalize.rs` (`oneOf(const)` → `enum`, prune `$defs`).
   This is exactly the class of bug that makes free endpoints 400. *Effort: M.*

7. **Repair loop with a bounded reflection budget** — target `@ferry/agent`. Aider's
   `max_reflections = 3` with the actual mismatch text and "did you mean" context is a small,
   proven guard. Add the anti-lazy `detectOmissionPlaceholders` check (Gemini) and Roo's
   `ToolRepetitionDetector`. Never retry forever. *Effort: S.*

8. **Sandbox + approval + plan as separate axes** — target `@ferry/core` + `@ferry/workspace`.
   Copy Codex's `SandboxMode`/`ApprovalsReviewer`/`ModeKind` split and Gemini's
   `DEFAULT/AUTO_EDIT/YOLO/PLAN` enum. Ferry's existing `ask`/`auto_edit`/`full_auto`
   (`ARCHITECTURE.md:46–48`) is a good start; add the sandbox dimension. *Effort: M.*

9. **Checkpoints/undo via per-task shadow git** — target `@ferry/workspace` + `@ferry/core`.
   Roo/Cline's `RepoPerTaskCheckpointService`, OpenHands `undo_edit`, and OpenCode
   `snapshot`/`revert` are three implementations of the same idea. Required before
   `full_auto` runs anything destructive. *Effort: M.*

10. **Capability-aware candidate ordering that never drops a fallback** — target
    `@ferry/router` + `@ferry/catalog`. Kilo hard-drops tool-less models; 9router (in
    `routing-comparison.md` §7.2) reorders without dropping. For Ferry, hard-filter only when
    the step *cannot* proceed, otherwise float capable models and keep the rest as fallbacks.
    *Effort: S.*

11. **Prompt caching as a per-model flag** — target `@ferry/optimizer` + `@ferry/providers`.
    Aider `cache_control` + cache warming, OpenCode `applyCaching`/`prompt_cache_key`. For
    free tiers this is often the difference between usable and rate-limited. *Effort: S–M.*

12. **Free-model ranking from public leaderboards** — target `@ferry/router`. Fold the Aider
    polyglot pass rate **and** format-compliance rate plus SWE-bench/BFCL scores into
    `scoreModels` as a quality prior (Ferry's router already scores at
    `packages/router/src/index.ts:235–315`). *Effort: S (data import) + M (wiring).*

13. **A credential-free health/observability surface for models** — already recommended in
    `routing-comparison.md` §12.11; the agent angle is to surface **format-error rate** and
    **compaction events** per model, not just provider status. *Effort: S.*

---

## 7. Datasets Ferry can import

| Dataset | URL / path | Schema / shape | License | Freshness | Use for Ferry |
|---|---|---|---|---|---|
| **models.dev** | `https://models.dev/api.json`; repo `anomalyco/models.dev` `dev` | Provider→Model with `tool_call`, `attachment`, `modalities`, `limit`, `cost`, `reasoning_options`, `temperature` (verified) | **MIT** | Community PRs + per-provider sync scripts + `bun run validate`; API generated | Primary capability gate + pricing; vendor a snapshot |
| **Aider `model-settings.yml`** | `Aider-AI/aider` `aider/resources/model-settings.yml` | YAML list of `ModelSettings` (edit_format, repo map, editor split, reminders, cache flags) | **Apache-2.0** | PRs | Edit-format + planner/editor defaults per model |
| **Aider `model-metadata.json`** | `aider/resources/model-metadata.json` | litellm-style cost/context/capability map | **Apache-2.0** | regenerated | Context/cost/feature fallback |
| **Aider polyglot leaderboard** | `aider/website/_data/polyglot_leaderboard.yml`; page `aider.chat/docs/leaderboards/` | YAML rows: `pass_rate_1/2`, `percent_cases_well_formed`, `num_malformed_responses`, `total_cost`, `edit_format` | Repo **Apache-2.0**; the separate **`Aider-AI/polyglot-benchmark` repo license is unknown** — do not vendor its problems | PRs when results contributed | Rank free models on editing + format compliance |
| **BFCL** | `github.com/ShishirPatil/gorilla` `berkeley-function-call-leaderboard/`; board `gorilla.cs.berkeley.edu/leaderboard.html` | Per-category line-delimited JSON (`id`, `question`, `function`) + `possible_answer/`; scores in `score/` + `data_overall.csv` | **Apache-2.0** | Datasets versioned (v4 07/17/2025); OSS models supported | Measure a free model's real tool-calling reliability |
| **SWE-bench / Verified / Multimodal** | `github.com/SWE-bench/SWE-bench`; HF `SWE-bench/SWE-bench_Verified` (500), `…_Multimodal` (480, open) | HF dataset fields: `instance_id`, `repo`, `base_commit`, `patch`, `test_patch`, `FAIL_TO_PASS`, `PASS_TO_PASS`, `problem_statement` | **MIT** | Dataset releases + leaderboard repo `SWE-bench/experiments`; Verified now academic-submission only | Primary real-repo agent ranking |
| **LiveCodeBench** | `github.com/LiveCodeBench/LiveCodeBench`; HF `livecodebench/*` | Versioned (`release_v1…v6`), contamination-limited; pass@1/pass@5 | **MIT** | New versions as contests pass | Fresh code-gen signal |
| **BigCodeBench** | `github.com/bigcode-project/bigcodebench`; HF `bigcode/bigcodebench(-hard)` | 1140 tasks, `complete`/`instruct` | **Apache-2.0** | HF Space leaderboard | Practical function-level coding |
| **EvalPlus / HumanEval+** | `github.com/evalplus/evalplus`; HF `evalplus/*` | 80× HumanEval / 35× MBPP tests (+ EvalPerf) | **Apache-2.0** (except `evalplus/eval/` = MIT) | PyPI + Docker | Quick sanity benchmark |
| **Terminal-Bench** | `github.com/laude-institute/terminal-bench`; `tbench.ai`; PyPI `terminal-bench` | Task folders + harness; `terminal-bench-core` v0.1.1 | **Apache-2.0** | Versioned datasets | End-to-end agent behavior like Ferry's |
| **OpenRouter models API** | `https://openrouter.ai/api/v1/models` (+ `/models/{id}/endpoints`) | `{data:[…]}`, `supported_parameters`, `architecture.input_modalities`, `context_length`, `pricing`, `top_provider` | **Unknown / ToS** — query live, do **not** vendor | Live; cadence unknown | Free-model discovery (`:free`, price 0) + routing metadata |

Recommended import order: **models.dev (capability gate) → Aider settings/metadata (edit-format
defaults) → SWE-bench + Aider polyglot (quality prior) → BFCL (tool reliability) →
OpenRouter live (free discovery)**. Snapshot/vendor the open datasets into `packages/catalog`
(no network in tests); keep OpenRouter as a live query only.

---

## 8. Citation index (primary references)

- **Aider**: `aider/coders/{__init__,editblock_coder,wholefile_coder,udiff_coder,architect_coder,
  editor_*,patch_coder}.py`, `aider/coders/base_coder.py` (:100–101, :933–944, :1549–1554,
  :1599–1623, :2296–2328, :2338–2363), `aider/coders/chat_chunks.py`, `aider/coders/base_prompts.py`,
  `aider/repomap.py`, `aider/models.py`, `aider/history.py`, `aider/onboarding.py`,
  `aider/args.py`, `aider/commands.py`, `aider/main.py`,
  `aider/resources/model-settings.yml`, `aider/resources/model-metadata.json`,
  `aider/website/_data/polyglot_leaderboard.yml`, `benchmark/README.md`, `LICENSE.txt`.
- **Cline**: `v3.0.0` `src/core/prompts/system.ts`, `src/core/assistant-message/parse-assistant-message.ts`,
  `src/shared/api.ts`; `main` `sdk/packages/core/src/services/llms/{provider-defaults,cline-recommended-models}.ts`.
- **Roo Code**: `src/core/assistant-message/{parse-assistant-message,presentAssistantMessage,NativeToolCallParser}.ts`,
  `src/core/prompts/responses.ts`, `src/shared/tools.ts`, `src/core/diff/strategies/multi-search-replace.ts`,
  `src/core/context-management/index.ts`, `src/core/condense/index.ts`, `src/core/task/Task.ts`
  (:132–135, :2508–2525, :3223–3259, :3717–3794, :4217–4299), `src/core/prompts/tools/native-tools/read_file.ts`,
  `src/core/mentions/index.ts`, `src/core/environment/getEnvironmentDetails.ts`,
  `src/core/context-tracking/FileContextTracker.ts`, `src/core/checkpoints/index.ts`,
  `src/core/ignore/RooIgnoreController.ts`, `src/core/auto-approval/index.ts`,
  `packages/types/src/{model,provider-settings}.ts`, `packages/types/src/providers/*`.
- **Kilo Code**: `packages/kilo-gateway/src/api/models.ts`, `packages/kilo-gateway/src/api/constants.ts`,
  `packages/kilo-vscode` (Apache-2.0), root `LICENSE` (MIT).
- **OpenCode**: `packages/opencode/src/tool/{edit,apply_patch,tool,read,truncate,bash}.ts`,
  `packages/opencode/src/provider/transform.ts`, `packages/opencode/src/session/{system,overflow,compaction,instruction,revert}.ts`,
  `packages/opencode/src/session/prompt/*.txt`, `packages/opencode/src/snapshot/index.ts`,
  `packages/core/src/models-dev.ts`, `packages/core/src/schema.ts` (of models.dev), `LICENSE`.
- **Crush**: `internal/agent/tools/{edit,edit_whitespace,multiedit,lsp_replace_symbol,lsp_rename}.go`,
  `internal/agent/tools/edit.md`, `internal/agent/templates/summary.md`,
  `internal/agent/prompt/prompt.go`, `internal/config/provider.go`, `internal/message/*`,
  `internal/permission/permission.go`, `LICENSE.md`.
- **Goose**: `crates/goose/src/providers/toolshim.rs`,
  `crates/goose/src/agents/tool_schema_normalize.rs`, `crates/goose/src/context_mgmt/mod.rs`,
  `crates/goose/src/context_limit.rs`, `crates/goose/src/token_counter.rs`,
  `crates/goose/src/model_config.rs`, `crates/goose/src/providers/*_def.rs`,
  `crates/goose/src/permission/*`, `LICENSE`.
- **OpenHands** (tag `0.55.0`): `openhands/llm/{llm,retry_mixin,fn_call_converter,model_features}.py`,
  `openhands/agenthub/codeact_agent/{codeact_agent,function_calling}.py`,
  `openhands/agenthub/codeact_agent/tools/{bash,str_replace_editor,browser}.py`,
  `openhands/memory/condenser/{condenser}.py` + `impl/*_condenser.py`,
  `openhands/core/config/{llm_config,condenser_config,sandbox_config}.py`, `LICENSE`.
- **Continue**: `core/llm/{toolSupport,index,countTokens}.ts`, `core/context/index.ts`,
  `core/indexing/`, `core/autocomplete/`, `core/tools/applyToolOverrides.ts`, `LICENSE`.
- **Plandex**: `app/shared/{ai_models_roles,ai_models_packs,ai_models_providers,ai_models_custom}.go`,
  `app/server/model/{name,summarize}.go`, `app/server/model/prompts/{planning,update_format,apply_exec}.go`,
  `app/server/model/plan/tell_load.go`, `LICENSE`.
- **gptme**: `gptme/tools/{base,__init__}.py`, `gptme/tools/autocompact/*`, `gptme/message.py`,
  `gptme/logmanager/manager.py`, `gptme/llm/__init__.py`, `LICENSE`.
- **Codex CLI**: `codex-rs/apply-patch/src/lib.rs`, `codex-rs/protocol/src/{openai_models,config_types}.rs`,
  `codex-rs/core/src/{client_common,compact_token_budget}.rs`,
  `codex-rs/models-manager/src/{lib,model_info}.rs`, `codex-rs/core/src/tools/*`,
  `codex-rs/{sandboxing,execpolicy,guardian,network-proxy,linux-sandbox}`, `LICENSE`.
- **Qwen Code**: `packages/core/src/tools/edit.ts`, `packages/core/src/tools/` (tree),
  `packages/core/src/providers/{all-providers}.ts`, `packages/core/src/providers/presets/{openrouter,alibaba-standard}.ts`,
  `LICENSE`.
- **Gemini CLI**: `packages/core/src/tools/{tool-registry,edit}.ts`,
  `packages/core/src/context/chatCompressionService.ts`, `packages/core/src/core/{client,contentGenerator}.ts`,
  `packages/core/src/config/{defaultModelConfigs,models}.ts`, `packages/core/src/policy/types.ts`,
  `packages/core/src/prompts/{promptProvider,snippets}.ts`, `LICENSE`.
- **Zed**: `crates/agent/src/{tools,edit_file_tool,permission,tool_permissions,sandboxing,templates}.rs`,
  `crates/agent/src/templates/system_prompt.hbs`, `crates/language_model/src/registry.rs`,
  `crates/language_model/Cargo.toml` (`GPL-3.0-or-later`), `LICENSE-GPL`.
- **avante.nvim**: `lua/avante/llm_tools/{init,edit_file}.lua`, `lua/avante/{config,providers/init,rag_service,repo_map}.lua`,
  `LICENSE`.
- **Void**: `src/vs/workbench/contrib/void/common/modelCapabilities.ts`, `…/common/directoryStrService.ts`,
  `VOID_CODEBASE_GUIDE.md`, `README.md`, `LICENSE.txt` + `LICENSE-VS-Code.txt`.
- **SWE-agent**: `sweagent/tools/{parsing,commands,tools,utils}.py`,
  `sweagent/agent/{history_processors,models,agents}.py`, `tools/windowed_edit_linting/config.yaml`,
  `tools/windowed/lib/flake8_utils.py`, `config/{default,sweagent_0_7/07}.yaml`, `LICENSE`.
- **mini-swe-agent**: `src/minisweagent/agents/{default,interactive}.py`,
  `src/minisweagent/models/{litellm_model,litellm_textbased_model}.py`,
  `src/minisweagent/models/utils/{actions_toolcall,actions_text}.py`,
  `src/minisweagent/config/{mini,mini_textbased}.yaml`, `src/minisweagent/config/benchmarks/swebench.yaml`,
  `docs/usage/swebench.md`, `LICENSE.md`.
- **Data sources**: `models.dev` (`anomalyco/models.dev` `dev`, MIT); Aider resources
  (Apache-2.0); BFCL (`ShishirPatil/gorilla`, Apache-2.0); SWE-bench (MIT); LiveCodeBench (MIT);
  BigCodeBench (Apache-2.0); EvalPlus (Apache-2.0); Terminal-Bench (Apache-2.0); OpenRouter
  `/api/v1/models` (license unknown/ToS).
