# Provider and OAuth enhancements

This note records the legitimate provider work retained for g1-A. Provider definitions and release evidence now live in `packages/shared/src/provider-registry.ts`; provider-specific limits and dated model fallbacks remain in the catalog.

## API connections

The in-progress catalog adds xAI API, Cohere, Moonshot, MiniMax, SiliconFlow, Inception and Perplexity through their documented OpenAI-compatible endpoints. They remain Beta until account verification. Ollama and LM Studio use their local OpenAI-compatible servers; anonymous adapters can run without a saved key when their definition permits it. Existing optional API keys continue to work.

## Account connections

The OAuth adapter retains progress messages, device codes, browser URLs, text and secret prompts, manual authorization codes or redirect URLs, refresh, and cancellation. Desktop and CLI consume the same Core events. API and subscription connections use separate identities so an Anthropic sign-in cannot replace its API connection.

Kilo, Qoder and Cline account sign-in remain Coming soon; unavailable account flows stay unavailable. Their controls do not advertise a working login. The adapter catalogs supported account models, while routing still requires explicit account-routing enablement.

## Branding and connection UI

The saved-key manager retains provider-specific credential formats, account key replacement, key health recovery, and accurate invalid-key feedback. New marks for GitHub Copilot, Cline, Qoder, Radius and SiliconCloud are local assets; attribution is recorded in `packages/ui/src/assets/providers/SOURCES.md`.

## OpenCode Zen

Ferry supports the standard API with the user's own key. OpenCode-only free models are labelled Available in the OpenCode app and excluded from Ferry routing. Use `ferry run opencode --native` with the actual OpenCode app's own providers and authentication, or use the existing delegation lane. Ferry does not emulate another client or rename tools to obtain access.

Live provider checks are separate from offline fixtures. A catalog entry or adapter test does not establish successful verification on the user's account.
