# CantripOS lifecycle qualification

The existing browser SDK, production servers, full worker and actual CantripOS
Docker guest now share a workspace, desktop, power and package lifecycle scenario.
No guest command handler, server bridge or database route is replaced. No
production implementation change was needed. Node remains the default server;
the full replacement goal remains incomplete.

## Executed behavior

`actual-folder-client.mjs --cantrip-os` exercises account authentication,
encryption grants and the normal administrative APIs:

- Inspect and attach a fresh guest, then retain a workspace-create draft before
  sending it. After the actual server commits the ready receipt, withhold the
  browser reply and SIGKILL that server. Observation through its replacement
  returns the exact original receipt. The original full worker's start time
  remains unchanged, and repeated create leaves one workspace account.
- Start, restart and stop that workspace's desktop through its actual native
  executor. Repeated admission preserves the exact observed guest desktop target
  and never repeats the transition. Desktop actions preserve the executor runtime.
- Stop, start and restart the retained Docker instance. Root and workspace files
  retain exact bytes, modes and ownership. Lose the restart's HTTP reply, reload
  its saved draft and observe/replay the original admission. Docker start/finish
  timestamps cannot change on replay. Explicit recovery observes the new executor
  runtime; historical stopped completion remains separate from current power.
- Discover two freshly built public package artifacts through the ordinary
  worker-owned catalog. Upgrade the actual workspace package, then remove its
  helper and disable the executor before repairing it. Each admission performs
  exactly one actual `dpkg` configuration. Replay/observation retain the exact
  protected result and cannot configure again. The browser authenticates and
  decrypts both private outcomes with its real repository-content grant.
- Package admission deliberately clears execution authority. Recovery with the
  old runtime returns 409; fetching the current instance and explicitly observing
  it establishes a first observation. Repair preserves the executor's disabled
  preference until the test explicitly enables it.
- Actual server/worker restart retains attachment/runtime identity, exact
  workspace receipts and complete desktop/package histories. Creation and update
  timestamps and encrypted outcomes in desktop/package history rows are compared
  as raw values within each peer;
  retained package results still decrypt with their original contexts.

Across implementations, all 44 recorded snapshots compare every normalized field.
Only relational UUIDs, valid timestamps, the unique owned container name and
encrypted nonce/ciphertext bytes are normalized. Actual package outcome
authentication, ciphertext retention and within-peer identity checks are separate
assertions. No public operation or history field is omitted from comparison.

## Local matrix and artifacts

Source baseline: `e21a9e2736e6feaf2e6c62b719e8340c4541e062`.
Unchanged Rust executable SHA-256:
`20bb778bd097862de7be6e51ee9d2c90c57dce27700c14e856b53ce36054b985`.

| Configuration                              | Cells | Product steps | Compared snapshots | Server SIGKILLs |
| ------------------------------------------ | ----: | ------------: | -----------------: | --------------: |
| Node/Rust, external PostgreSQL             |     2 |            30 |                 88 |               2 |
| Node/Rust, bundled PostgreSQL              |     2 |            30 |                 88 |               2 |
| Node/Rust, PGlite                          |     2 |            30 |                 88 |               2 |
| All four Node/Rust Redis peer combinations |     4 |            60 |                176 |               4 |
| Total                                      |    10 |           150 |                440 |              10 |

All four final matrix processes exited zero. A post-run comparison verifies all
ten cells against the same baseline, all ten intentional SIGKILLs, 42 clean
production-server exits and 40 clean worker exits. All 104 complete server
stdout/stderr logs and observed HTTP requests exclude the private file marker.
Shared cells place the browser and worker on opposite production peers with real
Redis 8.10.3; the browser's server is the interrupted peer.

The platform is macOS arm64 with account authentication. Node's bundled-PostgreSQL
reference uses a private external fixture database; Rust manages its own private
PostgreSQL process. The owned native PGlite runtime is copied from verified
evidence and independently compared across all 711 entries. The worker and all
four compiled workspace dependencies are freshly built; the current `os-host`
package is also copied and its file hashes match the preceding frozen package.

The guest uses the normal ARM64 image
`sha256:0f167ee073c93b20e56a10742776b6487a9f66190124f98fb169fffd834692a4`,
retained by the preceding CantripOS acceptance work. Its 514,802,401-byte archive
has SHA-256 `3feeb365240d146d97f25d9a424443e277840f2f300e653f0e5e81d3f8854143`.
It contains executor 0.12.0, remote 0.11.0, workspaces 0.4.0 and recovery 0.5.0.
Only Docker archive tag metadata is rewritten to load an isolated QA tag. The
ordinary `cantrip-os:dev` tag and unrelated containers remain unchanged.

The package recipes build current workspace 0.4.0 and recovery 0.5.0 artifacts
without rebuilding native compilers. Their SHA-256 digests are respectively
`e82d169727c0ff8edc725b957c7a5e77ad6100678ce2c8a0b2aabcf3512a440e` and
`dc2e2c7173c5769890861ef23c1a5e9fe89c4379720cbd8b52b3642dec07e5a1`.

Final reports are `{postgres,bundled-postgres,pglite}-matrix-v1.json`,
`shared-matrix-v1.json` and `final-comparison.json` under the retained
`.qa/rust-cantrip-os-product` evidence. Successful guest runs capture all three
owned persistent directories as compressed tar files before removing their own
containers and volumes. Failed runs preserve their stopped guests for diagnosis.

Earlier failures remain recorded: inspecting immediately after Docker start raced
optional service startup; a test environment variable was intentionally filtered
by the isolation fixture; and a new test supplied a stale runtime after package
maintenance correctly revoked it. The corrected tests retry only actual guest
reads, populate the ordinary public package catalog and require the stale 409
before fresh observation. An initial archive import missed OCI index tag
annotations; the corrected import changes tag metadata only. The previous report
of a native desktop 404 did not reproduce on this current executable.

Production builds, formatting, syntax checks, all nine generated-contract
comparisons and boundary/release-only workflow audits pass locally. `pnpm check`
still stops at unchanged Node line budgets: 1,532/1,500 in `build-app.ts` and
2,336/1,999 in `chat-turn-runtime.ts`; downstream checks did not run. No development
GitHub Actions job was dispatched.

Root checkpoint/capture, system replacement/rollback and their physical-identity
recovery require separate current full-worker qualification. Mid-operation
worker/native failure, missing guest receipts, SSH guests, rendered UI and desktop
streaming, supported-platform packaged acceptance, final migrations/rollback,
performance, Rust default selection and production Node-server removal remain
outside this milestone. The full server replacement remains active.
