# Empty terminal parameters

This is matchit 0.8.4 from crates.io under its upstream MIT and BSD-3-Clause
licenses. `upstream-sha256.json` records copied file hashes before modification.
Upstream CI configuration is omitted.
The only runtime patch is in `src/tree.rs`. The additional
`cantrip-empty-params` Cargo feature is disabled by default.

When enabled, an exhausted static prefix can match its named parameter child
with an empty value. Exact static matches still take priority; catch-all
matching and insertion are unchanged. Cantrip enables this feature to preserve
the existing Fastify request routing, including `/api/agent-requests/`.

The server's production HTTP comparison exercises the real Axum path extractor,
and its registered-route corpus compares matching against find-my-way.
