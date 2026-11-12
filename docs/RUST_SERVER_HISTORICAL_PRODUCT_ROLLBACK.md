# Historical product-state upgrade and rollback

This qualification uses the real packaged Node `1.1.2733` distribution and an
original stopped historical PGlite profile. The optimized native candidate is
macOS arm64 `1.1.2779`, executable SHA256
`bc5cb46a18b2315fb6f4845f3c983a9f1ae6f7d8b7b21544b536eb76d360dcba`.
Node was the default server at that revision.

## Populated fixture and real serving processes

The original profiles were first inventoried on private copies. They contain
136 public/Drizzle tables but little product content. The original CLI profile
has 1,773 files; its server identity is retained throughout this test. An older
runtime version is not evidence of an older SQL schema: both this source and the
candidate use the actual 287-entry migration chain. Historical migration-prefix
qualification remains separate.

The driver copies the stopped original, establishes a password-authenticated
session through the old server, initializes real password and HPKE client key
wrappers, and enrolls a synthetic worker through the public enrollment exchange.
It then populates related project/source/worktree records, an Agent Chat, a draft
Task, three encrypted messages, a frozen queue item, an encrypted composer draft,
a document reference, and a validated empty history checkpoint receipt. Tasks
and automation are paused; no real worker or project operation is dispatched.
After enrollment, the synthetic worker receives the historical fixture's
last-seen timestamp before the baseline. Each comparison therefore observes
the same stopped-worker state instead of crossing the fresh enrollment's
presence-expiry boundary.

Protected content is produced by `@cantrip/crypto`, with component and field
keys derived from the fixture account master key. Private fixture keys remain
outside every server profile. Every serving phase unwraps the retained master
key using both its password wrapper and its actual client grant, then decrypts
the returned message, queue, Task, composer and document content. The original
worker credential summary is also retained. Credential authentication and
canonical native-history execution replay are not exercised by this driver.

Both peers use their ordinary production entry points. No SQL HTTP route,
injected bridge or permanent JavaScript database helper is installed.

## Executed transfer sequence

The final local macOS arm64 run passes all three backends. Its baseline has
35 nonempty tables, and every transfer compares 137 tables and four sequences.
The Task advances from row version 2 in the old baseline to 3 through Rust, 4
through the old Node server and 5 after returning to Rust. Each backend also
retains all three original messages, its frozen queue item and four final
document references.

For each of PGlite, bundled PostgreSQL and external PostgreSQL:

1. Read and write the populated profile through the real old Node server. Keep
   its actual session cookie, CSRF token, server identity and encryption grants.
2. Run the packaged offline converter and restore the complete profile into
   the selected native backend. Compare all 137 tables, including the dedicated
   migration probe, and all four sequences against the source. Verify the exact
   additional import receipt and its timestamp instead of removing arbitrary
   differences from the comparison.
3. Use the original session through Rust to change the encrypted Chat title and
   composer draft, update the Task with its row-version fence, and create an
   immutable encrypted document reference. Restart Rust and require identical
   accepted product DTOs and successful client-library decryption.
4. Export the written native profile and reverse-convert it. Before starting
   Node, compare every table, sequence, probe function result and SQL/JSON null
   distinction against the stopped written native database.
5. Start the real old Node distribution on that reverse-converted profile.
   Require the complete latest product DTOs accepted by Rust, with the original
   session and identity. Accept a further set of Node writes through the same
   public APIs.
6. Convert that written profile back to Rust in the selected backend. Repeat
   the complete database comparison, read the Node-accepted DTOs, accept another
   set of Rust writes, and restart once more to verify their retention.

The raw snapshots select `to_jsonb(t)::text` and sort the row strings. Large SQL
integers and numeric values never pass through JavaScript number parsing. The
probe also covers binary data, microsecond timestamps, array nulls, JSON null,
SQL null, Unicode and line endings. Exported/imported files include the original
server secret-encryption key, a byte-exact private archive and an empty directory.
The archive retains mode `0600`.

The source's complete byte/mode manifest is checked after conversion and at
the end. Local execution additionally denied writes to both preserved original
profile directories with the inherited macOS sandbox. A separate non-mutating
descriptor-open witness observed actual `EPERM`; requesting a deny policy alone
was not treated as proof of enforcement.

## Current packaged round trip

The optimized macOS ARM64 `1.1.2881` package at
`ccafd3cd4baea444ab43c1b84471ab3225f718e3` passed the original Node
`1.1.2733` upgrade, post-write rollback, and return to Rust on all three
stores. The first import applied `0287_task_output_finalization` and
`0288_task_provider_transfer_eligibility` to the original 287-entry migration
chain. The independent upgraded snapshot verified all 137 tables and four
sequences. Rust, old Node and returned Rust each accepted four encrypted
product writes per store. The original session, identity, file contents and
modes remained intact. An attempted writable descriptor on the original
profile was denied with `EPERM`.

The [macOS acceptance record](security/rust-server-2881-macos-acceptance.json)
contains the exact release and round-trip report hashes.

### macOS ARM64 candidate `1.1.2869`

The macOS ARM64 `1.1.2869` package passed the complete round trip from the
actual Node `1.1.2733` installation across all three stores. The old
profile has 287 migration entries. The first import applies exactly one
migration, `0287_task_output_finalization`. The harness constructs the
expected upgraded state in an independent copy of the old database and
compares the migration hash, new column default, all 137 tables and all
four sequences. The second Rust import retains the existing migration
entry and applies zero migrations.

Each runtime retains the same session, server identity, encrypted state
and the latest writes across rollback and restart. The protected original
profile stays byte-for-byte unchanged. The first run's zero-migration
expectation failed before the new comparison, and its report is retained.
[Historical profile acceptance record](security/rust-server-2869-historical-profile-acceptance.json)

### macOS ARM64 candidate `1.1.2845`

The complete driver passed again with the optimized macOS ARM64 `1.1.2845`
package at `2e60d2042203f64c8105d5c52d12ae1db92d2d83`. It ran the actual
`1.1.2733` Node distribution and original profile across PGlite, bundled
PostgreSQL and external PostgreSQL. The 137-table and four-sequence
comparisons passed in each mode. The original session, server identity and
decryptable content survived each conversion. Rust, Node and the returned
Rust server each accepted four product writes per mode, and the suite
verified retained state after restart. The original source files remained
unchanged under a sandbox that denied an actual open for writing. The
[macOS acceptance record](security/rust-server-darwin-arm64-acceptance.json)
contains the exact candidate and report checksums.

## Running the acceptance

Build the protocol/crypto packages and the disposable native snapshot probe:

```sh
pnpm --filter @cantrip/crypto... build
node scripts/server-rust/cargo.mjs build --example database-transfer-fixture
```

Supply a stopped historical profile, its real old server distribution, the
packaged bounded converter, the native distribution and the built probe:

```sh
node --import tsx scripts/server-rust/historical-product-profile-acceptance.mjs \
  --root /absolute/path/to/new-evidence-directory \
  --legacy-profile /absolute/path/to/stopped-original \
  --legacy-server /absolute/path/to/old-node-distribution \
  --artifact /absolute/path/to/native-distribution \
  --converter /absolute/path/to/profile-converter \
  --snapshot-probe /absolute/path/to/database-transfer-fixture
```

Set `PGLITE_RUNTIME_DIR` to the native distribution's `pglite` directory and
`CANTRIP_TEST_POSTGRES_BIN_DIR` to the PostgreSQL bin directory recorded in its
`native-server.json`. All three backends run by default; `--modes` selects a
comma-separated subset. `--expected-legacy-version` can assert the actual
bootstrap version. The evidence directory must be new. Reports contain
synthetic credentials and private fixture material and are local QA artifacts.

## Limits and remaining work

This is a populated, synthetic product-state preservation test based on a real
older runtime/profile. It extends the existing preference and encrypted-workspace
rollback evidence. It does not complete every historical profile, supported
platform, full-client update or in-flight execution/replay scenario. The history
checkpoint is deliberately empty; its preservation is not canonical-turn replay
acceptance. The document test preserves encrypted references, not a live editor's
unsaved buffer. The separate existing-client macOS app still awaits Keychain
access while the console is locked.

Development validation is local. The aggregate `pnpm check` still stops at the
pre-existing `build-app.ts` 1,539/1,500 and `chat-turn-runtime.ts` 2,329/1,999 line
budgets. Later aggregate checks are not claimed as passing. Full replacement,
remaining product/fault/platform/performance acceptance, Rust default selection
and production Node-server removal remain incomplete.

Earlier failures are retained: the first setup incorrectly combined password
authentication with the development-only worker token; a document creation
assertion assumed 201 although both real peers return 200; and a synthetic
unenrolled worker correctly rejected credential rotation. The fixture now uses
the real enrollment exchange. A later run passed two backends before observing
the enrollment presence TTL expire during the third backend's DTO comparison;
the historical offline timestamp above resolves that fixture timing issue.
The exact database and DTO comparisons remain in place. The history checkpoint
fixture was also strengthened to use the actual batch/receipt schemas and
canonical payload digest; the final run covers that validated form.
