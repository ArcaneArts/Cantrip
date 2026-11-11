# CantripOS Run lifecycle through the production server

The existing browser SDK starts a Run in a disposable CantripOS Docker guest
through the production server and full worker. The scenario creates the
workspace and provisions a Linux-owned source through the public API, writes a
Run definition through the guest's definition service, and grants the worker
access to protected Run content. A real guest shell checks that the secret
arrived. It prints the secret and a separate output marker. The browser opens
the encrypted output, verifies the marker and checks that the worker redacted
the secret. The server's response carries only the protected output envelope.

The browser reads the owned runtime status and replays the exact start
operation. The guest PID stays the same. After SIGKILL of the production server
and then SIGKILL of the full worker, the browser reopens output from that same
guest PID and generation. Restart advances to generation two, preserves the
runtime and terminal identities, and replaces the process. Stop returns the
runtime to idle and terminates the replacement PID. Stop replay retains its
receipt and durable status.

All six account-authenticated guest cells pass across the Node reference and
Rust production peers, covering PGlite, bundled PostgreSQL and external
PostgreSQL. The matrix retains 60 compared snapshots, including 36 Run states,
24 encrypted output proofs, six Run server kills and six worker kills. The six
workspace-create operations also survive the loss of a committed HTTP reply
and server replacement with one workspace each. The Node peer uses a private
external database in the bundled PostgreSQL comparison.

The public Run status and workspace list endpoints read owned durable state.
The Run worker receives captured process identities through reconciliation on
reconnect. The protocol still declares the worker handlers for
`cantrip-os.run-runtime.status`, `project.run-configuration-runtime.status` and
`cantrip-os.workspaces.list`. Current production server source has no producer
for these three commands. The historical scheduled automation producer of
`chat.turn.protect` was removed in `561b7214f`; current scheduled dispatch uses
`automation.dispatch.protect`. A separate current HTTP comparison observed 16
calls to that replacement across the two peers.

Eight focused Linux worker lifecycle tests pass. The unchanged worker-native
guest integration test reaches its large retained-output check and fails because
the journal's expected `outputTruncated` flag is absent on the local image.
That case and final supported-platform shipping acceptance remain open.

Use the normal built browser/worker dependencies, a current native server and
the existing worker CLI. Select a disposable foundation guest image with
`CANTRIP_TEST_OS_IMAGE` and supply native database assets as in the
[OS lifecycle qualification](RUST_SERVER_CANTRIP_OS_LIFECYCLE.md).

```sh
node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --cantrip-os-run --database pglite --report .qa/os-run-pglite.json
```

Repeat with `bundled-postgres` and `postgres`. See the
[acceptance record](security/rust-server-os-run-lifecycle-acceptance.json).
