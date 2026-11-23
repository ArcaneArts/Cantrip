# Server SQL migrations

`drizzle/` is the existing SQL migration history, embedded and applied by the
Rust server in `cantrip_server_rs`. Keep its migration identities and history
stable for existing installations.

There is no Node server workspace or executable here. Explicit development
comparisons use the retired baseline in `tests/reference-node-server`; normal
builds, desktop launch, service packages and deployments use Rust.
