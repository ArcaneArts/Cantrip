# Native project Chat exports

The Rust server implements `POST /api/projects/:projectId/exports/preview` and
`POST /api/projects/:projectId/exports`. The current target is `codex-local`.
The server resolves an owned, ready worktree, selects its owned worker, reads
encrypted Agent history, and relays it through the existing worker protocol.
Workers retain ownership of Codex runtimes and files.

This is a server domain milestone. The full server replacement is still in
progress, and the production default remains Node. The worker remains Node.

## Behavior

An independent generated protocol graph includes all ten project-export schemas. Rust
also implements the configured unique-Chat-id refinement, preserving UTF-16
string identity, strict object validation, defaults, missing/null distinctions,
issue ordering and pretty validation errors. Exports accept at most 20 Chats.

The preview retains the Source target labels and mappings, worker and worktree
metadata, capability/offline precedence, and worker inspection behavior.
Inspection failures become unavailable previews with messages truncated to
2,000 UTF-16 code units. A malformed final preview still uses the application's
existing generic error boundary.

Export admission resolves the worktree before the complete owned worker
catalog. Capability and connection checks precede Chat lookup. Missing or
archived selections, unsupported Task selections, and running or
approval-waiting Chats preserve the Source status codes and precedence.
Selections execute sequentially in the caller's requested order. A failed Chat
produces its own outcome while later selections continue.

The relay uses the existing canonical encoder: object keys sort by UTF-16,
arrays retain order, and JavaScript number/string serialization is preserved.
The begin command carries the SHA-256, byte length and protected title. Uploads
use ordered chunks of at most 256 KiB. Inspection, begin and chunk commands use
30-second deadlines; completion uses five minutes. A reused begin result skips
the upload and completion commands. Chunk acknowledgments remain unparsed,
and worker result identities retain the Source behavior.

Only encrypted Agent message projections enter the transcript. Visible legacy
messages are excluded, ciphertext remains opaque, and the attachment list is
empty. Attachment references remain in the encrypted message projection; the
server does not copy attachment files or project files.

The whole operation belongs to the existing project-operation lifetime owner.
Destroying the HTTP caller does not cancel the remaining worker commands.
Shutdown preserves the ordinary worker disconnect/reconnect-grace behavior,
settles per-Chat failures, and drains admitted work before closing its database.

## Actual database-error compatibility

A real failed SELECT exposed a difference in the initial port. With the message
table temporarily renamed, Source returns the ORM query diagnostic, while the
initial Rust implementation returned a generic Chat repository error. The
diagnostic's `worktree_id` text also affects Source's error classification.

Export reads now opt into the existing query-error context mechanism **after
the actual SELECT fails**. Successful reads use the same repository query and
opaque mapper as before. Other message-read callers retain their existing
error behavior. The comparison suite reproduces the actual query failure,
compares its message and classification, restores the table, and checks every
canonical row for unintended writes.

## Local qualification

Validation runs locally. GitHub Actions is reserved for releases and
deployments. No hosted validation is required or dispatched for this milestone.

The development oracles execute the actual exported TypeScript schemas,
service and route handlers. The integration suite launches each real server,
uses HTTP and App Live sockets, and connects the unchanged production
`WorkerConnection`. Only external export operations are controlled.

Completed component checks:

- 2,185 actual protocol validation and pretty-error comparisons.
- 6,555 additional export comparisons across three base-graph sizes, retaining
  correct references when unrelated protocol nodes are added.
- 23 actual Source relay comparisons, including exact command bytes, canonical
  chunk boundaries, reuse, response validation and 30-second/five-minute
  deadline propagation.
- 329 actual Source route error comparisons, including overlapping classes,
  Unicode case folding, lone surrogates and truncation-before-classification.
- The existing external-history API suite: nine passing tests.
- The existing worker export adapter suite: five passing tests. Its Codex client
  remains controlled; this is not execution against an installed Codex runtime.
- The provider-catalog HTTP regression: 272 paired observations in account and
  anonymous mode on PGlite, covering the incoming model-catalog guard cleanup.

The final integrated `0bde2da05` build passes all nine local combinations of
PGlite, external PostgreSQL and bundled PostgreSQL with anonymous, password and
account authentication. Each cell executes 60 paired scenarios and 69 paired
HTTP observations: 540 scenario comparisons and 621 response comparisons in
total. The suite checks canonical bytes, partial failures, malformed worker
replies, actual SQL failure and worker reconnection.

All nine cells also destroy real HTTP callers and stop/reopen each actual server
and persistent database: 18 caller destructions and 18 server/database reopens
across the two implementations. The interrupted exports retain their matching
outcomes and reuse the completed worker receipt on retry. Worker receipt state
is controlled in the test process; worker-process restart is not claimed.

The SQL evidence includes complete Chat, message, project, source, worktree and
import-job rows. Every ordinary scenario compares before/after state, and the
paired suite reads the retained full snapshots to compare Source and Rust.
Only the fixture's authenticated generated owner identity is normalized.
There are 540 complete paired SQL snapshot comparisons, plus the per-peer
before/after checks around the failed SELECT and actual restart.

Strict all-target Clippy, Rust formatting and changed-file formatting pass.
The import contract regression also passes 5,333 Source cases, and both native
suspension regressions pass. Integration required collapsing seven unchanged
nested guards in incoming Task/model code, removing one unused query constant,
and supplying the absent optional restoration observer in an older test fixture.
No lint suppression or assertion relaxation was added.

Reproduce from the repository root with Node 24, pnpm and Rust installed:

```bash
pnpm install --frozen-lockfile
pnpm --filter @cantrip/version --filter @cantrip/logging \
  --filter @cantrip/protocol --filter @cantrip/crypto \
  --filter @cantrip/glitch -r build
node scripts/server-rust/contracts.mjs
node scripts/server-rust/cargo.mjs test \
  --test project_export_contracts --test project_export_services \
  --test chat_import_contracts -- --nocapture
pnpm --filter @cantrip/server exec vitest run test/external-chat-history-api.test.ts
pnpm --filter @cantrip/worker exec vitest run test/project-export-manager.test.ts

# Set CANTRIP_TEST_POSTGRES_BIN_DIR to the local fixture PostgreSQL bin directory.
for export_database in pglite postgres bundled-postgres; do
  node --import tsx scripts/server-rust/project-export-http-compatibility.mjs \
    --database "$export_database" --lifecycle \
    --report ".qa/project-exports-$export_database.json"
done
```

Each run freezes its native executable and records its SHA-256. Fixture roots,
complete SQL snapshots, worker commands, ciphertext and raw Live observations
remain in the local evidence until a byte-verified archive permits cleanup.
`CANTRIP_RUST_SERVER_BINARY` and
`CANTRIP_RUST_DATABASE_FIXTURE_BINARY` can select already-built test artifacts;
the ordinary build fallback remains available. The final HTTP fixture artifact
has SHA-256
`05bef15777e6e41390c2e6e98b1eec04e365f78bfa61b276f358d1c17c9fad85`.

The first final-matrix attempt encountered actual local disk exhaustion.
Those failures remain in the evidence. Only this goal's old rebuildable compiler
cache and separately byte-verified archived QA copies were removed. The complete
matrix then passed sequentially with frozen executables. PostgreSQL shutdown
failure now preserves the primary harness report while still failing the run.

## Remaining acceptance

Current qualification is on macOS arm64. Linux and Windows readiness must be
demonstrated on those platforms. The controlled transport suite does not prove
actual endpoint-key decryption, native Codex replay, worker-process restart,
physical export receipts or client UI acceptance. Those still require complete
client/worker product exercises. Mixed Node/Rust Redis deployment and packaging
acceptance also remain required.

The broad local `pnpm check` currently fails on unchanged Main Source line
budgets: `build-app.ts` has 1,532 lines against 1,500, and
`chat-turn-runtime.ts` has 2,333 against 1,999 at `0bde2da05`. The independent
boundary audit also reports the pre-existing protected `desktopTarget` accesses
in `cantrip-os-desktop.ts`. These are retained failures, not passing checks.

The original goal still requires representative existing-data upgrades,
data-preserving post-write rollback, supported-platform native/container
artifacts, desktop packaging, Winterhold rehearsal, performance qualification,
default cutover and removal of the production Node server. Production
Winterhold deployment remains outside the authorized goal.
