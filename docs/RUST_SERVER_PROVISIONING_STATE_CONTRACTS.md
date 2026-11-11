# Project provisioning state contracts

The current production Rust server matches the reference in the folder and
replica provisioning comparisons on PGlite, private PostgreSQL and external
PostgreSQL. Both suites now run anonymous, password and account authentication.
Each suite passes all nine local cells. This milestone strengthens acceptance
coverage without changing production Rust behavior. Complete replacement
acceptance remains unfinished.

## Executed comparisons

Fresh frozen executables are built from
`58d6bb70e06d1412fe01c90e6d0bee8f79359df4`. The comparisons run the production
Rust executable and reference HTTP server with isolated stores and unchanged
worker connections.
Workers return controlled folder/replica facts; they do not execute leaf Git or
filesystem operations. The separate SQL observer opens each store only after
its HTTP server has shut down. All execution is local macOS arm64, including
the independent external PostgreSQL service.

| Observation                                                | Count |
| ---------------------------------------------------------- | ----: |
| Paired HTTP observations                                   | 1,119 |
| Complete raw-state reopen comparisons across both peers    |    36 |
| Independently verified admission fingerprints              |   108 |
| Received folder materialization commands across both peers |   198 |
| Received replica/conversion commands across both peers     |   342 |
| Compared Live events across both peers                     | 1,116 |
| Traced requests, including setup and polling               | 4,361 |

The folder suite contributes 465 paired HTTP observations; the replica suite
contributes 654. The Live count includes existing worktree invalidations along
with the newly bound project and provisioning-job resources. Counts are
observations within this scope, not whole-domain completion percentages.

## Existing behavior retained

All existing public response, command and ordered-event assertions remain.
Folder cases cover offline admission, validation, owner isolation, worker
reconnect, failed attachment and retry, four-job capacity, active-command
shutdown and retained restart. External PostgreSQL additionally observes the
actual thirty-second lease renewal and a membership INSERT held through caller
disconnect and shutdown. The write commits after the lock is released, and
restart preserves the admitted project and job.

Replica cases cover provision, managed-link repair, synchronization, removal,
final-source protection, worker failure and retry, reconnect, active-command
shutdown and restart, converted-folder removal, foreign-account rejection and
four-job executor capacity. Conversion metadata is explicitly seeded by the
existing conversion fixture; removal uses production routes and dispatch.
Retaining local files issues no deletion command. Deleting them exercises
worker failure, retry and an already-absent response.

The original lease-expiry replica extension is separately available through
`--lease-recovery`; it is not part of this milestone's replica command line.
Historical qualification of that extension retains its own source/artifact
scope.

## Complete stored rows and request hashes

The new optional `--canonical-state` observation reads every column in
`projects`, `project_folder_setup_jobs` and `project_replica_jobs`, ordered by
stable domain keys. Each peer closes and opens its store twice. The complete
second raw result must equal the first before any normalization. Job/project
ownership and identity relationships, settled state, attempts and revisions are
checked against actual rows.

Generated timestamps are bounded against the actual scenario lifetime.
Generated UUIDs use the existing HTTP fixture identity mapping, while original
raw rows remain in the report. Anonymous and password folder cases retain nine
projects and jobs; account cases exercise the same owned domain with a foreign
account. External PostgreSQL retains the extra disconnected admission. Each
replica case retains six projects and sixteen complete job rows.

The first replica run exposed six different stored `payload_fingerprint`
values per pair because accepted operation requests contain independently
generated replica UUIDs. The original HTTP, command, Live and exact raw-reopen
assertions passed; these differences were retained.

The final suite captures the actual successful HTTP admissions. For every
stored synchronize/remove operation, it parses that exact input with the
authoritative protocol schema and recomputes SHA-256 over the original ordered
request payload. The stored hash must match. Only then does the comparison
derive a second hash over the identity-normalized payload. Both payloads,
hashes and original job identities are retained. This preserves actual hash
validation while allowing isolated databases to have different generated IDs.

## Coverage and evidence

The [acceptance record](security/rust-server-provisioning-state-acceptance.json)
binds five worker command identities to actual received commands:
`project.replica.provision`, `project.replica.synchronize`,
`project.replica.remove`, `project.replica.link.repair` and
`project.folder.delete`. It also binds the three tables above and the
`project`, `project-folder-setup-job` and `project-replica-job` Live resources.
Bindings retain exact report pointers, source/report/trace hashes and the
frozen executable receipt.

The ledger now accounts for 253/323 worker commands, 129/135 tables and 40/47
Live resources, including partial scopes. HTTP and repository totals remain
584/584 mapped and 370/370 accounted for. Other consumers of these identities
retain their separate qualification requirements.

Reproduce with built workspace packages and reference server, native server
and project-repository executables, and the existing database runtime fixture
environment variables:

```sh
node --import tsx scripts/server-rust/folder-http-compatibility.mjs \
  --database pglite --canonical-state --keep-fixture \
  --report /absolute/path/folder.json

node --import tsx scripts/server-rust/replica-import-http-compatibility.mjs \
  --database pglite --connected --faults --reconnect --shutdown \
  --converted-removal --concurrency --canonical-state --keep-fixture \
  --report /absolute/path/replica.json
```

Repeat with `bundled-postgres` and `postgres`. Both suites run all three
authentication profiles by default and accept `--profile` for focused work.
Failures retain their fixture roots. Reports, runtime assets, executables,
traces and original comparison failures are retained in the external
`rust-server-provisioning-state-delivery-20261110-v1` archive.

## Local checks and remaining work

The required `pnpm check` retains 744 passing worker tests and two existing
capacity/backoff failures plus two unhandled errors. Both failures reproduce
on clean Primary at the same base commit with byte-identical source and tests.
Full formatting reports twelve unchanged Primary files. Neither aggregate
check is claimed to pass. Changed-file formatting, boundary checks and the
final integrity review are recorded separately. The refreshed source drift
audit matches all seventeen generated contract graphs/maps; that is schema
evidence, not a whole-server behavior claim.

Actual leaf Git/filesystem execution, remaining job consumers and historical
partial scopes, broader fault/coordination behavior and final supported-platform
shipping acceptance remain required by the original replacement goal. No
GitHub Actions or production Winterhold deployment is performed. The worker
remains Node.

## Packaged replica lifecycle and shared peers

The optimized macOS ARM64 server distribution `1.1.2858` ran with the browser
SDK and the existing packaged worker on PGlite, bundled PostgreSQL and
external PostgreSQL. Each run attached a real Git checkout through a second
worker, retained the same completed job and repository revision across
restart, refused deletion of the user-owned checkout, and detached it while
preserving its files, HEAD and original project source. Browser requests kept
private names and paths opaque.

With shared PostgreSQL and Redis, both workers connected to the second server
and the browser connected to the first. All four Node and Rust pairings passed.
After the attachment committed, the fixture killed the browser-facing server
and replaced it on the same port. Both remote worker connection claims stayed
unchanged. The browser resubscribed to App Live, recovered the same completed
job and replayed the same admission at attempt one, revision six. The replay
published one invalidation at that revision. Normalized job events matched in
order across each comparison. The six single-server and four shared runs
recorded 124 product steps, 42 clean server exits, four intentional peer kills
and 60 clean worker exits.

The controlled-worker comparison on the same package passed all nine store
and authentication combinations with 654 paired HTTP observations. It checked
successful synchronization and managed-link repair, retry and cancellation,
shutdown and reconnect, capacity, and all ten cross-account route denials on
each store. Every reopened store retained all 16 replica jobs and matched its
first raw read. The suites recomputed 108 stored admission fingerprints across
both runtimes.

The external PostgreSQL lifetime comparison passed ten paired lock races and
four paired caller disconnects. The production lease comparison preserved a
renewed job's first attempt and recovered the expired job on its second
attempt after the stale completion.

The [packaged replica acceptance record](security/rust-server-current-replica-acceptance.json)
binds the executable, worker, harness and reports to all ten routes, the
`project_replica_jobs` table and the `project-replica-job` Live resource. The
current managed-link repair and synchronization cases use controlled worker
responses. Full managed Git execution on this candidate, dependency loss
during shared replica dispatch and final shipping artifacts remain open.

Set the existing fixture variables to the packaged server, database assets,
worker, CLI and Redis executables. With the workspace packages and Node
reference built, run the browser comparison on each store and the shared
comparison on external PostgreSQL:

```sh
node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --replicas --production-server --database pglite \
  --report /absolute/path/replicas-pglite.json

node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --replicas --database postgres --server-pair all \
  --report /absolute/path/shared-replicas.json

node --import tsx scripts/server-rust/replica-http-lifetimes.mjs \
  --report /absolute/path/replica-lifetimes.json

node --import tsx scripts/server-rust/replica-import-http-compatibility.mjs \
  --database postgres --profile accounts --connected --faults --reconnect \
  --lease-recovery --report /absolute/path/replica-leases.json
```
