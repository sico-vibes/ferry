# Windows path test, round 2 (no commit)

Your new assertion fails locally:
Expected: "ferry core pid 47336 owns c:\users\jbmst\appdata\local\temp\ferry-cli-owned-core-5fpir6, but its local control channel is unavailable."
Received: "... but its local control channel is unavailable. update or restart ferry, or pass --data-dir to use another engine directory."
The product message is right (it includes the recovery hint). Make the test assert containment of the canonical prefix (case-folded on win32), as the original `toThrow(...including...)` intent did, **and** that the recovery hint is present. No product change. Typecheck, lint and prettier; no commit.
