# Terminal snapshots and legacy replica deletion

The current Rust server and compiled Node reference passed the same browser SDK,
CLI and full-worker scenarios with account authentication on macOS ARM64. The
Rust cases use PGlite, private PostgreSQL and external PostgreSQL. The Node
reference uses JavaScript PGlite for the first case and an isolated PostgreSQL
endpoint for each PostgreSQL case. The native serving executable was built from
`020254f3c3aabb5e2e1e712c2c597a5cc73a5950`.

| Command identity       | Current evidence                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal.snapshot`    | The real CLI reads a private marker printed by an actual PTY. Its request goes through the worker CLI broker, the production server and the worker's encrypted snapshot handler. Each peer checks the terminal identity, running state, complete output and read-only result after startup, service restart and worker reconnect. |
| `project.files.delete` | The existing browser removal API exercises real file deletion for a legacy Cantrip-owned Git replica. Offline deletion returns 503 and preserves the checkout. With the worker online, delete-files removes the owned checkout, while catalog-only removal preserves the files. Both outcomes survive server and worker restart.  |
| `project.clone`        | `4d28b8d53` retired the original server's direct clone request. The current connected import comparisons observe `project.replica.provision` for both durable provisioning jobs. The legacy worker handler remains in the wire contract.                                                                                          |
| `worktree.list`        | The current CLI operation reads the persisted worktree catalog and execution leases. The HTTP comparison verifies a Primary worktree and zero dispatched worker commands. The worker's legacy `worktree.list` handler remains in the wire contract.                                                                               |

The full-worker runs use the unmodified Node worker from the current source and
the verified Codex 0.166.0 runtime. The replica test seeds the legacy catalog
fields on a stopped disposable profile and uses a local Git checkout under the
fixture worker's managed repository root. The ordinary server process and
worker perform the removal and the subsequent restart checks.

Separate HTTP comparisons record the exact worker commands, responses and
database outcomes for account authentication on all three stores. They exercise
CLI catalog and surface routing, connected replica provisioning and project
removal boundaries with controlled worker responses. The
[acceptance record](security/rust-server-terminal-replica-acceptance.json)
links the retained reports and executable hashes.

The first browser attempt lacked built workspace dependencies. The next run
passed the Node product cases and selected an older Rust executable from the
shared cache. Its incomplete PGlite assets failed during real `initdb`. The
current build from Cargo's target-specific directory initialized PGlite with its
embedded assets and served every accepted Rust case. The failed setup reports
remain available with the accepted results.

Scoped worker command coverage now accounts for 306 of 323 identities. Full
shipping artifacts, broader historical profiles and multi-instance recovery
retain their existing acceptance requirements.
