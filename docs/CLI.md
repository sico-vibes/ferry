# CLI

The parser in `apps/cli/src/main.tsx` is the current source of truth. Run `ferry --help` for the packaged build's live help. The default engine is `local`; `--engine mock` or `FERRY_ENGINE=mock` explicitly selects the demo engine. `ferry --help` and `ferry status` show the active engine. A local run requires at least one configured provider; add a key in the Ferry app or run `ferry` setup.

## Commands

| Command | Purpose |
|---|---|
| `ferry` | Interactive terminal UI |
| `ferry run <prompt> [--model-ref provider/model] [--yes-paid]` | Start a prompt/session; optionally select a model and pre-authorize paid calls for this run |
| `ferry resume <sessionId>` | Resume a session |
| `ferry status` | Show the active engine and provider configuration |
| `ferry serve` | Placeholder; reports that engine transport is coming in B0 |
| `ferry serve --gateway` | Run the core and Gateway in the foreground |
| `ferry gateway start|stop|status` | Manage the local Gateway |
| `ferry gateway keys create <name> [profile] [limits]` | Create a Gateway key; its secret is shown once |
| `ferry gateway keys list|show|update|revoke ...` | Inspect or manage Gateway keys, limits, and current usage |
| `ferry quota [--watch]` | Show quotas or watch updates |
| `ferry providers [list\|probe\|enable\|disable ...]` | Inspect/manage configured providers |
| `ferry providers keys <provider> list|add|remove|enable|disable|move ...` | Manage provider credentials and ordering |
| `ferry providers routing <provider> [--priority N] [--weight N]` | Show or set the desktop provider priority and weight |
| `ferry providers overrides <provider>` | Show effective parameter, header, and status overrides |
| `ferry models map list|set|remove ...` | Manage logical model mappings and inspect Gateway aliases |
| `ferry oauth [list\|login\|logout ...]` | Manage supported subscription OAuth logins |
| `ferry profiles [list\|show\|chain show\|chain set ...]` | Inspect profiles and set fallback chains |
| `ferry profiles affinity <profile> [soft\|strict]` | Show or set account affinity on a routing profile |
| `ferry skills [list\|show ...]` | Inspect available skills |
| `ferry mcp` | List MCP configuration/state |
| `ferry lanes [list\|show ...]` | Inspect delegation lanes |
| `ferry optimize` | Print optimizer statistics |
| `ferry doctor [--providers]` | Check local dependencies/CLIs or provider health |
| `ferry keys [list\|set\|delete ...]` | Manage provider keys |
| `ferry settings [routing ...]` | Inspect/update routing settings |
| `ferry init [--yes]` | Initialize workspace configuration |

Subcommand syntax and accepted names are implemented in `apps/cli/src/main.tsx`; use `ferry <command> --help` for command-specific usage.

### Gateway key limits

Create or update budgets with positive integer limits. Omitted limits stay unchanged on update; `--clear` removes selected limits (`rpm`, `concurrency`, `tokens-per-min`, or `tokens-per-day`). `show` returns key limits and usage counters.

```sh
ferry gateway keys create "Build bot" auto-free --rpm 60 --concurrency 3 --tokens-per-min 8000 --tokens-per-day 100000
ferry gateway keys show <key-id> --json
ferry gateway keys update <key-id> --rpm 120 --clear tokens-per-day --json
```

### Provider keys

`add` never accepts a secret as an argument. Enter it at the hidden prompt or pipe it through `--stdin`; `--label` is optional. List output contains the label, last four characters, status, and today's usage, never the credential. Removing a key in a non-interactive invocation requires `--yes`. `move` takes a 1-based destination position.

```sh
ferry providers keys openrouter add --label "Work account"
Get-Content .\provider-key.txt -Raw | ferry providers keys openrouter add --stdin --json
ferry providers keys openrouter move 2 1 --json
ferry providers keys openrouter disable 2 --json
ferry providers keys openrouter remove 2 --yes --json
```

### Routing, mappings, and overrides

Provider priority accepts -100 through 100; weight accepts 0.01 through 1000. Affinity belongs to a profile and accepts `soft` or `strict`; `providers routing --help` points to `ferry profiles affinity`. Effective overrides come from the core that handles the request, including when the CLI connects to the desktop core. Logical model mappings use one provider/upstream pair per row. Reserved Gateway aliases are listed alongside mappings and are not edited by the map commands.

```sh
ferry providers routing openrouter --priority 10 --weight 2 --json
ferry providers routing openrouter --json
ferry models map set gpt-oss-120b groq openai/gpt-oss-120b --json
ferry models map list --json
ferry models map remove gpt-oss-120b groq --json
ferry providers overrides openrouter --json
ferry profiles affinity "Auto-Free" --json
ferry profiles affinity "Auto-Free" strict --json
```

## Flags

Global parser flags: `--json`, `--verbose`, `--cwd <path>`, `--data-dir <path>`, `--engine <mock|local>`. Commands also accept `--profile <name>`, `--permission <ask|auto_edit|full_auto>`, `--max-steps <positive integer>`, `--watch`, `--providers`, `--yes`, and `--i-understand-the-risk` where applicable. Gateway-key commands accept `--rpm`, `--concurrency`, `--tokens-per-min`, `--tokens-per-day`, and `--clear`. Provider-key add accepts `--stdin` and `--label`; provider routing accepts `--priority` and `--weight`. `ferry run --model-ref provider/model` selects a specific model. `--json` emits JSON results; verbose routing diagnostics go to stderr.

Examples:

```sh
ferry doctor --providers --json
ferry run "Summarize this repository" --cwd . --permission ask
ferry run "Inspect the failing tests" --engine mock --max-steps 5 --json
ferry profiles chain show Auto-Free
```

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | Command completed; a one-step answer also returns 0 |
| `1` | Run failed or an uncategorized error occurred |
| `2` | Invalid command/arguments/flag value or missing required argument |
| `3` | Approval was needed but could not be granted (for example, non-interactive run) |
| `4` | `run --max-steps` reached its step boundary; session remains resumable |
| `5` | Paid spending cap reached; no further paid call was sent |

| 5 | Paid spending cap reached; no further paid call was sent |

Other subcommands may return their handler's status. `--max-steps` ends cleanly at the boundary; it does not issue a cancellation request. For routing, see [ROUTING.md](ROUTING.md).
