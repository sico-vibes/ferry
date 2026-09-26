# Ferry RPC protocol

Ferry clients and the core exchange newline framed JSON-RPC 2.0 messages using protocol id `ferry/1`. The Electron transport uses structured-clone messages over a `MessagePort`; stdio uses one JSON value per line. WebSocket transport is reserved behind an explicit feature flag and must use a random bearer token.

## Requests and responses

Requests have `jsonrpc: "2.0"`, an integer or string `id`, a `domain.method` method name, and positional `params`. Positional arguments follow the public `FerryClient` method signatures in order. The shared package exports the JSON-RPC envelope schemas and the current method name list. A response contains either `result` or an `error` object.

`system.hello` takes `{ protocol, capabilities }`. It rejects mismatched protocols and returns `{ protocol, capabilities, realDomains, implementedMethods }`. `realDomains` only includes domains with at least one registered handler. `system.selfTest` reports native module readiness from inside the core process. Domain events are JSON-RPC notifications whose method is the event name (`session.updated`, `quota.updated`, and so on) and whose `params` is the event payload described by `FerryEventSchemas`.

`sessions.send` accepts `{ text, maxSteps? }`. When supplied, `maxSteps` is a positive integer and the agent ends the run at that boundary with an idle, resumable session. The CLI reports this stop with exit code `4`.

## Errors

| Code | Kind | Meaning |
| ---: | --- | --- |
| `-32700` | `parse_error` | Reserved for malformed JSON framing |
| `-32600` | `invalid_request` | Invalid JSON-RPC envelope |
| `-32601` | `unknown_method` | Method is not part of the Ferry contract |
| `-32603` | `internal` | Unexpected implementation failure |
| `-32001` | `timeout` | Client request timed out |
| `-32002` | `protocol_mismatch` | Client and core protocol ids differ |
| `-32004` | `not_implemented` | Contract method exists, but its domain handler is not registered |

Other domain errors use the numeric code from the domain error and `data.kind: "domain_error"`. `data.details` is optional and must not contain secrets. Error messages are intended for local diagnostics, not as stable machine identifiers; clients branch on `data.kind`.

## Lifetimes and transports

The core owns one exclusive lock file per data directory. A live second owner causes startup to fail with a clear `CoreLockError`; a stale lock from a dead process is removed on startup. The core accepts requests, emits notifications, and releases the lock on stop. Clients use bounded request timeouts and may reconnect when their transport supplies a reconnect operation.

The stdio transport is for a future `ferry serve --stdio` command. The Electron main process starts the core with `utilityProcess`, transfers one end of a `MessageChannelMain` to the core, and passes the renderer end through preload. WebSocket support remains disabled unless `websocketEnabled` is true; when enabled, it binds to loopback and authenticates each connection with a fresh random token.

## Native modules

`system.selfTest` loads `better-sqlite3`, `node-pty`, and `@napi-rs/keyring` from inside the core runtime and returns a status, detected version, and exact load error per module. Native modules must be rebuilt for Electron's ABI by the packaging/tooling lane; loading them in Node alone does not verify utility-process compatibility.

Part B keeps `@electron/rebuild` out of the dependency graph. The Core utility-process self-test is the readiness check for each native module. If a module reports a native ABI mismatch, the packaging/tooling lane should add the required rebuild tooling and rebuild that module against Electron's ABI; a missing-module result instead means the dependency has not been installed in the app package.
