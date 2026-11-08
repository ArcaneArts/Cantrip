# Current replacement acceptance

The server replacement remains incomplete. Node is still the default server,
and the worker remains Node. Historical ledger entries describe their original
milestones; their remaining-work text is not a current implementation inventory.

## Current implementation and evidence

| Area                          | Current evidence                                                                                                                                                                                                           | Remaining acceptance                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Declared HTTP routes          | The computer-use milestone's production probe completes 584 requests per peer with zero generic fallback differences.                                                                                                      | Successful behavior, events and recovery across complete domains; invalid-input routing alone is insufficient.                              |
| Generated contracts           | The refreshed source audit compares all 15 embedded schema graphs plus the endpoint-provider map with rebuilt TypeScript. All 16 match.                                                                                    | Custom semantics and full runtime/product/platform qualification.                                                                           |
| Desktop packaging             | PR #2749 integrates the production supervisor and explicit Rust runtime packaging.                                                                                                                                         | Current integrated artifacts, supported platforms, update behavior and final default selection.                                             |
| Existing desktop profiles     | PR #2752 packages and automatically invokes bounded conversion. Its archived eight-case acceptance and actual app upgrade, post-write Node rollback and native re-upgrade pass locally.                                    | Broader historical profiles, current artifacts, other platforms and full product rollback.                                                  |
| Winterhold                    | PR #2753 implements native distribution installation, migrations, systemd and Caddy. Its archived local three-store rehearsal exercises 18 installer calls and external PostgreSQL Node/Rust post-write rollback over TLS. | Current artifacts and remaining platform/product/coordination/performance qualification. No production deployment is authorized or claimed. |
| Worker mutation notifications | Enrollment-code creation, credential rotation and credential revocation now publish the existing worker invalidation after successful response completion.                                                                 | Supported-platform/package and full product acceptance.                                                                                     |

Desktop and Winterhold are implemented with scoped qualification; their previous
ledger status of `unported` was stale. The profile reports were read from the
retained archive and checked against their original member hashes during this
reconciliation. They retain their historical source/artifact scope. The Winterhold
result uses an ARM64 systemd fixture executing an x64 artifact through binfmt;
it does not establish bare-metal x64 or Windows readiness.

## Reproduced worker notification gap

The existing Node response hook publishes a `worker` invalidation for successful
mutations under `/api/workers/`. Rust's legacy enrollment/credential handler
omitted this effect, even though later worker-management handlers implement it.
A real HTTP/App Live comparison reproduced a successful native enrollment-code
creation with zero events against the reference's one event. The original
failure is retained.

The repair uses the existing response-completion adapter. Enrollment-code
creation retains a null entity identity; credential rotation/revocation retain
the worker identity. Reads, rejected mutations and internal worker requests do
not acquire a new broad invalidation. Real presence events remain separate.

All nine macOS arm64 storage/authentication pairs pass: PGlite, bundled PostgreSQL
and external PostgreSQL, each with none/password/accounts authentication. They
retain 99 paired HTTP observations, 81 paired publication observations, 27 paired
successful invalidation events and 18 clean server exits. No worker command
implementation is substituted; rotation exercises an offline enrolled worker.
The fixture observes actual audit completion before checking events: PostgreSQL
can finish Node's audit hook after the response body arrives. Earlier oracle
timing failures and the original missing-notification result remain retained.

Strict all-target Clippy and all 76 Rust library tests pass locally. This is
not full replacement acceptance. Development validation remains local; GitHub
Actions is reserved for releases and deployments.

```sh
node --import tsx scripts/server-rust/worker-enrollment-live-compatibility.mjs \
  --database pglite --report /absolute/path/to/enrollment-live.json

node scripts/server-rust/source-drift-audit.mjs \
  --baseline 8bc4c5d8100124136b4d77df387b69164f5e40da \
  --report /absolute/path/to/source-audit.json
```

Build the current workspace packages and Node reference first. Supply the native
HTTP fixture, private PostgreSQL helper/binaries and native PGlite runtime through
the same environment variables used by other server comparisons. Repeat the
notification suite for both PostgreSQL modes and all authentication profiles.

## Open background-service comparisons

The current composition has native implementations for the seven durable job
families: replicas, folder setup, workspace repository discovery, standalone
roots, GitHub conversion, Chat relocation and Chat import. Their startup recovery,
queued work and periodic sweeps are composed in `auth/service.rs`. Existing
milestones retain their separate behavior and interruption qualifications.
This source mapping does not prove every background-service invariant.

The [approval-expiry qualification](RUST_SERVER_INTERACTION_EXPIRY.md) reproduces
and repairs the first discrepancy, including the existing Node account-owner
and shutdown-restoration defects. All nine local storage/authentication pairs
and a real held-SQL shutdown pair pass. Current artifact/platform acceptance
remains separate.

The [worker catalog/quota comparison](RUST_SERVER_WORKER_CATALOG_REFRESH.md)
reproduces missing native reconnect refresh, implements that refresh and the
fifteen-minute producer, and passes all nine local storage/authentication pairs.
Separate peers also pass the real fifteen-minute interval and a held quota
INSERT during shutdown. The current optimized executable also passes the actual
fifteen-minute interval and held-INSERT shutdown with fixture SQL routes absent
on both peers. A broader catalog comparison additionally repairs the custom endpoint
label in native errors and worker commands.

The [credential reconnect qualification](RUST_SERVER_CREDENTIAL_RECONNECT.md)
reproduces and repairs the next discrepancy: Rust's existing migration
coordinator had no production worker-connection caller. All nine local
storage/authentication pairs now match capture/purge, identity and revision
guards, nonportable credentials, failures, repeated reconnects and public
counter logs. The current optimized artifact also passes actual deadlines,
query failure/recovery, held credential UPDATE shutdown and retained
restart/purge. This does not establish real provider login or actual worker
credential-file encryption/deletion.

Remaining background/operational reconciliation includes production log
consumers and buffer/archive services. Source composition mapping and these
scoped comparisons do not prove complete background-service invariants.

Continue those comparisons before final product/fault/performance and supported
artifact acceptance. Rust default selection and production Node-server removal
remain required. Schema equality, source pairing and zero route fallbacks do not
substitute for those requirements.
