# Routing

Ferry applies the active profile, key policy, provider state, model capabilities, quota data, and user spending rules to each route. Provider health and account capacity can change; inspect them in Models → Providers or with `ferry doctor --providers`. The current release candidate and its unfinished work are tracked in [STATUS](STATUS.md).

## Auto-Free selection

Auto-Free uses the profile's editable fallback chain first. Each entry names a provider and model patterns; patterns resolve against that provider's available model list. If no chain entry can run, Ferry score-ranks the remaining models that pass automatic-routing eligibility, including profile permissions, model capability/context fit, quota availability, and reliability. It does not add up advertised tokens across providers as a capacity promise. Subscription OAuth models stay excluded unless enabled.

Edit a chain:

```sh
ferry profiles chain show Auto-Free
ferry profiles chain set Auto-Free gemini=gemini-3.8-flash,gemini-3.*-flash groq=qwen/qwen3.8-27b
```

## Planner/editor roles

Planner/editor roles are optional and off by default on built-in profiles. Enable them per profile in **Profiles → Planner and editor**. When enabled, planning uses the strongest
eligible model by catalog quality prior and context fit. Editing favors fast, tool-capable models
with good observed tool reliability. A planner returns a structured list of files, intent, and
concrete changes; the editor receives that contract and uses its own registry edit format and tool
protocol. A single eligible model or repeated editor failures falls back to planner-led editing.
Planner/editor role changes do not create a provider-failure handoff marker.

You can also inspect and change roles with the CLI:

```sh
ferry profiles roles show Auto-Free
ferry profiles roles set Auto-Free on planner=auto editor=auto
```

The live evaluation harness accepts `--roles on|off` for paired comparisons. Suggested role pairs
and their rationale are in `packages/router/data/role-pairs.yaml`.

## Routing settings

These switches appear under **Settings → Routing**. For a new settings record, the seven listed routing features default on; text tool-call fallback defaults off. Existing saved settings keep their stored values.

| Toggle | Default | Effect | Trade-off |
|---|---|---|---|
| Sticky sessions | On | Reuse a session's selected model while its sticky route is valid | More consistent tool behavior; can keep using a model after another becomes preferable. |
| Smart reliability | On | Include observed success/failure reliability in model ranking | Learns from outcomes; early/limited observations are noisy. |
| Quota reservations | On | Reserve quota for in-flight calls to reduce concurrent oversubscription | Better coordination; can temporarily leave unused reserved capacity. |
| Cooldown reasons | On | Track cooldown provenance and re-probe heuristic pauses early when safe | Probes can use a request; authoritative provider limits are not probed early. |
| Gentle quota ramp | On | Reduce selection weight as remaining quota approaches depletion | Preserves headroom; may avoid a preferred model while some quota remains. |
| Tool-rejection memory | On | Temporarily defer models after repeated distinct tool-call rejections | Avoids repeated incompatible calls; may overreact to transient tool errors. |
| Careful model retirement | On | Confirm retirement before acting on ambiguous model-not-found responses | Reduces false retirements; may take another failure to confirm. |
| Text tool-call fallback | Off | Allow a supplied adapter to use XML/ReAct text-format tool calls | Only useful when a compatible fallback adapter is available. |

A cooldown can reflect a rate limit, exhausted credits, account/tier restriction, or a local heuristic; it is not necessarily a provider outage. Expiry follows the provider signal or Ferry's local cooldown policy. The cooldown-reason setting controls whether provenance such as authoritative versus heuristic is shown.

## Handoffs and errors

If a request switches models, Ferry emits a handoff marker/briefing so the next model can continue with context. Review the visible target and reason before treating the handoff as a clean continuation.

Error cards summarize the request failure and may include model attempts. Common meanings: rate limit/quota exhausted means wait for the indicated reset or choose another eligible model; invalid key means re-enter/check the credential; unsupported free tier means the provider rejected the access path; context/request too large means reduce input or choose a larger-context model; provider/network failure may be transient. In verbose CLI mode, routing exclusions and attempt details are printed to stderr.

Run `ferry doctor --providers` to inspect provider health, key status, enablement, cooldown expiry, and model count. `--json` emits machine-readable output; credentials and response bodies are excluded.

## Paid calls and spending caps

Monetary paid calls are checked in core immediately before provider invocation using the router's provider/model free decision. A model that the router classifies as free does not trigger monetary confirmation or caps. Paid calls use catalog input/output prices when available; an unknown price uses a conservative `$0.01` estimate and is labelled in the approval details. Profile and global session, daily, and monthly caps combine using the stricter limit. Subscription OAuth and trial/credit providers only require paid-call confirmation when the profile enables the matching confirmation option; those lanes do not count as monetary spend unless billing is explicitly enabled.

Core reserves the estimated cost of each authorized in-flight call before allowing another call to pass the cap check. A call already authorized may finish after the cap is reached, so recorded spend can exceed a cap by at most one in-flight request. A cap stop excludes further paid calls until its period resets or the cap is raised. The CLI returns exit code `3` when paid approval is required but unavailable; `ferry run --yes-paid` grants one-run approvals.
