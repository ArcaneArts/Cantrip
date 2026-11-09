# Current native product and shared Agent recovery

The current macOS ARM64 production server passes the six-case native product
matrix with the current client, rebuilt full Node worker and 92-patch native
runtime. Shared PostgreSQL/Redis peers also pass active Agent and Goal execution
through either peer's SIGKILL. Node remains the default; full replacement is
incomplete.

## Recovery defect and repair

Both production implementations failed the same new worker-owner crash test.
The worker process and original model response survived, but the surviving
executor treated its rejected remote RPC as failed inference. It marked the
Chat failed/unread, deactivated its native activation, suspended the execution
lane and prematurely completed the logical GUI input. The original failures
and their database snapshots are retained.

Both implementations now retain a pending native GUI input on actual command
transport loss. The read takes the existing project/chat locks and requires
the original owner, worker, root generation, logical lineage, current activation
generation and active execution lane. Canceled, replaced, completed, rejected
and never-dispatched authority cannot qualify. No command is resubmitted and
no logical-completion acknowledgment is manufactured. The existing authenticated
worker outcome and canonical-history paths finish the original execution.
This check precedes provider failure, route failover and failed submission
settlement. Ordinary worker execution errors retain their handling. No protocol,
schema or worker implementation changes are required.

## Actual production qualification

The repaired optimized executable is 94,191,104 bytes, SHA-256
`237e1c685a7627f199f5f3e0a8ddc1c3493f8f512d0138e0461ff779afa8490b`.
The supplied native executable's actual SHA-256 is
`02b7577e72397723e9b2b920991cdf8ddb82d034dca96a3c18eb629e19efb5db`.
Its 92-patch source digest is
`11ba64258abf73b678aef876152c131ac3f828163b5a11d258e7ef882ab41cbf`.
The current worker is rebuilt and deployed with production dependencies;
its native tools are retained desktop runtime assets.

`native-product-compatibility.mjs --production-server` exercises actual
production executables without SQL fixture routes. All six cases pass: Task
lifecycle and delegated Agent-to-Task execution on each of PGlite, bundled
PostgreSQL and external PostgreSQL, with both Node and Rust. Totals are 150
product steps, 54 clean worker stops and 144 model POSTs. Operation replay,
decrypted output, native Goal completion, quota failure/retry, paused admission
and exact restart retention keep their original assertions. The default
SQL-diagnostic mode remains available.

The shared recovery matrix runs both crash roles across Node/Node, Node/Rust,
Rust/Node and Rust/Rust. The browser and full worker connect to opposite peers.
Each pair interrupts an Agent model response and then the active Goal's native
completion-tool response. Totals are 120 product steps, 16 intentional SIGKILLs,
32 clean worker exits, 48 normal server exits and 32 model POSTs.

Each interruption retains the worker PID/credential, original open model
stream and inference count. Real Redis claims preserve worker process continuity;
the connection generation changes only when its owning peer is replaced.
Read-only repeatable-read SQL snapshots compare the exact native command,
activation, observed turn, execution lane and queue claim. Goal identity remains
exact and live accounting cannot regress. Both turns finish with one canonical
answer, four total model POSTs per pair, completed native archives and exact
history after a later clean server/worker restart. Existing encrypted-request
and diagnostic privacy assertions remain enabled.

```sh
node --import tsx scripts/server-rust/native-product-compatibility.mjs \
  --production-server --report-directory /absolute/path/to/product

node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --database postgres --server-pair all --native-shared-agent-recovery \
  --agent-crash-peer worker --keep-fixture --report /absolute/path/to/worker.json

node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --database postgres --server-pair all --native-shared-agent-recovery \
  --agent-crash-peer client --keep-fixture --report /absolute/path/to/client.json
```

Use `CANTRIP_TEST_SERVER_BINARY`, `CANTRIP_TEST_WORKER_PACKAGE`,
`CANTRIP_TEST_CLI_BIN`, `CANTRIP_CODEX_BIN`, `CANTRIP_TEST_REDIS_BIN` and the
existing database runtime variables to select the retained artifacts.
Single-server recovery uses the same interruption helper.

## Additional checks and limits

All 91 focused Node admission/completion/outcome/suspension tests and strict
all-target Clippy pass, as do all 80 Rust library tests. The focused logical
repository domain passes 1,443 paired cases, 1,148 snapshots and nine reopens
across all three stores, including canceled/stale/foreign/completed authority
and logical continuations. The reused single-server Agent/Goal interruption
scenario also passes on PGlite for both peers. Its initial independent-domain
fixture failure (missing queue model) is retained; the domain now seeds its own
model rather than relying on an earlier suite.

The source audit matches all 15 schema graphs and the
endpoint-provider map. Validation is local; GitHub Actions remains reserved
for releases and deployments.

The broad repository comparison exposed an obsolete cancellation assertion:
both repositories retain an uncertain Goal setter's claimed input. Its oracle
now requires that exact state and both awaiting/canceled flags, preserving its
parent-command and revision assertions. The subsequent untouched Goal epoch
case still fails on queue revision (both peers return 2 where it expects 1).
That failure is retained; the broad suite is not green. The standard repository
check also fails Node decomposition budgets; downstream aggregate checks have
not passed.

This qualifies server-process interruption with a surviving worker/native
runtime. Worker/native-process death, prolonged network/database/Redis failures,
supported platforms, packaged updates, complete historical upgrades/rollback
and performance remain separate. Current desktop/Winterhold artifact acceptance,
Rust default selection and production Node-server removal remain required.
No Winterhold production deployment is performed.
