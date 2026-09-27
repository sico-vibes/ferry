# Provider access practices Ferry does not support

Ferry supports direct, user-authorized provider keys and documented provider API routes. It does
not support multi-account farming, shared or borrowed API keys, subscription credential reuse,
browser-cookie/session proxies, or relays that impersonate a provider's web product.

These workarounds can violate provider terms, expose other users' credentials, and trigger account
bans or revoked access. A provider can change enforcement without notice. Use a separate authorized
key for each provider account and follow the provider's published API terms. Ferry's provider list,
Auto-Free chain, and troubleshooting flows must not suggest ways to evade those controls.

Research basis: `community-free-llm.md` (reviewed 2026-09-27), which records reported bans and
provider restrictions on account farming and web-session proxies.
