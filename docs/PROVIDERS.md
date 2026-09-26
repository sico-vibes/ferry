# Providers

## Subscription OAuth (unofficial, at your own risk)

Ferry exposes opt-in subscription OAuth logins through `@earendil-works/pi-ai`. They are off by default and may violate provider terms. A provider may suspend or ban an account for use through an unofficial client; Ferry cannot protect the account. Prefer an API key or the provider's official CLI.

Every login requires an explicit acknowledgement. The desktop repeats a warning for every login, including when acknowledgement was remembered. Subscription models stay out of automatic routing unless **Allow subscription OAuth models in routing** is enabled in Settings → Providers & Keys. Manual model selection remains available.

The installed pi-ai 0.87.1 build supports these subscription flows:

| Provider ID | Subscription | Login flow |
|---|---|---|
| `anthropic` | Claude Pro/Max | Browser authorization with a local callback server |
| `openai-codex` | ChatGPT | Browser authorization with a local callback server |
| `github-copilot` | Copilot | Device code shown in Ferry and entered on GitHub |

Gemini CLI and Antigravity OAuth are not exported by this pi-ai version and are not listed by Ferry. OAuth credentials are serialized only into the operating system keyring through `@ferry/secrets`; they are not saved in pi's `~/.pi/agent/auth.json`, the database, or Ferry events/logs. pi-ai's native `Models` interface owns refresh and streaming auth. Its public auth result is `ModelAuth` (`apiKey`, headers, optional base URL); this release does not expose a `getOAuthApiKey` helper, and subscription tokens are not treated as generic AI SDK bearer keys.

CLI usage: `ferry oauth list`, `ferry oauth login <id>`, and `ferry oauth logout <id>`. Non-interactive login requires `--i-understand-the-risk`.
