# Current Git/GitHub command boundaries

The server replacement remains incomplete. This milestone reconciles 88 current
Git/GitHub worker-command identities against their actual producers and consumers.
The worker remains Node. No production Rust behavior changes were needed.

All 88 types are valid protected repository inner operations. Each is exercised
through both project/worktree and worker-scoped HTTP endpoints using enrolled
credentials and the unchanged worker connection decoder. The controlled endpoint
opens the original request with the real repository-content cryptography, checks
its type, private arguments and server-selected scope, then seals a response that
the caller independently opens. The server sends `repository.operation` and
retains the original opaque request/response bytes. Tests do not execute leaf Git
operations, mutate real repositories or contact GitHub.

The current Source policy tombstones 76 registered plaintext Git/GitHub routes.
Their latent handlers are not authority for restoring plaintext server producers.
Actual HTTP attempts return the same 410 body and headers in both implementations
and dispatch no repository or leaf commands. The checkout-preparation coordinator
helper has one HTTP caller, behind that guard. Its protected inner variant remains
available at the endpoint-owned repository boundary.

There is one active direct producer among these types:
`github.pull-requests.list` from the Task dashboard. It is recorded separately
from the other 87 identities. The dashboard admits one open and one closed read
with the original repository, pagination and filter fields, returns the associated
PR result, and preserves the exact endpoint-encrypted Task. Raw command arrival
order is retained. Source executes concurrent reads with `Promise.all` and actual
runs observe both arrival orders; comparison independently validates each
state-bound request and the complete public dashboard result. This does not
establish ordering between independent concurrent reads.

The comparisons cover native PGlite, private PostgreSQL and external PostgreSQL
with anonymous, password and account authentication. They also reject unknown
fields on the project request and foreign project/worker owners, replace the actual
worker connection, restart the server and preserve server identity. A captured
encrypted request is forwarded again after restart; no at-most-once leaf execution
claim is made for the controlled endpoint. Private request/outcome markers are
absent from HTTP responses and retained server diagnostics.

The [acceptance record](security/rust-server-repository-command-acceptance.json)
binds each protected type to original cryptographic proof records, actual wrapper
commands and successful HTTP traces in all nine cells. It also records every
retired HTTP identity and the active dashboard producer. The run completes 2,361
paired HTTP observations, 6,426 endpoint decryption proofs and 4,848 actual traced
requests, with 3,204 repository wrapper commands and 36 direct dashboard PR-list
commands. The ledger accounts for
244/323 worker-command identities, including 87 endpoint-owned protected inner
operations and the separately qualified direct dashboard command. All 584 HTTP
identities, 121/135 tables, 370 repository identities and 36/47 Live resources retain
their existing scoped mappings. These counts are not a replacement percentage.

Actual Git/filesystem/GitHub execution, broader faults, supported shipping
artifacts, remaining worker/table/Live scopes and the original final acceptance
remain required. No GitHub Actions or production Winterhold deployment was used.

The standard `pnpm check` remains red in the two existing worker capacity/backoff
tests: 744 pass, two fail and two unhandled errors are reported. Fresh clean
Primary reproduction at the exact base has the same failures with byte-identical
worker/test sources. Full formatting reports twelve unchanged Primary files;
changed-file formatting passes. No production Rust sources changed in this
milestone. Earlier fixture SQL failure and unsupported arrival-order assumption
are preserved with their actual Source diagnostics and failing source snapshots.

Run `node --import tsx
scripts/server-rust/repository-command-http-compatibility.mjs` with `--database`
and `--report`; `--profile` and `--keep-fixture` select a scoped run and retain its
database. The existing fixture environment supports frozen HTTP executables and
database assets. Evidence is retained in
`rust-server-repository-commands-delivery-20261110-v1`.
