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
