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
| `ferry quota [--watch]` | Show quotas or watch updates |
| `ferry providers [list\|probe\|enable\|disable ...]` | Inspect/manage configured providers |
| `ferry oauth [list\|login\|logout ...]` | Manage supported subscription OAuth logins |
| `ferry profiles [list\|show\|chain show\|chain set ...]` | Inspect profiles and set fallback chains |
| `ferry skills [list\|show ...]` | Inspect available skills |
| `ferry mcp` | List MCP configuration/state |
| `ferry lanes [list\|show ...]` | Inspect delegation lanes |
| `ferry optimize` | Print optimizer statistics |
| `ferry doctor [--providers]` | Check local dependencies/CLIs or provider health |
| `ferry keys [list\|set\|delete ...]` | Manage provider keys |
| `ferry settings [routing ...]` | Inspect/update routing settings |
| `ferry init [--yes]` | Initialize workspace configuration |

Subcommand syntax and accepted names are implemented in `apps/cli/src/main.tsx`; use `ferry <command> --help` when supported by the installed version.

## Flags

Global parser flags: `--json`, `--verbose`, `--cwd <path>`, `--data-dir <path>`, `--engine <mock|local>`. Commands also accept `--profile <name>`, `--permission <ask|auto_edit|full_auto>`, `--max-steps <positive integer>`, `--watch`, `--providers`, `--yes`, and `--i-understand-the-risk` where applicable. `ferry run --model-ref provider/model` selects a specific model. `ferry run --yes-paid` confirms each paid call once for this run, including under `--permission full_auto`. Without a TTY or profile pre-authorization, a paid call is denied unless this flag is passed. Some admin handlers accept `--delegation` and `--model`. `--json` emits JSON lines/results; verbose routing diagnostics go to stderr. Exact command-specific operands are (updating).

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
