# Troubleshooting

## No available model

Check **Models → Providers** for a connected key and enabled provider. You can also manage API keys under **Settings → Providers & keys**. A key can be valid while its account has no quota for a model. Check your profile's allowed providers, fallback chain, model context limit, and whether the model is excluded from automatic routing. Try `ferry doctor --providers` and `ferry quota`. Wait for the provider reset or choose another eligible provider when capacity is exhausted. Routing details are in [ROUTING.md](ROUTING.md).

## Provider shows invalid or down

For **invalid**, re-enter the key and confirm it belongs to the selected provider/project. For **down**, check network access and the provider status page, then probe again. A provider may return authentication, billing, region, permission, or rate-limit errors that look like an outage; inspect the error card and `ferry doctor --providers --json`. Do not share raw logs publicly without reviewing them.

## Request too large

Reduce the prompt, attached files, or retained command output. Exclude generated/vendor folders from workspace context, retrieve only relevant lines with recovery handles, or select an eligible model with a larger context window. Provider context limits include both input and output and can differ from advertised maximums.

## Rate limits and exhausted quota

Provider limits are often per model and per account, and may include requests/minute, requests/day, tokens/minute, credits, or shared-IP caps. Wait for the reset shown by Ferry or choose another configured model. Do not create extra accounts or rotate credentials to evade limits. Free capacity can change without notice; see [PROVIDERS.md](PROVIDERS.md).

## Logs, data, and reset

The default Windows engine data directory is `%APPDATA%\Ferry\engine`; `FERRY_DATA_DIR` or an explicit `--data-dir` overrides it. The CLI doctor reports the resolved directory. Local sessions, settings, and databases live there; in local mode, provider credentials are stored separately in the operating system keyring. Renaming the data directory resets the local database and settings but does not necessarily remove keyring entries, which may then have no matching local metadata. Close Ferry before moving or renaming data, and back it up first. If you also intend to delete credentials, remove them through Ferry while their metadata is still available; do not delete arbitrary keyring entries. Never delete files while Ferry is running.

## Report a bug safely

Include Ferry version, Windows version, exact steps, expected/actual result, and a redacted error message. Remove API keys, OAuth codes/tokens, authorization headers, private prompts, source code, workspace paths, and account identifiers from screenshots/logs. Never attach the full data directory or database. Use the project's issue tracker.
