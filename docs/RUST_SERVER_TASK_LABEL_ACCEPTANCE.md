# Automatic Task titles through the full worker

The production Rust server and compiled Node reference passed the same browser
Task and full-worker flow in account mode on macOS ARM64. The Rust cases use
PGlite, bundled PostgreSQL and external PostgreSQL. The Node reference uses
JavaScript PGlite and isolated PostgreSQL databases. The model endpoint serves
disposable Responses streams. Native Codex executes stateless inference and
normal Task execution through the existing worker.

Both original peers reached the model with the Task brief and then failed to
encrypt the title. The fresh worker had the Task content key, while the private
label key is a separate grant. With automatic titles enabled, the Task surface
now supplies its online worker to the browser admission API. Initial direct
and planning admission attempt the actual private label grant and refresh.
Admission still proceeds when the worker cannot accept the key.

Each accepted peer verifies the following:

- The browser saves an encrypted brief and submits direct execution with the
  project scheduler paused. The server dispatches one standalone
  `label.generate` command for the Task. The actual model receives the title
  instructions and the decrypted brief as separate messages, with no tools.
- A held model stream leaves the queued Task and its original encrypted title
  intact. Releasing the model produces a normalized six-word title. The browser
  receives a chat invalidation and decrypts the replacement envelope from the
  public chat list. The server's response carries the envelope without a
  plaintext title.
- A restart replaces the server process, and the browser opens the same
  ciphertext while the worker is stopped. Reconnecting the worker and
  unpausing executes the original queued operation once. The browser decrypts
  its completed transcript, and the title remains unchanged.
- A separate planning request uses a descriptor that was current before the
  worker stopped. Its real private-label refresh returns HTTP 503. The original
  planning admission still enters the paused queue.

The [acceptance record](security/rust-server-task-label-acceptance.json)
identifies the binaries and retained reports, including the original
missing-grant failures and the corrected test observations. This comparison
qualifies the standalone Task producer. Inline initial titles for Chat and
Agent turns, shared-server interruption, and final supported-platform
shipping acceptance retain separate evidence scopes.

```sh
node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --task-label --database pglite --report /absolute/path/to/task-label.json
```

Repeat for `bundled-postgres` and `postgres` with the production server,
worker and Codex artifacts. Prepare PostgreSQL using the local
`CANTRIP_TEST_POSTGRES_BIN_DIR` fixture setting.
