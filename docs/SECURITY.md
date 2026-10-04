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
| CSP | `script-src 'self'`, no `unsafe-eval`, no loopback WebSocket allowance in production, object/frame/form restrictions; inline styles remain enabled for Monaco and runtime component styles |
| New windows and navigation | New windows denied; navigation and redirects are allowed only to the exact renderer URL; external HTTP(S) links go through a host allowlist or a user confirmation dialog |
| Renderer permissions | All permission requests denied; camera, microphone, geolocation, and notifications are not needed |
| IPC handlers | `ferry:open-folder`, `ferry:engine-status`, `ferry:connect-core`, and `ferry:theme`; arguments use shared Zod schemas; sender frame must match the renderer URL |
| Preload bridge | `realDomainsFromEnvironment`, `openFolder`, `updateTheme`, `connectCore`, `getEngineStatus`, `onEngineRestarting`, and `onEngineConnected`, plus read-only `platform` and `versions`; no generic channel or invoke bridge |
| Core MessagePort | 256-bit random per-connection token, single use in the main process, and source/origin checked in the renderer |
| File paths to renderer | Only the directory selected by the native open-folder dialog is returned; core paths and process details stay on the main/core boundary |

## Core and workspace controls

- The optional WebSocket RPC listener binds explicitly to `127.0.0.1`, gets a
  fresh random bearer token per server start, uses constant-time token comparison,
  rejects any `Origin` header, locks out an address after five bad tokens, and
  caps buffered frames.
- The desktop core also exposes the existing JSON-RPC protocol to same-user CLI
  clients over a local control channel while it owns `core.lock`. On Windows,
  the endpoint descriptor lives in Ferry's per-user AppData directory and
  inherits its ACL for the current user, SYSTEM, and Administrators; the named
  pipe uses Node's default ACL from the creating user's token. Ferry does not
  rewrite Windows ACLs. If `FERRY_DATA_DIR` points elsewhere, the user is
  responsible for that directory's permissions.
  On POSIX, the data directory is mode `0700`, the `core.sock` socket and
  endpoint descriptor are mode `0600`. The descriptor contains a fresh 256-bit
  token. A connection must present that token in a separate handshake before it
  is attached to the core transport, and comparison is constant-time. The token
  is the authentication gate; no TCP listener is used for CLI control. The
  descriptor is removed on clean shutdown and rotated at the next start after a
  crash. `doctor` reports channel state and PID only; the endpoint token is
  never logged or displayed. Other local processes and local users are threats;
  OS permissions plus the random token restrict access. A process that can read
  the current user's Ferry data directory can also read the token. If endpoint
  publication fails, the core logs one warning and continues to start; CLI
  clients report that the desktop core owns the lock but its channel is
  unavailable.
- Stdio transport behavior is unchanged.
- Workspace file tools deny credential paths, including `.env`, `.env.local`, and
  other `.env.*` variants. Listing and grep paths apply the same protection.
- Destructive commands and shell indirection are classified for approval in
  `ask` and `auto_edit` modes and denied in `full_auto` mode.
- Shell commands are screened for protected credential paths; model-supplied
  shell-affecting environment keys are rejected, and non-default command
  execution options require approval. ACP file callbacks apply the same
  protected-path policy.
- Project permission modes and rules cannot raise the saved user permission
  mode or override user deny rules. Unapproved project permission rules are not
  loaded. Project gate commands run only after approval of the exact
  `.ferry/config.json` SHA-256.
- Checkpoint snapshots, restores, and diffs exclude protected credential paths.
- Project MCP configuration is not currently loaded by the desktop MCP domain.
  The MCP manager filters project-sourced entries unless the exact configuration
  hash is approved. Project delegation lanes likewise require approval for the
  exact project config hash; a byte change invalidates the approval. The same
  exact-byte rule protects `.ferry/config.json` gate commands.
- ACP filesystem callbacks resolve paths against the delegation workspace and
  reject parent traversal, absolute escapes, symlink escapes, and protected
  credential paths.
- Shared secret redaction is exercised by core regression coverage for provider
  keys and OAuth access/refresh tokens across RPC results, events, SQLite, and
  logs. WebSocket bearer tokens are separately checked against console and log
  output.

## Dependency audit

`pnpm audit --prod` was run by the orchestrator on 2026-09-27. It reported no
known vulnerabilities at that time; the audit preceded the addition of
`electron-updater` 6.8.9 for the beta release.

## Windows release updates

Windows beta installers are unsigned, and Ferry's `electron-updater` client
disables code-signature verification to accept them. Updates are fetched over
HTTPS from the public `sico-vibes/ferry` GitHub Releases feed. HTTPS protects the
transport against passive network observers and ordinary in-path modification.
An attacker would need to compromise the GitHub release account or release CI,
or control a trusted TLS inspection certificate/local proxy on the user's
machine, to replace update metadata or packages; unsigned packages provide no
publisher identity or signature-based tamper detection if one of those boundaries
is compromised. Users should install only from the official Releases page. The
accepted risk is to keep unsigned beta updates enabled while the project has no
release signing identity; the planned mitigation is to sign Windows releases
and restore updater signature verification.

## Fixed in B10

- Project gate commands are hash-approved against the exact `.ferry/config.json`
  bytes before execution. `run_command` checks command, working directory,
  environment keys, and PTY options; model calls cannot override shell or
  executable lookup variables, and approval details show the full invocation.
- Credential files are denied to shell reads and ACP read/write callbacks.
  Checkpoint snapshots, diffs, and restores filter protected paths.
- Project permission settings cannot raise the user's mode; user deny rules
  take precedence. Unapproved project permission rules are not loaded.
- The gateway rejects every browser `Origin` by default, throttles repeated bad
  keys, and requires a confirmation prompt before LAN binding. Rate state is
  pruned and busy-port fallback resolves on the replacement port.
- Core RPC error mapping redacts known secrets in both messages and details.
  Delegate argv rejects shell metacharacters, and PowerShell encoded commands,
  expression evaluation, and download cradles require review or are denied.
- Desktop permission checks are explicitly denied, renderer trust is bound to
  the exact renderer URL, core MessagePort handoff does not expose its bearer
  token in a wildcard-origin message, production CSP no longer allows the
  loopback WebSocket endpoint, and Radius URLs require HTTPS.

Unsigned auto-updates remain the accepted B10 risk described above; update
configuration was intentionally left unchanged pending signing infrastructure.

## Reporting vulnerabilities

Please report security issues privately to the Ferry maintainers or through the
repository host's private security advisory feature when available. Include the
affected version/commit, platform, impact, and a minimal reproduction. Do not
include real provider keys, OAuth tokens, personal workspace files, or private
customer data in the report.
