# Rust Chat attachments

The native server implements the existing opaque attachment routes:

- `POST /api/chats/:chatId/attachments`
- `GET /api/attachments/:attachmentId/content`
- `DELETE /api/attachments/:attachmentId`

The server relays encrypted metadata and chunks. Endpoint workers retain content
verification and storage. Uploads preserve context/connection/validation/duplicate
and quota precedence, ordered begin/chunk/complete requests, and compensating
deletion after worker or persistence failure. Creating an attachment and its ready
primary replica is one transaction; the ownership read precedes that transaction,
as in Source. Actual failed INSERTs retain Source's ORM query diagnostics.

Downloads validate operation IDs after ownership and failed-status checks, select
the primary or first connected ready replica, and preserve canonical sequence,
size, EOF, truncation and zero-byte rules. Existing attachments remain readable
when their Chat is archived. Deletion dispatches connected replicas concurrently,
preserves rows after a worker failure, and cascades replica rows after success.
The owned operation coordinator retains accepted work after caller loss and
drains individual replica deletions during server shutdown.

Opaque stream contracts are generated from the existing TypeScript authority in
an independent graph. Rust implements the upload/download stream refinements;
the existing envelope refinement and worker result contracts are reused.

## Local evidence

Qualification used pinned Source `522a5724161c2956b1c240d920a329c7b3eca19c`
on macOS arm64. The HTTP SQL fixture runs the production native startup/router,
with a development-only SQL control route. Both implementations use real HTTP
and the unchanged production `WorkerConnection`; endpoint attachment operations
are controlled and carry opaque fixture envelopes.

PGlite, external PostgreSQL, and privately managed PostgreSQL each passed with
none/password/accounts authentication:

- 423 paired recorded cases and complete attachment/replica SQL snapshots.
- 486 paired HTTP observations, including headers, status, error and response
  bodies, and exact opaque worker operation bodies.
- 36 actual failed INSERTs, with rollback and worker compensation checked.
- 18 actual caller destructions that still complete the accepted upload.
- 18 real server/database shutdown-and-reopen flows preserving accepted writes.
- 1,026 additional HTTP reads exercising actual command quota exhaustion. Both
  caught upload failures and uncaught deletion failures preserve their respective
  Retry-After behavior; upload-byte quota failures dispatch no worker operation.

The native HTTP fixture SHA256 is
`dd5f039a8b505a64f776f6eb040d23b298958a83bf53e2d18f010124d55369f2`.
The local report family is `http-pglite-matrix-v6.json`,
`http-postgres-matrix-v1.json`, and `http-bundled-postgres-matrix-v1.json` under
`.qa/rust-chat-attachments`, retained externally before owned worktree cleanup.
Raw failure and runtime evidence is retained alongside successful runs.

Additional passing local checks: 1,992 actual Source protocol/error comparisons;
4,215 comparisons across three base graph sizes; four shared body-parser tests,
including real incomplete HTTP uploads; two unchanged Source attachment API tests;
six unchanged worker attachment tests; and strict all-target Clippy. The full
contract exporter reproduces the other tracked contract graphs unchanged.

`pnpm check` actually fails on unchanged pinned Source line budgets:
`build-app.ts` 1532/1500 and `chat-turn-runtime.ts` 2334/1999.
The independent boundary audit actually fails on unchanged protected
`desktopTarget` references in `cantrip-os-desktop.ts` at lines 341 and 390.
The evidence records byte identity with the tested Main baseline; neither broad
check is described as passing.

## Reproduction and remaining acceptance

Build workspace dependencies, then use Node 24 with the existing local harness:

```sh
pnpm --filter '@cantrip/server^...' --filter '@cantrip/worker^...' run build
node scripts/server-rust/cargo.mjs test --test chat_attachment_contracts
node scripts/server-rust/cargo.mjs test --lib attachment_contracts_survive_unrelated_base_graph_growth
node scripts/server-rust/cargo.mjs test --lib http::body::tests
node --import tsx scripts/server-rust/chat-attachment-http-compatibility.mjs --database pglite --report /tmp/chat-attachments-pglite.json
CANTRIP_TEST_POSTGRES_BIN_DIR=/path/to/postgres/bin node --import tsx scripts/server-rust/chat-attachment-http-compatibility.mjs --database postgres --report /tmp/chat-attachments-postgres.json
CANTRIP_TEST_POSTGRES_BIN_DIR=/path/to/postgres/bin node --import tsx scripts/server-rust/chat-attachment-http-compatibility.mjs --database bundled-postgres --report /tmp/chat-attachments-bundled.json
```

`CANTRIP_RUST_SERVER_BINARY` optionally selects a frozen HTTP SQL fixture; the
normal build fallback remains. Test runtimes use owned isolated
`PGLITE_RUNTIME_DIR` directories. A prior actual initdb attempt failed against an
inherited shared temporary runtime missing `postgres.bki`; the harness does not
change that shared cache or add a startup gate.

This is server domain qualification. Actual client/full-worker file encryption
and transfer, shared/mixed-server Redis coordination, supported platform artifacts,
packaged runtime assets, representative legacy upgrades, post-write Node rollback,
performance and Winterhold deployment rehearsal remain required for complete
replacement. Node is still the default server and the worker remains Node.
