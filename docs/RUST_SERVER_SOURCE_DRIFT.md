# Current server source reconciliation

The Rust port includes counterparts for the recent server changes, but source
pairing and matching schemas do not establish complete behavioral compatibility.
This audit uses integrated source `8bc4c5d8100124136b4d77df387b69164f5e40da`.
Node remains the default server and full replacement remains incomplete.

Since the previous coverage baseline `951b108cc`, 39 first-parent commits change
the Node server; 37 also change Rust core. Recent paired changes include
operation-specific model selection, embedding and decision transport, catalog
pagination and scoped discovery, direct model-operation usage, autonomous Task
Goal recovery, and CantripOS desktop/package/system/workspace admissions.

The two Node-only changes require individual review:

- `2060beb2a` adds `markUnreadCompletion` to a TypeScript facade options type.
  Rust already consumes that field in `chats/execution_lanes/mutations.rs`.
- `fc71cc21e` explicitly supplies `executionProfile: "ide"` for Task interruption.
  The analogous Rust caller omits it, while its outgoing envelope validator
  applies the protocol default. This is source-level correspondence; exact
  current native Task interruption remains part of behavioral qualification.

After rebuilding the current TypeScript protocol, all nine generated Rust
contract manifests compare equal without modifying the tracked manifests. The
main manifest contains 803 roots and 12,453 nodes. Equality covers the generated
representation, not custom validators or HTTP error mapping.

The existing product fixture's unchanged worker was also compared against a
fresh build at this source baseline: all 1,635 compiled files match. Its native
runtime pin matches the current 92-patch series:
`11ba64258abf73b678aef876152c131ac3f828163b5a11d258e7ef882ab41cbf`.
This establishes matching inputs for those tests; it does not certify every
feature introduced by the patches.

## Inventory corrections

| Inventory                      | Previous stored count | Current source |
| ------------------------------ | --------------------: | -------------: |
| HTTP and WebSocket routes      |                   557 |            584 |
| Worker commands                |                   310 |            323 |
| Declared durable tables        |                   116 |            135 |
| Inventoried repository methods |                   367 |            369 |
| App Live resource kinds        |                    47 |             47 |

The 27 newly inventoried routes comprise five desktop, seven package, eight
system, three workspace-operation, and four model-operation endpoints. These
counts describe inventory corrections, not newly implemented features or a
completion percentage. Repository-method inventory retains its existing facade
scope; it is not a count of every internal repository helper.

The audit now reads every `schema*.ts` module. An independent test loads the
actual Drizzle schema and compares its table exports against the discovered
declarations, including all 19 formerly omitted tables. The route parser now
handles literal tuple loops and a constant prefix plus one varying binding.
It still rejects unresolved paths and correlated varying bindings.

The security audit previously mistook two CantripOS `desktopTarget` references
for private remote-surface state. Those references carry a schema-defined guest
account/display/generation admission, not the encrypted remote-surface target.
The audit now resolves the exact protocol import or persisted table row type at
each reference. No filename or field-wide exception is added. Adversarial tests
retain findings for unrelated surfaces, shadowed schemas/types, reassigned rows,
other tables, untyped values, and unvalidated objects. The other endpoint-private
field, import and crypto checks remain active.

The coverage ledger records newly inventoried contracts as partial with explicit
remaining acceptance. Existing rows retain historical milestone evidence;
their remaining-work descriptions must be consolidated before final completion.

## Confirmed behavioral drift

Real production Node and Rust executables reproduce two error-contract defects
in the four new embedding/decision HTTP endpoints:

- Invalid protected requests use operation-specific errors in Node; Rust
  incorrectly returned generic validation issues. Invalid cancellation requests
  also require their dedicated error message.
- Failed cancellation returns only `error` in Node; Rust incorrectly added
  `code: "model-operation-unavailable"`.

The Rust handlers now preserve those exact response shapes. The regression
harness uses public enrollment, real authentication, production database access
and real HTTP connections. It installs neither SQL routes nor a command bus
substitute. Cases cover missing/null/array inputs, unknown fields, invalid
identifiers, missing and foreign workers, authentication, CSRF, unconfigured
models, and cancellation against a genuinely offline enrolled worker.

Local macOS arm64 qualification passes all three storage modes and all three
authentication modes: 366 matching Node/Rust case pairs (732 recorded HTTP
responses), with all 18 production server processes closing cleanly. The old
optimized binary reproduces 26 mismatching cases in the no-auth PostgreSQL
profile; that failed result is retained. The 40 inventory, parser, classification
and security regression tests, the refreshed boundary audit, and the retired
workflow check pass. The current TypeScript server build and optimized Rust
build pass, as does strict release-profile Clippy across all targets. The broad
`pnpm check` stops at unchanged Node source line budgets
(`build-app.ts` 1532/1500, `chat-turn-runtime.ts` 2336/1999); downstream checks
were not run by that command.

The qualified Rust executable has SHA-256
`12fe4ca248e1aedd6eeea0a6934487a81ff74dc4ffab9cfb18d59359bb7c2fc1`.
Reports, baseline failures, logs and artifact checksums are retained with the
delivered milestone's local evidence. Successful protected inference, cancellation
of a running operation, direct usage accounting, all current catalog behaviors,
CantripOS lifecycle recovery, and the remaining native Task/Goal cases are
separate acceptance requirements. This boundary harness does not claim them.

## Repeat locally

Use the repository's supported Node toolchain for development commands:

```sh
pnpm --filter @cantrip/version --filter @cantrip/logging --filter @cantrip/protocol --filter @cantrip/server -r build
pnpm audit:server-boundaries
node scripts/server-rust/source-drift-audit.mjs --baseline 951b108cc --report .qa/source-drift.json
node --test scripts/server-schema-source-corpus.test.mjs scripts/surface-private-state-fields.test.mjs scripts/server-route-parser.test.mjs scripts/worker-command-inventory.test.mjs scripts/native-content-classifications.test.mjs
node --import tsx scripts/server-rust/model-operation-boundary-compatibility.mjs --database postgres --report .qa/model-boundary-postgres.json
node --import tsx scripts/server-rust/model-operation-boundary-compatibility.mjs --database bundled-postgres --report .qa/model-boundary-bundled-postgres.json
node --import tsx scripts/server-rust/model-operation-boundary-compatibility.mjs --database pglite --report .qa/model-boundary-pglite.json
```

The HTTP harness accepts `CANTRIP_RUST_SERVER_BINARY` to use an existing built
artifact. PostgreSQL fixtures accept `CANTRIP_RUST_DATABASE_FIXTURE_BINARY` and
`CANTRIP_TEST_POSTGRES_BIN_DIR`. In bundled mode the Node reference connects to
the fixture PostgreSQL process, while Rust owns its private PostgreSQL process.
PGlite qualification materializes an owned runtime from the real Rust binary,
preserving any existing shared runtime cache. Retain the reported fixture roots
and logs until evidence is archived. All validation runs locally; no development
GitHub Actions are required.
