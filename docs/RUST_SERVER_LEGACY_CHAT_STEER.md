# Encrypted Chat steering without a native activation

The comparison sends `POST /api/queued-prompts/:promptId/steer` through the
production Rust and Node reference routers. It seeds an existing active project
or standalone execution lane and verifies that the Chat has no active native
activation. Both servers send `chat.steer` over the existing WorkerConnection.
The worker codecs decrypt the prompt and attachment metadata. The existing
`CodexAppServer.steerThread` builds `turn/steer` for the expected turn and client
message ID. The test controls the native turn notification and the final RPC
reply. The attachment uses a real fixture file resolved in the worker store.

The public route rejects a missing or stale item revision and returns 404 for
another account's prompt. While the RPC reply is held, the claim is visible and
history remains empty. Rejection returns the item to the queue with a rejected
claim. A subsequent successful request saves the original message ciphertext
with the correct project worktree or standalone scratch root and execution lane.
The database message plaintext column remains null.

All nine local macOS arm64 storage and authentication combinations pass. They
compare 282 HTTP observations, 36 worker commands, and 36 native RPC calls.
The retained message, queue item and claim rows match exactly through 18 server
restarts and 36 Chat reopens with automation paused. Three focused worker
steering tests pass. The broader unchanged native execution test file reports
41 passing tests, three fresh-admission failures, and one unhandled rejection.

The controlled worker has no native receipt dispatcher for this fallback. Its
successful RPC leaves a claim pending settlement. A separate anonymous PGlite
pilot reopened with automation enabled and the worker disconnected. Both
implementations eventually rejected the remaining claims and returned the
prompts to pending while retaining a single encrypted message per Chat. The
project recovery also populated its model route metadata. Reconnect with a real
native runtime and settlement of the accepted steer remain open.

Run the comparison with the built protocol, crypto, logging, version and Node
reference packages. Supply the native HTTP fixture and database assets as in
the [Chat import comparison](RUST_SERVER_CHAT_IMPORTS.md).

```sh
node --import tsx scripts/server-rust/legacy-chat-steer-http-compatibility.mjs \
  --database pglite --report /absolute/path/to/legacy-chat-steer.json
```

Repeat with `bundled-postgres` and `postgres`. See the
[acceptance record](security/rust-server-legacy-chat-steer-acceptance.json).
