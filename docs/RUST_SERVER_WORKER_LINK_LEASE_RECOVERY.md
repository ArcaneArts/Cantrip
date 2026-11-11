# WorkerLink lease renewal and process recovery

The browser SDK exercises the production Rust server and compiled Node
reference with account authentication, the full Node worker, a LAN peer
session, and the native desktop broker verifier. The Rust matrix uses PGlite,
private PostgreSQL, and external PostgreSQL. The Node reference uses JavaScript
PGlite and isolated external PostgreSQL databases.

Each run renews the same parent session and LAN peer without changing their
identities, issuance times, or absolute expiry. Reopening the peer returns
the extended lease only after the worker acknowledges the renewal. The peer's
mailbox remains available. The native verifier connects to the actual worker
broker and proves its identity. After activation, the test waits until the
production lease can advance and sends the browser's normal direct transport
telemetry. The worker logs the extension for that attachment.

The test then kills the full worker process. During its reconnect grace
period, parent and direct renewal return HTTP 503, while the peer mailbox can
still be read. The broker socket closes. A replacement worker reconnects
with the same enrollment and a new process generation. Renewal and mailbox
requests with the old authority return HTTP 404. A fresh session, peer, and
capability renew normally.

The next interruption kills the serving process and reopens the same profile
on the same port. The still-running worker reconnects with its original worker
and broker identities and a new server generation. The previous authorities
return HTTP 404. Fresh authorities renew, and explicit release closes the native
broker socket with code 1008. The retained project and account state survives
the restart.

The first matrix confirmed both lease extensions on all six peers. Its crash
assertion expected immediate invalidation during the reconnect grace period,
and cleanup initially obscured the assertion with the broker's expected socket
reset. The retained first reports and server logs record that attempt.

The final comparison covers local macOS ARM64 process recovery. It uses the
actual worker peer gateway and LAN signaling mailbox. Sustained LAN media,
packaged desktop IPC, Redis coordination, a process loss during an unacknowledged
renewal, and shipping platform acceptance remain separate.

Build the app dependencies, worker, and reference server. From the repository
root run the following with each database mode. Set
`CANTRIP_TEST_SERVER_BINARY`, `CANTRIP_TEST_CLI_BIN`, and
`CANTRIP_TEST_DESKTOP_BROKER_BINARY` to use existing verified build outputs.
The PostgreSQL fixture uses `CANTRIP_TEST_POSTGRES_BIN_DIR`.

```sh
node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --worker-link-renewal --database pglite --keep-fixture \
  --report /absolute/path/to/worker-link-renewal.json
```

See the [acceptance record](security/rust-server-worker-link-lease-recovery.json)
for executable hashes, the six product reports, and the fixture archive.
