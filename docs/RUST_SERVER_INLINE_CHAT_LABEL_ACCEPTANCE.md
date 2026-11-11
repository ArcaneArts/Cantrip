# First-turn Chat and Agent titles through the full worker

The production Rust server and compiled Node reference passed the same
account-authenticated browser and full-worker scenarios on macOS ARM64. The
Rust cases use PGlite, bundled PostgreSQL and external PostgreSQL. The Node
reference uses JavaScript PGlite and isolated PostgreSQL databases. Native
Codex consumes disposable Responses streams from loopback model endpoints.

Both original peers completed the Agent reply with the placeholder title.
The fresh worker could read the Chat content, and the private title key was
missing. The browser now attempts that key grant and refresh for its selected
worker when automatic naming is enabled and random names are disabled. The
ordinary Chat prompt can still submit after a failed key refresh.

Each accepted peer verifies three first turns:

- A project Agent runs labeling and response on the same provider. The
  response waits while the label stream is held. The browser receives a chat
  invalidation, opens the normalized three-word title and reads one completed
  response with its native thread and turn correlation.
- A standalone Chat uses a separate labeling provider and the original
  response provider. The first turn runs on the real scratch workspace
  provisioned by the worker. The browser opens the title and reads the
  completed response with the existing `item/completed` correlation and
  absent streaming field. Project Agents retain the `native-history`
  correlation and explicit `streaming: false` field.
- A punctuation-only label response preserves the original title envelope.
  The Agent's normal reply completes once and remains available after restart.

The ordinary chat-list responses carry opaque title envelopes, and the browser
opens the same ciphertext for all three conversations after the server
process restarts. Both servers dispatch `chat.scratch.provision` and route the
standalone turn using the resulting opaque handle. Neither current server
produces `chat.scratch.resolve`. Its worker decoder and handler remain part
of the compatibility contract.

The [acceptance record](security/rust-server-inline-chat-label-acceptance.json)
links the retained reports and executable hashes. The fresh-worker fixture
exercises the Agent thread separately from its optional console. Both original
peers recorded console preparation failure without the private label grant. The app
treats that console phase as a usable thread. Shared-server interruption and
final supported-platform shipping retain separate acceptance scope.

```sh
node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --inline-chat-labels --database pglite --report /absolute/path/to/chat-labels.json
```

Repeat for `bundled-postgres` and `postgres` with the production server,
worker and Codex artifacts. Configure local PostgreSQL through
`CANTRIP_TEST_POSTGRES_BIN_DIR`.
