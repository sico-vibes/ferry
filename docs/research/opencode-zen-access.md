# OpenCode Zen access

## Supported paths

Ferry uses the standard Zen API with the user's own OpenCode key. A successful standard API connection establishes access only to models that endpoint serves to Ferry. Paid models remain subject to the key, profile and global spending policy.

Models restricted to OpenCode are Available in the OpenCode app, with a configuration action and `ferry run opencode --native` launch command. Select a native model explicitly with `--model opencode/big-pickle`, or use the existing OpenCode delegation lane. This launch uses the actual app's own providers and authentication, without injecting Ferry provider configuration.

## Access failures

A free-tier access rejection does not establish that the account key is invalid. Ferry reports the OpenCode-app restriction, preserves legitimate saved keys, and keeps these models out of Ferry candidate pools. Custom request headers do not make restricted models eligible. A successful standard API generation can establish access for a free model on that connection; model-list discovery alone cannot.

Ferry does not emulate another product's identity, add another client's session metadata, or rename its tools to obtain access. Standard API discovery and connection probes retain Ferry attribution.

## Verification

Offline fixtures cover standard API requests and access rejections. Live account verification remains an explicit user action. Provider rules and model availability can change; dated catalog evidence is distinct from successful access on a particular account.
