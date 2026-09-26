# Delegation agents

Fleet lanes may use `implementer: "acp", agent: "<registry id>"` to launch one of the agents in `packages/delegate/data/acp-agents.yaml`. Existing Codex, OpenCode, and Claude CLI lanes keep their native transports by default; set `transport: "acp"` to route a supported agent through ACP.

ACP file access is limited to the delegation workspace and lane paths. Writes run the configured checkpoint callback before changing a file. Permission requests are forwarded to Ferry's approval callback when one is configured. Authentication methods are surfaced to the host; Ferry never reads or stores agent credentials.

## Pi and pi-free

Users can install Pi and the pi-free extension themselves, then delegate through the `pi` ACP agent (`pi-acp`). Ferry does not inspect, change, or otherwise touch Pi authentication files.
