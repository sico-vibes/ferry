# Delegation agents

Fleet lanes may use `implementer: "acp", agent: "<registry id>"` to launch one of the agents in `packages/delegate/data/acp-agents.yaml`. Existing Codex, OpenCode, and Claude CLI lanes keep their native transports by default; set `transport: "acp"` to route a supported agent through ACP.

The registry is the supported-agent source of truth. `ferry doctor` detects available agent CLIs and ACP agents without reading credentials. Install and authenticate each agent using its own official instructions. Pi and `pi-free` are user-installed: install Pi and the pi-free extension, then choose the `pi` ACP agent through `pi-acp`. Ferry does not install Pi or modify its auth files.

ACP file access is limited to the delegation workspace and lane paths. Writes run the configured checkpoint callback before changing a file. Permission requests are forwarded to Ferry's approval callback when one is configured. Authentication methods are surfaced to the host; Ferry never reads or stores agent credentials.

## Review and decisions

Ferry creates a delegation task in a configured lane and presents resulting changes for review. Inspect the diff/output before accepting; accept applies the reviewed result to the task workspace, while reject declines it. ACP file access is limited to the delegation workspace and lane paths. Writes run the configured checkpoint callback before changing a file. Permission requests are forwarded to Ferry's approval callback when configured. Agent authentication remains with the agent. Review UI and edge-case semantics are (updating).
