# CantripOS root-system qualification

The existing browser SDK, production servers, full Worker and actual Docker
guest now share a root checkpoint, replacement and rollback scenario. All
production implementations are unchanged. The Rust server needs no Node server
delegate for these operations; the existing Worker remains Node as required by
the server replacement goal. Node remains the default server.

## Packaged macOS ARM64 1.1.2938

The current Rust standalone package and compiled Node reference passed
all six root-system cells across PGlite, bundled PostgreSQL, and
external PostgreSQL. All 41 normalized snapshots matched in each pair.
Each cell verified five authenticated private outcomes, two actual
server crashes, one actual worker crash, and the exact 21 Docker
effects. The PGlite peers ran separately against the same guest image
before comparing their snapshots.

The guest image uses the recovered local Docker snapshot chain from the
PGlite qualification. Rebuilding the shared protocol while the first
bundled PostgreSQL run was active triggered a browser reload. The run
failed and was retained. Both PostgreSQL pairs passed after that build
finished.
[Current packaged root-system record](security/rust-server-2938-darwin-arm64-root-system.json)

## Scenario and failure boundaries

`actual-folder-client.mjs --cantrip-os-system` uses the same staged runtime,
image and public catalog inputs described in
[lifecycle qualification](RUST_SERVER_CANTRIP_OS_LIFECYCLE.md#executed-behavior).
It retains that scenario's actual post-commit workspace Server SIGKILL and
lost-reply recovery, then exercises five root operations:

1. Write distinguishable Unicode/binary root and mounted files with exact modes
   and ownership. Capture the stopped root through the normal Worker. Hold the
   real Docker commit acknowledgement after the daemon has created the image,
   then SIGKILL the actual Server. Release the acknowledgement to the original
   Worker. The browser's lost request fails; observation through the replacement
   Server recovers one encrypted checkpoint with exactly one Docker commit.
2. Change root and mounted files, then delete the committed private image.
   Restore from the encrypted Worker archive through actual verification,
   decryption and Docker image loading. The earlier root returns while mounted
   writes remain current. The exact original container stays stopped with its
   later root intact. Explicit physical-identity recovery and guest runtime
   observation are separate actions.
3. Write a later replacement root and newer mounted data, then disable the
   executor. Rollback activates the exact original container, preserves current
   mounted files and retains the replacement's later root in its stopped
   container. The disabled executor preference remains disabled until explicitly
   enabled. No historical runtime handle is restored.
4. Reset to the exact observed foundation image. Hold the actual candidate-create
   acknowledgement after Docker creates it, then SIGKILL the full Worker. The
   Server retains an unknown admission. After Worker restart, observation cannot
   stop, start, rename or recreate a root: the original stays running under its
   original name and the candidate remains stopped. Explicit continuation
   activates that same candidate once, and identity recovery is again explicit.
5. Write to the base candidate and mounted files, then roll back. The original
   root and the base candidate's later root both remain available; mounted files
   retain their newest contents. Server/Worker restart preserves the complete
   history, exact ciphertext and original authenticated contexts, without another
   root transition or a changed current container start timestamp.

The browser authenticates every private result before use and again after all
maintenance fences and restart. Public root receipt identities/digests are bound
to the authenticated private operation. All root file bytes, modes and UID/GID
values are checked independently through Docker, including stopped retained roots.

A transparent owned Unix-socket proxy holds only the selected successful Docker
response. It forwards ordinary HTTP streams and upgraded native executor
carriers; no Worker handler, manager, guest program or database route is replaced.
Only the full Worker receives its `DOCKER_HOST` override. The test driver retains
the actual daemon connection for independent observations.

Each cell requires exactly 21 observed root effects: one commit, two creates,
five starts, five stops and eight renames. Replay and observation cannot add an
effect. All 41 snapshots compare every normalized field, retaining identity
relationships, missing/null distinctions and receipt structure. Valid timestamps,
relational UUID/container identities, encrypted nonce/ciphertext bytes and a
checked request digest are normalized; raw histories and private/public receipt
bindings are checked separately.

## Executed local matrix

Source baseline: `7c1433b3b455f179adee6cc3db01b5865c79d50b`.
Unchanged optimized Rust executable SHA-256:
`20bb778bd097862de7be6e51ee9d2c90c57dce27700c14e856b53ce36054b985`.

| Configuration                          | Cells | Product steps | Snapshots | Server / Worker SIGKILLs |
| -------------------------------------- | ----: | ------------: | --------: | -----------------------: |
| Node/Rust, external PostgreSQL         |     2 |            32 |        82 |                    4 / 2 |
| Node/Rust, bundled PostgreSQL          |     2 |            32 |        82 |                    4 / 2 |
| Node/Rust, PGlite                      |     2 |            32 |        82 |                    4 / 2 |
| All four Node/Rust Redis peer pairings |     4 |            64 |       164 |                    8 / 4 |
| Total                                  |    10 |           160 |       410 |                  20 / 10 |

All four final matrix processes exited zero. A separate comparison verifies
every cell against the same baseline, the 20 intentional Server kills and ten
Worker kills, 42 clean Server exits and 50 clean Worker exits. All 124 complete
Server stdout/stderr logs and observed Server HTTP requests exclude the clear
and encoded private root markers. Shared cells use real Redis 8.10.3 with browser
and Worker on opposite peers; the browser's Server is interrupted during capture.

The platform is macOS arm64 with account authentication. Node's bundled-PostgreSQL
reference connects to a private external fixture; Rust manages its private
PostgreSQL process. The owned native PGlite runtime matches all 711 entries of
the prior verified archive. Current Node/Worker/workspace builds pass; all four
compiled workspace dependencies and the raw current `os-host` package are staged
in the full Worker. Unchanged packaged assets match 9,961 cold-archive entries.

The normal ARM64 guest image and archive are the exact artifacts from the
preceding lifecycle milestone:
`sha256:0f167ee073c93b20e56a10742776b6487a9f66190124f98fb169fffd834692a4`;
archive SHA-256 `3feeb365240d146d97f25d9a424443e277840f2f300e653f0e5e81d3f8854143`.
It is loaded under a separate QA tag with tag metadata changes only.

Final reports are `{postgres,bundled-postgres,pglite}-matrix-v1.json`,
`shared-matrix-v1.json` and `final-comparison.json` under retained
`.qa/rust-cantrip-os-system-product` evidence. Earlier complete Node/Rust smoke
runs remain separate. The unchanged lifecycle scenario also passes its focused
Node/Rust PostgreSQL regression with all 44 snapshots per peer. Owned retained
containers/private images are tracked explicitly; all three persistent guest
directories are captured before successful cleanup.

Formatting, syntax, all nine generated-contract comparisons and the server-boundary
and release-only workflow audits pass locally. `pnpm check` still stops at
unchanged Node line budgets: `build-app.ts` 1,532/1,500 and
`chat-turn-runtime.ts` 2,336/1,999; downstream checks did not run. No development
GitHub Actions job was dispatched.

This result covers the stated Docker response-loss boundaries, rather than every
missing/corrupt receipt, native-process failure, database/Redis outage, SSH guest,
rendered UI or current packaged platform. Remaining coverage reconciliation,
supported-platform artifacts, final migration/rollback and performance acceptance,
Rust default selection and production Node-server removal remain required. Full
replacement remains incomplete.
