# Current HTTP inventory reconciliation

The live inventory audit identifies missing Rust HTTP behavior in addition to
historical coverage-ledger omissions. Four lifecycle/preference endpoints now
pass [project-administration qualification](RUST_SERVER_PROJECT_ADMINISTRATION.md);
the current live probe retains 29 active fallbacks. Node remains the default
server and the full replacement is incomplete.

## Executed discovery

Baseline `898af08e4d87b41dc443288e66b038082b6f6b56` declares 584 routes, 323
worker commands and 135 tables. An isolated local macOS arm64 PGlite run sent
all 584 declared method/path pairs to each current production router. Resource
parameters were absent UUIDs and mutation bodies were empty JSON objects. All
1,168 requests completed and both servers exited zero.

Rust returned its generic route-not-found response on 105 requests where Node
returned another contract. Seventy-two are already-retired repository routes;
33 are active endpoints. Matching invalid-input or absent-resource responses
does not establish successful behavior. This probe also does not compare every
response field, authenticate WebSocket upgrades or qualify other platforms.

The repeatable command uses the actual built Node server and native executable:

```sh
CANTRIP_RUST_SERVER_BINARY=/absolute/path/to/cantrip-server \
PGLITE_RUNTIME_DIR=/absolute/path/to/materialized-native-runtime \
  node --import tsx scripts/server-rust/http-route-inventory.mjs \
  --report /absolute/path/to/report.json
```

Build the workspace packages and Node server first. The audit retains isolated
profiles, complete process logs, all responses, executable/inventory hashes and
actual exit statuses. Its exit status is nonzero while generic Rust fallback
differences remain. It is a development inspection command, with no deployment
or normal-startup gate.

## Retired repository contract

The native router now registers the 77 routes derived from the existing Node
request policy and explicit Git-agent tombstone. Five GitHub catalog routes
already had the correct prefix rejection; the other 72 previously fell through
to 404. No plaintext repository handler is restored.

General retired requests retain authentication, CSRF and transport checks, then
return the existing 410 before body parsing and API rate limiting. The separate
Git-agent draft endpoint retains normal parsing and its hosted request budget
before its distinct 410 response. General GitHub prefix rejection also applies
to unknown paths and unsupported methods, as it does in Node.

Unsupported methods on known project paths retain ordinary route-not-found
behavior. Their rate keys and audit events use the actual unmatched path,
without a project resource ID inferred from Axum's method-router path. The
initial paired regression caught that audit difference despite matching 404
responses; the native middleware now preserves Node's attribution.

The HTTP comparison checks every retired route, automatic HEAD, malformed and
oversized bodies, unsupported media types, unsupported methods, unknown paths,
authentication/CSRF/origin precedence and actual persisted audit attribution.
A hosted account profile additionally exercises more than 120 malformed
requests to the same retired route, exact per-route Git-agent budget exhaustion,
independent route budgets and Retry-After against the actual first request's
sliding-window bounds. Local deployment disables general API limits; the
initial fixture's contrary assumption is retained as a test-plumbing failure.

`removed-repository-contract.mjs --write` regenerates the embedded route list;
without `--write` it compares the list with current Source. Run both commands
with `node --import tsx`. `removed-repository-http-compatibility.mjs` accepts
`--database pglite|bundled-postgres|postgres`, an optional `--profile` and
`--report`. The PostgreSQL run also includes `hosted-accounts`; use the existing
`CANTRIP_TEST_POSTGRES_BIN_DIR` and `CANTRIP_RUST_DATABASE_FIXTURE_BINARY` inputs
to use a supplied private PostgreSQL distribution and fixture executable.

## Qualified local result

All three final database matrix processes exited zero. Ten profile pairs retain
2,518 matching observations (5,036 Node/Rust responses), selected security/cache/
CORS headers, HEAD lengths and persisted audit attribution. All 20 production
server processes exited zero. The hosted profile additionally retains identical
Git-agent budget sequences; each peer reaches 429 after 116 further 410 replies,
with Retry-After bounded by its actual first request.

| Configuration                                     | Profile pairs | Compared responses |
| ------------------------------------------------- | ------------: | -----------------: |
| Local PGlite, none/password/accounts              |             3 |              1,436 |
| Local bundled PostgreSQL, none/password/accounts  |             3 |              1,436 |
| Local external PostgreSQL, none/password/accounts |             3 |              1,436 |
| Hosted external PostgreSQL, accounts              |             1 |                728 |
| Total                                             |            10 |              5,036 |

Qualified native executable SHA-256:
`78e8e3649f59b86fe65b567ebcdb4c3673ad132bb3447b69cc0f308f9a7f8957`.
That milestone's repeat production inventory run completed all 1,168 requests
with both process exits zero and 33 active fallbacks. The subsequent native
project-administration implementation resolves four; the current probe completes
the same 1,168 requests with clean exits and exactly 29 active fallbacks below. The inspection command therefore exits one, as intended for an unfinished
replacement. Earlier discovery and fixture failures are retained separately.

Fresh workspace/Node builds, contract comparisons, source/boundary/workflow
audits, strict all-target Clippy, all 63 Rust library tests and formatting/syntax
checks pass locally.
The standard `pnpm check` still stops at unchanged Node source limits:
`build-app.ts` 1,532/1,500 and `chat-turn-runtime.ts` 2,336/1,999. Downstream
aggregate checks did not run. This result does not establish platform/package,
complete-domain, performance or replacement acceptance.

## Active route gaps

The remaining active families require complete behavior, including their
authorization, persistence, worker commands, notifications and recovery. An
error-body shim or a registered path alone does not satisfy these requirements.

| Family                                | Routes | Missing public behavior                                                      |
| ------------------------------------- | -----: | ---------------------------------------------------------------------------- |
| Computer use                          |      4 | Operation, preview open/stop and internal agent authority                    |
| Chat control and execution lanes      |      4 | Compaction, worktree selection, lane list and release                        |
| Project/terminal context and insights |      5 | Repository stats, token usage, Task workload and script-command context      |
| Remote desktops and surfaces          |     12 | Project catalogs/fleet, creation, reading/updating, connection and lifecycle |
| Worker logs                           |      2 | Retained reads and streaming                                                 |
| Health and metrics                    |      2 | Authenticated operational health and authorized Prometheus output            |
| Total                                 |     29 |                                                                              |

Existing Rust repositories and worker transports can support parts of these
families, but their corresponding production HTTP behavior still needs to be
ported and qualified. The ledger records these routes explicitly as unported.
Other category rows and background-service limitations still require
reconciliation. Final platform/artifact, migration/rollback and performance
acceptance, default Rust selection and production Node-server removal remain
required. No development GitHub Actions are used by this audit.
