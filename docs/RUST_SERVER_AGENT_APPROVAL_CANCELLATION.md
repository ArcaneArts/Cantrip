# Native Agent approval cancellation after a failed write

The production Rust server and compiled Node reference pass the same
account-authenticated browser SDK and full-worker scenario on macOS ARM64.
The Rust cases use native PGlite, bundled PostgreSQL and external PostgreSQL.
The reference uses JavaScript PGlite or an isolated PostgreSQL database.
Native Codex executes the turns. A loopback provider supplies scripted model
responses.

Each peer creates two real project Agents. A temporary constraint rejects only
command approval writes for the first Agent in its disposable database. The
test installs the constraint with the server stopped, then reopens the original
database through the normal production entry point.

- The browser submits an encrypted prompt and native Codex asks for approval.
  The failed write causes one `agent.interaction.cancel` dispatch and
  completion with the same request ID. The original native thread and turn
  reach an interrupted terminal event, and the browser sees a failed Agent.
  No approval is visible, and the command leaves no marker file.
- The second Agent completes a real command approval. The browser opens the
  request and encrypts its answer. Replaying the accepted decision returns
  the same result and a conflicting replay returns 409. The command returns
  its expected output.
- The next prompt in the first Agent is interrupted by native Codex before
  reaching the model on both server implementations. Restarting the worker
  alone lets that Agent complete a new prompt. After a separate server restart,
  the accepted approval and recovered reply remain readable, the rejected
  approval remains absent, and the marker file still does not exist.

All six peers have matching scoped results, 18 clean server exits and 18 clean
worker exits. Private request text stays out of the observed browser HTTP
records and server and worker diagnostics. The
[acceptance record](security/rust-server-agent-approval-cancellation.json)
identifies the exact reports and runtime artifacts. The immediate same-worker
follow-up interruption remains open. This comparison exercises protected
command approval in a project Agent. Other interaction types, standalone Chat
and multi-server fault behavior retain separate acceptance scope.

```sh
node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --approval-cancellation --database pglite --report /absolute/path/to/approval-cancellation.json
```

Repeat for `bundled-postgres` and `postgres` with the production Rust server,
compiled Node reference, worker and native Codex artifacts. Set
`CANTRIP_TEST_PROJECT_REPOSITORY_BINARY` to the Rust `project-repository-fixture`
example. Configure local PostgreSQL with `CANTRIP_TEST_POSTGRES_BIN_DIR`.
