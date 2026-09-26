# CLI exit codes

`ferry run --max-steps N` stops unfinished work at the configured step limit and returns exit code `4`. A request completed within its allowed steps returns `0`, including a one-step answer. A max-step stop leaves the session idle and resumable; it does not issue a cancellation request.

`ferry profiles chain show [profile]` prints the profile's deterministic fallback order. Set it with `ferry profiles chain set <profile> <provider=pattern,pattern> [...entries]`, for example:

```sh
ferry profiles chain set Auto-Free gemini=gemini-3.8-flash,gemini-3.*-flash groq=qwen/qwen3.8-27b
```

Patterns resolve against the provider's live model list. Ferry tries eligible entries in order, then falls back to score-ranked models that pass strict automatic-routing eligibility.

`ferry doctor --providers` prints provider health, key status, enablement, cooldown expiry, and model count. The report excludes credentials and response bodies. Add `--json` for machine-readable output.
