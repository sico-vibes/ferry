# Ferry Bench

Measures task completion with the real Ferry CLI. All ten fixtures are small,
deterministic, and dependency-free. Build the CLI first:

```powershell
.\tools\pnpm.cmd --filter @ferry/cli build
.\tools\pnpm.cmd bench --keys-from-env --profile Auto-Free --repeat 1 --out live-reports/bench/report.json
.\tools\pnpm.cmd live:conformance --keys-from-env --out live-reports/conformance/report.json
```

`node scripts/bench/run.mjs --help` lists options. Use `--tasks blog-html,json-transform`
to select tasks, `--repeat N` to repeat, `--profile NAME` to choose routing, and
`--cli PATH` to select a built `ferry.js` or a standard Ferry `ferry.cmd` wrapper
(the adjacent JS entry is launched directly to preserve shell-sensitive prompts).
A task's non-null `profile` overrides the runner profile. The supplied tasks use
the runner's profile. There are no new dependencies and nothing installs packages
inside a task.

## Offline verification

```powershell
.\tools\pnpm.cmd bench:self-test
node scripts/bench/run.mjs --dry-run --out live-reports/dry/report.json
```

Both commands validate all task definitions and copy each known-good solution and
untouched fixture to temporary folders. Every solution must pass its checker and
every untouched fixture must fail. The self-test also checks event deduplication,
model filtering, argument validation, protected files, process deadlines, and
reports. It never starts Ferry, accesses credentials, or calls providers. Browser
tests use only local file URLs and loopback DevTools; external page traffic is
blocked. Checkers exit 0 (pass), 1 (fail), or 77 (unavailable prerequisite).

Microsoft Edge, Google Chrome, or Chromium is located in standard Windows/macOS
locations or Linux PATH. Set `BENCH_CHROMIUM` to an executable to override discovery.
Node 22+ supplies `fetch` and `WebSocket`; no browser package is needed. Browser tasks
report **skipped: no Chromium** if unavailable. Python discovery tries `python3`,
`python`, then `py`; **python-bug** reports **skipped: no Python** if none works.
It uses standard-library unittest, so pytest is optional and unnecessary.

## Keys and isolation

Live commands require exactly one explicit key source:

- `--keys-from-env`: read `FERRY_LIVE_<PROVIDER>_KEY`, converting uppercase
  underscores to the provider's lowercase hyphens. Keys go through
  `ferry providers keys <provider> add --stdin`, never command arguments.
- `--use-stored-keys`: prints a warning, reads the default **Ferry** keyring and
  provider key references from the default engine database opened read-only, then
  copies those secrets through the same CLI command into the bench service.
  This consumes the stored accounts' live quotas. Legacy provider account names
  are supported when engine metadata is absent. Cloud Vault keys are not read.

Every task/repetition gets a fresh workspace and engine `--data-dir`. All Ferry
children use `FERRY_KEYRING_SERVICE=Ferry-Bench-<pid>`, including stored-key mode.
The original service is only read: there is no restore/write operation against
it. The desktop `real-keyring-guard.mjs` snapshots the real accounts before live
work, asserts they are unchanged afterward, and cleans both legacy and numbered
bench accounts in `finally`. Timeouts and interrupt signals terminate child
process trees before cleanup. Temporary directories use Windows lock retries.
Inherited Ferry test injection/cloud variables and live-key environment variables
are removed from child environments. Known keys are redacted from captured CLI
output. Checkers run generated code in temporary folders; use dedicated accounts
and an isolated CI runner for these live coding tasks.

The nightly Windows workflow runs at 03:00 UTC and supports manual dispatch. It
builds the CLI, runs conformance followed by the bench even if conformance fails,
uploads both JSON/Markdown report pairs, and adds Markdown to the job summary.
When no supported secret has a value, it emits a skip notice. It does not publish
or push. Configure any of these repository or organization secrets (literal
names, not values):

```text
FERRY_LIVE_GROQ_KEY
FERRY_LIVE_CEREBRAS_KEY
FERRY_LIVE_GEMINI_KEY
FERRY_LIVE_OPENROUTER_KEY
FERRY_LIVE_MISTRAL_KEY
FERRY_LIVE_SAMBANOVA_KEY
FERRY_LIVE_NVIDIA_KEY
FERRY_LIVE_HUGGINGFACE_KEY
FERRY_LIVE_TOGETHER_KEY
FERRY_LIVE_DEEPINFRA_KEY
FERRY_LIVE_FIREWORKS_KEY
FERRY_LIVE_NEBIUS_KEY
FERRY_LIVE_NOVITA_KEY
FERRY_LIVE_SCALEWAY_KEY
FERRY_LIVE_OVHCLOUD_KEY
FERRY_LIVE_STEPFUN_KEY
FERRY_LIVE_TOKENROUTER_KEY
FERRY_LIVE_ZAI_GLM_KEY
FERRY_LIVE_VERCEL_AI_GATEWAY_KEY
FERRY_LIVE_CLOUDFLARE_WORKERS_AI_KEY
FERRY_LIVE_KILO_KEY
FERRY_LIVE_LLM7_KEY
FERRY_LIVE_ANYAPI_KEY
FERRY_LIVE_HYPERBOLIC_KEY
FERRY_LIVE_OPENCODE_GO_KEY
FERRY_LIVE_OPENAI_KEY
FERRY_LIVE_ANTHROPIC_KEY
FERRY_LIVE_DEEPSEEK_KEY
```

Free eligibility still depends on Ferry's catalog/account plan. Paid and
trial-only providers may have keys but no eligible conformance models, producing
a skip row. Local runs can supply additional provider names using the same env
pattern; add them explicitly to workflow env to enable their GitHub secrets.

## Tasks

| Task | Check |
| --- | --- |
| blog-html | Exact supplied blog prompt; Chromium at 375/1280 px, three posts, console/overflow/excerpts, persisted admin add/edit/delete |
| fix-failing-test | Signed addition cases pass; test and package files unchanged |
| add-cli-flag | Default/name/uppercase greetings and invalid arguments; protected tests |
| refactor-rename | Four modules renamed; tests pass; old name absent |
| python-bug | Median edge cases, immutable input, protected unittest file |
| readme-from-code | API descriptions, ESM usage, examples, Node version, error condition; source unchanged |
| json-transform | Inactive rows filtered, totals grouped/sorted, JSON equals protected expected file |
| css-responsive-fix | Three tiles remain visible at 375/1280 px without overflow; HTML unchanged |
| multi-file-feature | Eight-module inventory feature with validation, copying, search, totals, CSV, persistence, escaping; about 15–25 steps |
| long-task | Fifteen-file todo app: model, state, actions, search/filter/sort, persistence, history, rendering, CLI/UI; about 30+ steps |

Step estimates guide fixture complexity; the runner records actual tool calls
without artificially requiring a model to spend a minimum number of steps.

## Reports and conformance

JSON contains counts, success rate (passes / non-skipped runs), and per-run
duration, unique tool-call steps, models, handoff reasons, wait-until statuses,
failed attempts grouped by kind, input/output/reasoning tokens, CLI exit/signal,
timeout, checker result, and final session outcome. Part IDs, attempt IDs and
usage event IDs deduplicate updates and repeated session snapshots. Missing
usage is `null`, not invented zero usage. Only attempts exposed by the CLI are
counted; older CLI streams may expose only the final turn's attempts. CLI failure,
timeout, incomplete/malformed JSON, or checker failure makes the run fail.
Markdown is written next to the requested JSON (e.g. `report.json` → `report.md`).
Reports are updated after each run and retained on errors. Use an ignored `.dev`
directory or a temporary/output folder for local live reports.

Conformance keeps an isolated core alive via the existing workspace `tsx` and
the public `@ferry/core` entry, then invokes `ferry providers list --json` over
its local-control pipe. The report records reply bytes and whether the actual
reply exceeded 1 MB; smaller catalogs explicitly report the coverage limitation.
It also performs a deterministic >1 MB transport probe by temporarily adding a
non-routable model with a large metadata field to a disabled provider in the
isolated engine database. That metadata is restored in `finally` before model
probes, so the historical pipe cap is exercised even with small real catalogs.
For every keyed provider it chooses up to three free, tool-capable models and
performs two back-to-back runs per model, restricting routing to that provider
and exact model. Each probe must list, write a unique marker, read it, then answer
with that marker. Wrong/missing/failed tools and model fallback fail the probe.
The table includes provider, model, result, failure kind, HTTP status and latency.
