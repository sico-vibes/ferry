# Security notes

## Scope and threat model

Ferry is a local desktop coding agent. The renderer is treated as untrusted: it can
request only named preload operations, and the main process checks the sending
frame before accepting IPC. The core and delegated tools can read or change files
inside a selected workspace, invoke local providers and MCP tools, and launch
delegated CLIs. Malicious workspace content, crafted commands, hostile links,
compromised provider responses, and unexpected child-process output are in scope.

This checkout contains both the Part A mock UI and evolving engine packages. The
security controls below describe the implemented code paths; they do not imply
that every UI domain is connected to a production service.

## Desktop and IPC checklist

| Control | Status |
| --- | --- |
| `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` | Enabled on the desktop window |
| Webview disabled; no Blink feature opt-ins | Enabled; no remote module is imported or enabled |
| Packaged DevTools | Disabled unless `FERRY_DEBUG_TOOLS=1` |
| CSP | `script-src 'self'`, no `unsafe-eval`, loopback-only WebSocket connect allowance, object/frame/form restrictions; inline styles remain enabled for Monaco and runtime component styles |
| New windows and navigation | New windows denied; navigation and redirects are allowed only to the exact renderer URL; external HTTP(S) links go through a host allowlist or a user confirmation dialog |
| Renderer permissions | All permission requests denied; camera, microphone, geolocation, and notifications are not needed |
| IPC handlers | `ferry:open-folder`, `ferry:engine-status`, `ferry:connect-core`, and `ferry:theme`; arguments use shared Zod schemas; sender frame must match the renderer URL |
| Preload bridge | `realDomainsFromEnvironment`, `openFolder`, `updateTheme`, `connectCore`, `getEngineStatus`, `onEngineRestarting`, and `onEngineConnected`, plus read-only `platform` and `versions`; no generic channel or invoke bridge |
| Core MessagePort | 256-bit random per-connection token, single use in the main process, and source/origin checked in the renderer |
| File paths to renderer | Only the directory selected by the native open-folder dialog is returned; core paths and process details stay on the main/core boundary |

## Core and workspace controls

- The optional WebSocket RPC listener binds explicitly to `127.0.0.1`, gets a
  fresh random bearer token per server start, uses constant-time token comparison,
  rejects any `Origin` header, and locks out an address after five bad tokens.
- Stdio transport behavior is unchanged.
- Workspace file tools deny credential paths, including `.env`, `.env.local`, and
  other `.env.*` variants. Listing and grep paths apply the same protection.
- Destructive commands and shell indirection are classified for approval in
  `ask` and `auto_edit` modes and denied in `full_auto` mode.
- Project MCP configuration is not currently loaded by the desktop MCP domain.
  The MCP manager filters project-sourced entries unless the exact configuration
  hash is approved. Project delegation lanes likewise require approval for the
  exact project config hash; a byte change invalidates the approval.
- ACP filesystem callbacks resolve paths against the delegation workspace and
  reject parent traversal, absolute escapes, and symlink escapes.
- Shared secret redaction is exercised by core regression coverage for provider
  keys and OAuth access/refresh tokens across RPC results, events, SQLite, and
  logs. WebSocket bearer tokens are separately checked against console and log
  output.

## Dependency audit

`pnpm audit --prod` was run by the orchestrator on 2026-09-27. It reported no
known vulnerabilities. No npm package was added.

## Reporting vulnerabilities

Please report security issues privately to the Ferry maintainers or through the
repository host's private security advisory feature when available. Include the
affected version/commit, platform, impact, and a minimal reproduction. Do not
include real provider keys, OAuth tokens, personal workspace files, or private
customer data in the report.
