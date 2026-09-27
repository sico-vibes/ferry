# Routing

Routing implementation is evolving; see settings and `ferry doctor --providers` for current account state. Provider-specific behavior marked below is (updating) where parallel work may change it.

## Auto-Free selection

Auto-Free uses the profile's editable fallback chain first. Each entry names a provider and model patterns; patterns resolve against that provider's available model list. If no chain entry can run, Ferry score-ranks the remaining models that pass automatic-routing eligibility, including profile permissions, model capability/context fit, quota availability, and reliability. It does not add up advertised tokens across providers as a capacity promise. Subscription OAuth models stay excluded unless enabled.

Edit a chain:

```sh
ferry profiles chain show Auto-Free
ferry profiles chain set Auto-Free gemini=gemini-3.8-flash,gemini-3.*-flash groq=qwen/qwen3.8-27b
```

## Advanced → Routing

Defaults are off unless noted; these switches opt into specific behavior. Actual defaults are shown by the current Settings screen (updating).

| Toggle | Effect | Trade-off |
|---|---|---|
| Sticky sessions | Reuse a session's selected model while its sticky route is valid | More consistent tool behavior; can keep using a model after another becomes preferable. |
| Smart reliability | Include observed success/failure reliability in model ranking | Learns from outcomes; early/limited observations are noisy. |
| Quota reservations | Reserve quota for in-flight calls to reduce concurrent oversubscription | Better coordination; can temporarily leave unused reserved capacity. |
| Cooldown reasons | Track cooldown provenance (heuristic, authoritative, credit, tier) | Avoids treating all cooldowns alike; provider signals can be incomplete. |
| Gentle quota ramp | Reduce selection weight as remaining quota approaches depletion | Preserves headroom; may avoid a preferred model while some quota remains. |
| Tool-rejection memory | Defer a model after repeated distinct tool-call rejections | Avoids repeated incompatible calls; may overreact to transient tool errors. |
| Careful model retirement | Retire confirmed retired models; corroborate ambiguous 404s | Reduces false retirements; may take another failure to confirm. |

Cooldown scope, persistence, and TTL are (updating). A cooldown can reflect rate limits, exhausted credits, account/tier restrictions, or a local heuristic; it is not necessarily a provider outage.

## Handoffs and errors

If a request switches models, Ferry emits a handoff marker/briefing so the next model can continue with context. Review the visible target and reason before treating the handoff as a clean continuation. (updating)

Error cards summarize the request failure and may include model attempts. Common meanings: rate limit/quota exhausted means wait for the indicated reset or choose another eligible model; invalid key means re-enter/check the credential; unsupported free tier means the provider rejected the access path; context/request too large means reduce input or choose a larger-context model; provider/network failure may be transient. In verbose CLI mode, routing exclusions and attempt details are printed to stderr. (updating)

Run `ferry doctor --providers` to inspect provider health, key status, enablement, cooldown expiry, and model count. `--json` emits machine-readable output; credentials and response bodies are excluded.
