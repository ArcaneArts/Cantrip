# Cantrip Workbench

This first-party extension is bundled into Cantrip Code. It connects only to
the authenticated worker-local bridge written into a generated Cantrip
workspace. It coordinates dirty buffers, save-before-turn policy, external
agent file changes, theme following, workspace identity, and Git status.

It is not an agent or model integration. Conversation history and Codex turns
remain owned by `cantrip_server` and `cantrip_worker`.
