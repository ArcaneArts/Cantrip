# Current replacement acceptance

The server replacement remains incomplete. Rust is the default server, and the
production Node workspace and entrypoints have been retired. The worker remains
Node. The old server is an explicit development compatibility reference. See
[default cutover](RUST_SERVER_DEFAULT_CUTOVER.md) and
[production Node retirement](RUST_SERVER_NODE_RETIREMENT.md) for their qualification.

## Cantrip 1.1.3059 packaged servers

The relocated macOS ARM64 archive and both Linux OCI images passed migrations,
SQL export, retained writes, hosted reopening and graceful shutdown on all
three stores. The macOS run verified 1,762 manifest entries with Homebrew
reads and artifact writes denied. The Linux verifiers matched 2,558 native
package files and four OCI layers per architecture. Both Linux containers ran
without Node, as a non-root user, with a read-only root and noexec temporary
filesystem. Linux x64 ran through Rosetta on the ARM64 Linux host.

Each local Winterhold rehearsal completed 18 installer operations under
systemd and Caddy HTTPS. Six injected migration and startup failures
restored the working service. PGlite and bundled PostgreSQL retained writes
through rollback to Rust 1.1.3048. External PostgreSQL retained writes and
the session through rollback to the historical Node server and return to Rust.
Both Linux packages also passed all four Rust and Node caller/host pairings
with two full workers, Chromium and shared PostgreSQL. Each pairing recovered
the same replica on attempt two after Redis restarted.

The macOS standalone package passed 20 browser and full-worker steps and
14 model operations, including the eight-minute external PostgreSQL outage.
Liveness stayed at HTTP 200, readiness returned HTTP 503 during the outage
and HTTP 200 after recovery, and the original inference produced one durable
receipt. The separate Windows x64 1.1.3057 executable passed the same 20
steps and 14 model operations in the local guest with a 60-second outage.

The macOS 64 MiB worker-log test measured 218 MiB/s for Rust and 177 MiB/s
for Node in one run per runtime. Both delivered the same payload, closed the
slow consumer with code 1013 and retained identity and writes after restart.
The small-profile test measured a 205 ms Rust PGlite reopen and 94–102 MiB
of idle process-tree RSS. Fresh Rust PGlite starts took 32.7 and 4.7 seconds,
with the difference concentrated in migration time. Fresh startup needs
further comparison before a performance conclusion.

The signed macOS desktop update from 1.1.3043 passed all three database modes
after the updater fixture adopted the production launcher configuration. It
retained the server identity, worker enrollment, client encryption bindings
and a settings write, and drained both desktop child processes. The PGlite
case rejected a modified updater archive before applying the valid package.
[Platform, artifact and performance evidence](security/rust-server-3059-platform-acceptance.json)

### Worktrees and managed Git replicas

On macOS ARM64, the packaged Rust server and Node reference each passed 25
browser and full-worker steps on all three stores. The worker created a real
Git worktree, locked and unlocked it, retained its identity across restarts
and reconciled its inventory. Dirty removal preserved the file and restored
the usable state. Run definition deletion and worktree removal both stopped
the actual worker child. The requests kept paths, branches and lock reasons
opaque to the server.

Both runtimes also passed the 12-step packaged CLI worktree continuation on
all three stores. A live native turn scheduled the switch, the continuation
ran in the new checkout, and both answers retained their original worktree
and lane attribution after reopening the server.

The managed-replica test imported a public repository through the existing
client and full workers. Rust passed on all three stores, including restoring
the missing managed link and repeating repair without changing the checkout.
It also synchronized the expected Git revision and refused to remove a checkout
containing ignored user data. The first external PostgreSQL run timed out
during worker shutdown. A fresh run passed with the same assertions.
The Node reference reached repair on all three stores and returned HTTP 502.
Its repair uses the project-level repository handle, which belongs to the
primary worker. Rust uses the handle recorded by the owning replica worker.

In four additional fresh-profile PGlite runs, Rust reached readiness in 1.22
and 1.28 seconds and Node in 3.09 and 3.32 seconds. The earlier 32.7-second
Rust migration did not recur in this series.
[Worktree, replica and startup evidence](security/rust-server-3059-worktrees-and-replicas.json)

### Terminals, file documents and browser surfaces

The macOS ARM64 package and Node reference each passed 28 browser and
full-worker steps on each of the three databases. The native CLI opened
encrypted snapshots of a real PTY after start, service restart and worker
reconnect. The browser sent and received authenticated terminal traffic
through WorkerLink relay and the legacy socket. File-document operations
edited real bytes, rejected stale saves and replay, and retained the same
document across server and worker restart.

Real Chromium frames and encrypted controls passed through both browser
transports. The test rejected altered authenticated metadata, resumed the
legacy surface, retained its encrypted state, and revoked an active WorkerLink
grant on deletion. The full worker also returned a healthy desktop inventory.
Physical desktop capture and native desktop window ownership retain separate
acceptance.
[Terminal, file and browser surface evidence](security/rust-server-3059-surfaces-and-files.json)

### Native workspace and dirty editor recovery

On macOS ARM64, actual Tauri and WKWebView windows passed 24 workspace
checkpoints against the packaged 1.1.3059 Rust server. Both unsaved drafts
and the original tab ownership survived Rust restart, detached WebView
reload and forced native app exit on all three stores. Closing the detached
window returned its draft to the main window, and the explicit encrypted
save wrote only the selected worker file. The debug app, Rust server and
full Node worker exited cleanly.
[Native workspace evidence](security/rust-server-3059-macos-native-workspace.json)

### Workspace state, project shares and tunnels

The macOS ARM64 package and Node reference each passed 21 browser and
full-worker steps per database. Both retained detached file ownership and
the unsaved draft across server restart. A new renderer attachment fenced
the old generation. Protected WebDAV used real worker files and enforced
Digest authentication over WorkerLink and legacy transport. After Rust
restarted with the worker still running, the old share closed and a fresh
share opened the retained bytes.

The two tunnel transports carried authenticated ciphertext to a real TCP
target, preserved half-close and returned the expected encrypted reply.
WorkerLink released its grant and revocation closed the legacy attachment.
The test used the packaged 1.1.2976 Node worker and disposable catalog
fixtures.
[Workspace, share and tunnel evidence](security/rust-server-3059-shares-and-tunnels.json)

### Historical profile upgrade and post-write rollback

The packaged macOS ARM64 1.1.3059 server upgraded a populated copy of a
real Node 1.1.2733 PGlite profile to each of the three storage modes.
Each first import applied two migrations. The round trip compared
137 tables and four sequences, retained the original session and server
identity, and reopened the encrypted content with the original client keys.
Rust accepted four encrypted product writes per store, the old Node server
reopened them and accepted four further writes, and the returned Rust server
retained those writes and accepted four more. The 1,773 original files
matched throughout. The sandbox rejected an actual attempt to open the
original secret-key file for writing.
[Historical upgrade and rollback evidence](security/rust-server-3059-historical-profile.json)

### Authentication and App Live on the packaged macOS server

The Rust 1.1.3059 package and same-version Node reference matched 1,083 HTTP
cases across eight profiles per store. The cases cover cookie and CSRF
handling, CORS, trusted-proxy behavior, retained sessions, mobile grant
exchange and replay, and creator revocation. The first attempt found stale
1.1.3051 version metadata in the Node reference. Regenerating its metadata at
1.1.3059 allowed the existing exact version assertion to pass.
[Authentication comparison evidence](security/rust-server-3059-auth-compatibility.json)

The Rust 1.1.3059 executable and Node reference matched 100 App Live
socket cases, 24 HTTP observations and six unauthenticated upgrade
rejections across PGlite, bundled PostgreSQL and external PostgreSQL.
The cases cover real project and Chat authorization, replay of a
committed worker invalidation, session revocation and socket capacity
reuse. With external PostgreSQL holding an actual authorization query,
the open socket still acknowledged ping and close.
[App Live comparison evidence](security/rust-server-3059-live-compatibility.json)

## macOS recovery tests through Cantrip 1.1.3059

The macOS ARM64 development executable in PR #3071 completed 14 model
operations and 20 browser and worker steps with external PostgreSQL 18.
The browser received its embedding during the eight-minute outage.
After PostgreSQL reopened on the same port, Rust settled the original
receipt once, rejected replay and completed a fresh decision. All 88
Rust library tests passed using the packaged Node toolchain for the
compatibility oracles.

With the final PR #3072 source, Chromium, Rust, the Node server reference
and two complete workers passed 14 product steps. During Redis loss,
both peers returned HTTP 503 and PostgreSQL continued to renew the
original job lease. A new worker claim on the same Node server let
Rust recover the same job on attempt two at revision 11. Peer
replacement replayed that revision and detach preserved the checkout.

The current Rust executable also completed all 584 route discovery
requests per peer with zero generic Rust fallback differences.
Model-operation validation and owner checks matched in 366 paired HTTP
observations across the three stores and all three authentication modes.
[macOS recovery and HTTP evidence](security/rust-server-3059-macos-recovery-evidence.json)

## Cantrip 1.1.3048 Linux standalone and Winterhold

The ARM64 and x64 images built from `358c5b323` passed startup, migration,
SQL export, retained writes, hosted reopening and graceful shutdown with
PGlite, bundled PostgreSQL and external PostgreSQL. Both ran without Node
in non-root containers with read-only roots and noexec temporary filesystems.
The OCI exports and native archives matched the running executables, and
all 2,558 package files matched on each architecture. The x64 executable
ran through Rosetta on the ARM64 Linux host.

Each local Winterhold rehearsal used systemd, Caddy HTTPS and App Live
across 18 installer operations. Both recovered from six injected migration
and startup failures, including a systemd start-limit failure. PGlite and
bundled PostgreSQL retained writes through rollback to Rust 1.1.3032 on
ARM64 and 1.1.3033 on x64. External PostgreSQL retained writes and the
session through rollback to the historical Node server over TLS and
reopening on Rust.

With an isolated external PostgreSQL process paused, readiness returned
HTTP 503 in 3.004 seconds on ARM64 and 3.008 seconds on x64. Liveness
remained HTTP 200, and readiness returned HTTP 200 after PostgreSQL resumed.

The same x64 executable also passed 20 browser product steps and 14 model
operations with the full Node worker. During a 60-second PostgreSQL outage,
the browser received the active embedding while readiness returned HTTP 503
and liveness stayed at HTTP 200. PostgreSQL reopened on the same port, the
server recorded the original receipt, and replay made no second provider
request. A fresh decision completed. All three server generations exited
cleanly.
[Linux 1.1.3048 artifacts and acceptance report](security/rust-server-3048-linux-acceptance.json)

## Cantrip 1.1.3043 macOS standalone and signed desktop update

The relocated macOS ARM64 archive built from `54355efde` passed startup,
migration, SQL export, retained settings writes, hosted reopening and graceful
shutdown with PGlite, bundled PostgreSQL and external PostgreSQL. The harness
verified 1,762 manifest entries and ran the server with Node off its PATH and
Homebrew reads and artifact writes denied.

The local Developer ID-signed desktop rehearsal updated from 1.1.3032 on all
three stores. It retained the database mode, server identity, worker
enrollment, client encryption bindings and a settings write. The desktop
drained both child processes before replacing the app and after final quit.
PGlite also rejected a modified archive before installing the valid update.
The retained candidate archive passed strict code-signature verification
after extraction.

Two browser runs used the exact standalone executable and the full Node
worker with external PostgreSQL. Each passed 20 product steps and 14 model
operations. After a forced server exit, the same worker reconnected and
completed a fresh operation. During a separate 60-second database outage,
the active embedding completed while readiness returned HTTP 503 and
liveness returned HTTP 200. The server recorded one durable receipt after
PostgreSQL recovered on the same port. Replay made no second provider
request, and a fresh operation completed.

The separate Windows x64 1.1.2976 outage run completed its active embedding
and observed HTTP 503 from readiness and HTTP 200 from liveness. Its later
readiness request timed out while PostgreSQL was still offline, so the run
ended before it could verify durable settlement.

The local repository check with Node 24.22.1 completed typechecking and
tests, including 4,597 app, 2,958 worker and 87 Rust server tests. The check
exited at formatting, where Prettier reported 17 formatting warnings and
could not read a local CantripOS VM disk larger than 2 GiB.
[macOS 1.1.3043 acceptance and Windows outage evidence](security/rust-server-3043-macos-acceptance.json)

## Cantrip 1.1.3032 macOS and Linux ARM64 standalone

The macOS ARM64 archive and Linux ARM64 container built from `d91420eb9`
passed startup, migration, SQL export, retained writes, hosted reopening
and graceful shutdown on all three stores. The macOS archive ran with
Node off its PATH and sandbox rules denying Homebrew reads and package
writes. The Linux server ran as a non-root user with a read-only root and
a noexec temporary filesystem. The OCI export and the native archive
match the running Linux executable.

The local Linux ARM64 Winterhold rehearsal exercised systemd, Caddy HTTPS
and App Live across 18 installer operations, including six injected
migration and startup failures. PGlite and bundled PostgreSQL preserved
writes through rollback to Rust 1.1.3014. External PostgreSQL preserved
writes and its session through rollback to the historical Node server
over TLS and reopening on Rust.

On macOS, two packaged Rust peers and the full Node worker completed 20
product steps and 14 model operations against shared PostgreSQL. A
45-second Redis interruption left one unknown attempt for the interrupted
embedding. Replaying it kept the same receipt, and a fresh operation
completed after recovery.

The same Linux ARM64 image completed 20 product steps and 14 model operations
using the existing browser and full Node worker. The browser received the
active embedding during a 60-second external PostgreSQL outage. The server
stayed live and reported unready, then persisted one receipt for the original
attempt after the database restarted. A fresh operation completed and all
three Rust container generations exited cleanly.

The local Developer ID-signed macOS desktop rehearsal updated from 1.1.2976
to 1.1.3032 on all three stores. Each update retained the database mode,
server identity, worker enrollment, client encryption bindings and a settings
write. The desktop drained both child processes before replacing the app and
after the final quit. The PGlite case also rejected an archive with a modified
byte before installing the valid update. The rehearsal populated fresh test
profiles on the older runtime.

The same macOS ARM64 standalone executable passed 20 product steps and 14
model-operation cases on each database mode. A real server kill interrupted
an active embedding and retained its original usage row without reported
tokens. The same worker reconnected, the browser kept its server identity,
and a new operation completed. The provider received one request for each
interrupted operation. A separate external PostgreSQL run completed an active
embedding during a 60-second outage, then recorded one receipt after the
database recovered and completed a fresh request.
[ARM64 standalone, desktop and Winterhold report](security/rust-server-3032-standalone-acceptance.json)

## Cantrip 1.1.3014 Linux standalone

The ARM64 and x64 images built from `0c1c343bd` passed standalone startup,
migration, SQL export, retained writes, hosted reopening and graceful
shutdown on all three stores. The server ran without Node in a non-root
container with a read-only root and a noexec temporary filesystem. The
local Winterhold rehearsals exercised systemd and Caddy HTTPS with App
Live, migration and startup fault recovery, and post-write rollback.
PGlite and bundled PostgreSQL reopened on Rust 1.1.2976. External PostgreSQL
reopened on the historical Node server with TLS required. The x64 server
ran through Rosetta on the ARM64 Linux host.
[Linux ARM64 report](security/rust-server-3014-linux-arm64-acceptance.json),
[Linux x64 report](security/rust-server-3014-linux-x64-acceptance.json)

The ARM64 image also passed active Redis interruption across all four
Node/Rust peer pairings with external PostgreSQL. The run verified 12 Rust
container launches and clean exits, 56 model operations, and recovery
without replaying the interrupted inference at the provider.

## Cantrip 1.1.3033 Windows x64 standalone

The local Windows 11 x64 guest packaged the cross-built Rust executable and
ran from a fresh extraction. PGlite, bundled PostgreSQL and external
PostgreSQL passed startup, migrations, SQL export, retained writes, hosted
reopening and shutdown through the supervisor's stdin pipe. The fixture
also verified dotenv and CLI precedence, portable bundled PostgreSQL
selection, and the embedded PGlite runtime fallback.

Node was absent from the server's runtime PATH. All 2,281 packaged files
matched the manifest both in the guest and in the independently verified
host copy of the archive. The signed desktop and active database-outage
runs have separate acceptance records.
[Windows standalone archive and acceptance report](security/rust-server-3033-win32-x64-standalone.json)

The signed Windows 1.1.2976 desktop's Rust executable passed the active
model-operation server-loss run with external PostgreSQL. The Windows guest
completed 20 product steps and 14 model operations. After a forced server
exit, the same worker reconnected, the interrupted usage row remained
without reported tokens, and a fresh decision completed.
[Windows server-loss evidence](security/rust-server-2976-win32-x64-model-server-loss.json)

## Cantrip 1.1.3033 Linux x64 standalone and Redis recovery

The rebuilt x64 server includes the Redis relay subscriber recovery fix in
#3033. It passed standalone acceptance and the local Winterhold systemd and
Caddy rehearsal on all three stores. The rehearsal completed 18 installer
calls, including six recovered failures. PGlite and bundled PostgreSQL
retained accepted writes through rollback to Rust 1.1.2976. External
PostgreSQL retained them through rollback to the historical Node server
with TLS required.

All four Node/Rust peer pairings completed 80 product steps and 56 model
operations against shared PostgreSQL and Redis. After Redis was killed
for at least 45 seconds, each pair retained the original unknown attempt
without issuing another provider request on replay. Each pair recovered
the same worker claim and completed a fresh operation. The x64 server
ran through Rosetta on the ARM64 Linux host.

The same x64 package kept its server and worker connections through a
60-second external PostgreSQL interruption. The provider and browser
finished the active embedding while PostgreSQL was offline. The server
reported unready and stayed live, then committed the original receipt
after recovery. Replaying the original operation made no second provider
request, and a fresh operation completed.
[Linux x64 package and recovery report](security/rust-server-3033-linux-x64-acceptance.json)

## Cantrip 1.1.3013 macOS standalone

The macOS ARM64 standalone distribution built from `9069ae6ac` passed
startup, migrations, SQL export, retained writes, hosted reopening and graceful
shutdown on PGlite, bundled PostgreSQL and external PostgreSQL. The test
repeated those checks from a fresh archive extraction with Node off the server
PATH and Homebrew and artifact writes denied. All 1,762 manifest entries
matched. The running server reported `1.1.3013` and the same process instance
ID in health and live traffic. This record covers the standalone archive.
[macOS standalone report](security/rust-server-3013-darwin-arm64-standalone.json)

The same macOS archive and compiled Node reference each completed two warmups
and four measured runs on small local PGlite profiles. Median warm readiness
was 88 ms for Rust and 1,408 ms for Node. Median idle process-tree RSS was
102 MiB for Rust and 1,322 MiB for Node. Median settings read latency was
1.31 ms for Rust and 4.55 ms for Node. Both retained identity and writes across
restarts and delivered all enrollment events to a resumed App Live consumer.
The Windows QA VM ran on the same host during these measurements.
[macOS runtime measurements](security/rust-server-3013-darwin-arm64-standalone.json#runtimePerformance)

The App Live harness compared that packaged executable with the Node reference
server over HTTP and WebSocket connections. All four profiles passed on each
store, with 100 paired socket cases, 24 paired HTTP cases and six rejected
unauthenticated handshakes. The cases cover heartbeat, capacity, committed
worker invalidations, replay and transport close behavior. The external
PostgreSQL run also held an authorization query open while checking WebSocket
ping and close handling. The harness accepts prebuilt server and repository
fixture paths for archive qualification. Chromium also passed 14 paired
browser and worker-control steps per store, including enrollment, credential
rotation and reconnect. The rotation command used a controlled handler.
A separate browser run used the full packaged Node worker with controlled
local providers. Each store passed 16 paired product steps and matched 26
catalog snapshots, including the 1,050-model paginated catalog, scoped
availability and retained state after restart.
[macOS App Live and browser worker report](security/rust-server-3013-darwin-arm64-app-live.json)

The same standalone executable passed active Redis interruption with external
PostgreSQL and the packaged Node worker. Each of the four Node/Rust peer
pairings completed 14 model operations, including a 45-second Redis outage
during a protected embedding. The interrupted request returned HTTP 502
with one unknown usage attempt. Replay made no further provider request,
and a fresh decision completed after readiness recovered.
[macOS Redis interruption report](security/rust-server-3013-darwin-arm64-redis-outage.json)

The packaged server also passed 14 model operations with external PostgreSQL.
During a 60-second database outage, the browser completed the active
embedding and the server stayed live while readiness returned HTTP 503.
PostgreSQL reopened on the same port and the server settled the original usage
record after readiness returned. The fixture uses PostgreSQL's `pg_ctl kill`
to deliver the same shutdown signal on Unix and Windows.
[macOS PostgreSQL interruption report](security/rust-server-3013-darwin-arm64-postgres-outage.json)

## Current wire and account protection evidence

The macOS ARM64 1.1.3013 archive and Linux x64 1.1.3033 container each
passed 156 paired HTTP cases and 81 paired App Live parser cases across
the three stores. The requests cover malformed JSON, deep arrays and
objects, lone UTF-16 surrogates, numeric overflow and cursor accounting
against actual publications. The Linux x64 server ran through Rosetta.

The Linux ARM64 and x64 1.1.3048 standalone images each passed the same 156
HTTP and 81 WebSocket comparisons across the three stores. All 12 Rust
container generations ran the verified executables and exited cleanly.

The macOS ARM64 1.1.3043 archive matched 366 HTTP responses from the Node
reference across the three stores and anonymous, password and account
authentication. The cases exercised embedding and decision admission and
cancellation, including invalid payloads, CSRF, absent or foreign workers,
and owned workers that were offline.
[Linux wire and macOS model-operation boundary evidence](security/rust-server-3048-wire-and-model-boundaries.json)

On macOS, the production entrypoints handled all 584 method/path
discovery requests per runtime without a generic Rust route fallback.
Four selected inventory errors and four capability query cases matched
the reference. A separate account suite passed 1,161 paired HTTP cases.
The endpoint client reopened its retained encrypted key wrapper after
a password change and process restart. It rejected wrong-owner metadata
and modified ciphertext. External PostgreSQL also retained the wrapper
through Node → Rust → Node.
[Wire and account protection report](security/rust-server-current-wire-acceptance.json)

## Cantrip 1.1.2976 qualification

The recorded packages use Rust server source `92ed534fa` and desktop shell
source `f1201f3e2`. Through integrated commit `b114567f6`, the only later
runtime source change in the server, deployment, renderer and worker inputs
was the canonical-history worker fix in #3006. Package and product results
below apply to the exact binaries and worker entries identified by their reports.

- **macOS ARM64.** Standalone startup, migration, export and reopening passed
  on PGlite, bundled PostgreSQL and external PostgreSQL with Node off the
  server PATH. Signed desktop updates passed on all three stores. The populated
  Node `1.1.2733` upgrade and post-write rollback preserved the original
  profile and existing encrypted state, identity and session. The comparison
  covered 137 tables and four sequences. The three CLI worktree continuation
  cases passed again after #3006. Each completed 12 steps, two model requests
  and one canonical answer per checkout, with the same transcript after
  reopening. [macOS package report](security/rust-server-2976-darwin-arm64-acceptance.json)
- **Linux ARM64 and x64.** The standalone containers passed all three stores
  as a non-root user with a read-only root. Each local Winterhold rehearsal
  exercised 18 installer calls, Caddy HTTPS, App Live and post-write rollback.
  The hosted PostgreSQL case rolled back to the Node reference over required
  TLS. The x64 result used emulation on an ARM64 Linux host. The CLI worktree
  reports cover all six platform and storage combinations before #3006.
  [Linux ARM64](security/rust-server-2976-linux-arm64-acceptance.json),
  [Linux x64](security/rust-server-2976-linux-x64-acceptance.json),
  [CLI worktree matrix](security/rust-server-2976-linux-cli-worktree-acceptance.json)
- **Windows x64.** The earlier package passed all three standalone cases and
  the local signed PGlite update from `1.1.2938`. The repack with #3006 passed
  first launch, persisted-profile reopen and real tray shutdown on all three
  stores in the Windows x64 VM. All six cases verified the installed hashes,
  worker replies and child exit. The bundled database shut down with Cantrip,
  and the external cluster stayed up through both application exits.
  The same repack passed the signed PGlite upgrade from `1.1.2938`.
  The updater rejected a modified download, installed the signed installer
  and relaunched with the same server identity, worker enrollment and
  pre-update theme. Tray quit exited zero and reaped both services.
  The earlier Windows CLI PGlite fixture timed out waiting for canonical
  history. Its database retained both completed turns, and the final worker
  acknowledgment arrived after the last browser poll. The revised fixture
  from #3009 passed on macOS PGlite. The Windows CLI rerun exposed a separate
  worker grant refresh race. The signed package with #3012 passed the
  PGlite update from `1.1.2938`, retained the saved theme and worker
  enrollment, and exited cleanly. The signed package also passed all 36
  model-operation cases across the three stores in the Windows guest.
  The same installed server passed the full-worker CLI continuation on all
  three stores. Each case completed 12 product steps, two provider requests,
  one canonical answer per checkout and four clean server exits. The bundled
  PostgreSQL retry widened the guest observation windows for worker teardown
  and server shutdown and kept the product assertions. It observed all four
  worker trees exit and all four private PostgreSQL shutdowns complete.
  The earlier bundled PostgreSQL timeout is retained in the report.
  [Windows CLI and streaming report](security/rust-server-2976-win32-x64-cli-and-streaming.json)
  [Windows package report](security/rust-server-2976-win32-x64-packages.json)
  [Windows model operations](security/rust-server-2976-win32-x64-model-operations.json)
- **Model operations and WorkerLink.** The macOS and Linux reports cover native
  model operations on all three stores. Linux recorded 72 operations, 114
  product steps and 18 clean server exits. The macOS server-loss matrix covered
  all three store pairs and six forced server deaths. The packaged Linux ARM64
  and x64 server-loss matrix also covered all three stores, including worker
  reconnection without replay of the interrupted operation. The macOS
  WorkerLink report includes shared routing, forced loss and repeated PGlite
  recovery.
  On macOS, Rust and the Node reference each kept an in-flight inference
  through a 45-second external PostgreSQL outage and recorded one usage
  receipt after recovery. On Windows x64, the installed 1.1.2976 server with
  bundled PostgreSQL passed 20 browser product steps and 14 model operations,
  including one forced server exit and three clean exits. The external
  PostgreSQL server-loss and database-outage runs are still open. Linux x64
  passed packaged Redis interruption with the rebuilt 1.1.3033 server.
  [Windows bundled PostgreSQL server-loss result](security/rust-server-windows-stream-comparison.json#installedBundledPostgresModelServerLoss)
  [macOS model operations](security/rust-server-2976-darwin-arm64-model-operations.json),
  [macOS server loss](security/rust-server-2976-darwin-arm64-model-operation-server-loss.json),
  [Linux model operations](security/rust-server-2976-linux-model-operations.json),
  [Linux server loss](security/rust-server-linux-model-operation-server-loss.json),
  [macOS WorkerLink](security/rust-server-2976-darwin-arm64-workerlink.json)
- **Linux WorkerLink binary streaming.** Packaged Linux ARM64 and x64 Rust
  and the historical Linux x64 Node container passed nine cases across the
  three store configurations. Each transferred 64 MiB in both the download
  and tunnel echo cases with exact frame bytes. The driver verified selective
  grant revocation, slow-consumer closure, recovery after a server crash,
  bandwidth quota enforcement and gateway cleanup. The historical Node
  bundled PostgreSQL comparison used an external PostgreSQL process.
  [Linux WorkerLink](security/rust-server-2976-linux-workerlink.json)
- **Browser and mobile.** Browser sign-in and installed Android and iOS
  simulator sessions passed against all three stores. Android also exercised
  the native QR entry point and Keystore. Installed iOS native QR, physical
  camera and distribution-signed mobile evidence remain open.
  [Browser sign-in](security/rust-server-2976-browser-mobile-sign-in.json),
  [Installed mobile](security/rust-server-2976-installed-mobile.json)
- **Populated-profile performance.** The paired macOS suite retained 100
  measured invocations. With external PostgreSQL, project-list median rose
  from 6.125 ms to 7.802 ms and full-history median from 28.148 ms to 35.092 ms.
  The report documents the local tradeoff alongside improvements in paged
  reads, writes, mixed-read throughput and startup.
  [Performance report](security/rust-server-2976-darwin-arm64-populated-performance.json)
- **Worker log streaming.** Packaged macOS ARM64 and Linux ARM64 and x64
  servers passed slow-consumer handling and worker reconnection after a
  forced server exit on all three stores. The Linux x64 bundled PostgreSQL
  measurement varied with payload size. Rust measured 58.88 MiB/s against
  63.26 MiB/s for the historical Node image at 64 MiB, and 45.14 MiB/s
  against 40.96 MiB/s at 256 MiB. The Node comparison used external
  PostgreSQL. Each figure is a single observation on a shared host.
  The Windows Rust package passed the 64 MiB stream, slow-consumer closure
  and retained-write restart on all three stores. A subsequent same-host
  comparison repaired the Node reference's Argon2 load and passed all three
  Node runs. The Rust 1.1.3033 follow-up passed all three stores, including
  the external PostgreSQL repeat with the configured fixture startup budget.
  [Windows comparison](security/rust-server-windows-stream-comparison.json)
  [Windows CLI and streaming report](security/rust-server-2976-win32-x64-cli-and-streaming.json),
  [macOS report](security/rust-server-2976-darwin-arm64-worker-log-stream.json),
  [Linux report](security/rust-server-2976-linux-worker-log-stream.json)

## Historical qualification

Historical ledger entries describe their original milestones. The local macOS
ARM64 `1.1.2881` server passed all three stores as a standalone distribution,
in signed desktop updates from `1.1.2869`, and through the original Node
`1.1.2733` upgrade and post-write rollback. The signed installed apps kept
their encrypted client bindings and accepted state. The rollback passed the
137-table and four-sequence comparisons and preserved the original profile.
The macOS ARM64 package rebuilt at `ff6a4b060` matched all 1,762 manifest
files. Its standalone test passed migration, export, restart and hosted
reopening on all three stores. It also passed queued Task transfer on
all three stores and the read during settlement and active-dispatch
rejection on external PostgreSQL.
[macOS package acceptance](security/rust-server-2881-macos-acceptance.json)

The macOS ARM64 rebuild at `01928fcff` repeated the three-store standalone
and queued Task transfer tests with the packaged worker. Its archive
matched all 1,762 manifest files. The packaged Rust server also matched
the Node reference when Redis denied terminal-link revocation during
workspace removal.
[macOS rebuild qualification](security/rust-server-2881-macos-acceptance.json#workspaceRemovalRebuild)

The macOS ARM64 rebuild at `cb41197c6` passed relocated standalone startup,
migration, export, and reopening on all three stores. The existing browser
and full worker repaired a managed replica link and verified idempotent
replay on each store. The signed desktop update reused the verified desktop
shell and packaged worker, replaced the server and its manifest, and
preserved the encrypted session, accepted settings and service identities
in all three cases. The updater rejected a tampered PGlite download.
[macOS replica repair rebuild](security/rust-server-2881-macos-acceptance.json#replicaRepairRebuild)

The same packaged Rust server and the Node reference matched on Chat and
direct Task Stop after a worker restart across all three stores. The mounted
Chat UI also stopped a turn whose active command blocked durable Pause. The
browser SDK stopped a running Task and cancelled a Task restoration waiting
for provider capacity. The tests used the packaged worker and native runtime.
[Packaged interruption qualification](RUST_SERVER_NATIVE_CONTROL_CONTRACTS.md#packaged-stop-during-live-execution-and-restoration)

The Linux x64 `1.1.2881` container and local Winterhold rehearsal passed all
three stores on an ARM64 Linux host with x64 emulation. The installer
recovered from six injected failures, and accepted writes survived
rollback to the previous Rust or Node release and return to Rust.
The x64 package rebuilt at `ff6a4b060` repeated all 18 installer
operations across the three stores, including six injected migration and
startup failures. Caddy HTTPS, App Live, external PostgreSQL TLS, and
systemd shutdown passed. The rehearsal used tmpfs for release files and
the container filesystem for database profiles. The updated installer
repeated this matrix and recovered after a forced systemd start-limit hit.
[Linux x64 package acceptance](security/rust-server-2881-linux-x64-acceptance.json)

The native Linux ARM64 `1.1.2881` container and local Winterhold rehearsal
passed all three stores. The production installer recovered from six
injected failures and preserved accepted writes through rollback and return
to Rust. The run verified Caddy HTTPS, App Live, and external PostgreSQL TLS.
The ARM64 package rebuilt at `ff6a4b060` repeated the container and systemd
matrices across all three stores. The first installer run hit the systemd
start limit during a rapid release transition. The installer now clears the
start limit before each explicit activation and rollback. The local
rehearsal forced the candidate to exhaust its start budget and verified
that the previous release restarted with its accepted writes.
[Linux ARM64 acceptance record](security/rust-server-2881-linux-arm64-acceptance.json)

The Linux ARM64 and x64 packages rebuilt at `01928fcff` each matched 2,546
native manifest files and passed all three database modes in the container.
The representative Winterhold rehearsal repeated 18 installer operations
per architecture. It kept the accepted writes across rollback, verified
Caddy HTTPS and App Live, and recovered from a forced systemd start-limit hit.
The x64 executable ran through emulation on the ARM64 Linux host.
[Linux ARM64 rebuild](security/rust-server-2881-linux-arm64-acceptance.json#workspaceRemovalRebuild), [Linux x64 rebuild](security/rust-server-2881-linux-x64-acceptance.json#workspaceRemovalRebuild)

The Linux ARM64 rebuild at `cb41197c6` matched all 2,546 native manifest
files and the loaded OCI image. The current image passed all three stores
with a read-only root, a non-executable temporary mount and a non-root
service account. The suite verified SQL export and retained state on
restart and through hosted reopening. The first run exposed an empty
Docker port mapping immediately after restart. The harness now refreshes
the mapping on each readiness attempt. The same native archive passed the
local Winterhold rehearsal on ARM64 systemd and Caddy across all three
stores. The 18 installer calls included six expected migration and startup
failures and a forced start-limit recovery. Sessions and accepted writes
survived rollback to the previous Rust release for the local stores and the
Node release over required TLS for external PostgreSQL. Each mode returned
to the rebuilt Rust executable and verified App Live over HTTPS.
[Linux ARM64 replica repair rebuild](security/rust-server-2881-linux-arm64-acceptance.json#replicaRepairRebuild)

The Linux x64 build at `9e2dd5711` matched all 2,546 native manifest files
and passed the three-store container and local Winterhold rehearsals.
The container ran as a non-root user with a read-only root and verified
SQL exports and retained settings on restart and hosted reopening.
The systemd rehearsal exercised 18 installer operations, recovered from
six injected failures and preserved accepted writes through rollback and
return to Rust. Caddy HTTPS, App Live, and required external PostgreSQL TLS
passed. The x64 binary ran under emulation on an ARM64 Linux host.
[Linux x64 replica repair rebuild](security/rust-server-2881-linux-x64-acceptance.json#replicaRepairRebuild)

The original-profile rehearsal passes upgrades and restarts with retained
client keys on all three stores.
[Encrypted macOS profile qualification](RUST_SERVER_DESKTOP_ENCRYPTED_ACCEPTANCE.md)
The earlier signed update from `1.1.2831` to `1.1.2845` retained the
authenticated client, server, worker and written setting, and verified the
installed bundles against the signed archive.
[Signed macOS desktop qualification](RUST_SERVER_DESKTOP_SIGNED_UPDATE.md#current-installed-app-and-signed-update)
The rebuilt macOS ARM64 desktop shell and server passed a signed update
from `1.1.2869` to `1.1.2881` on all three stores. Each installation matched
the rebuilt signed archive and preserved its encrypted client bindings,
accepted setting, server identity, and worker identity.
[Rebuilt macOS signed update](RUST_SERVER_DESKTOP_SIGNED_UPDATE.md#rebuilt-server-and-desktop-shell-on-macos-arm64)
The Windows x64 `1.1.2938` standalone package from `5015c89a4`
matched 2,281 files and passed migration, SQL export, retained writes,
hosted reopening and orderly shutdown on all three stores. The record
includes the initial 60-second PGlite timeout and the subsequent timings
under software emulation.
[Windows x64 1.1.2938 standalone record](security/rust-server-2938-win32-x64-standalone.json)

The Windows x64 `1.1.2938` NSIS installer passed a signed update from
`1.1.2881` over local HTTPS. The updater rejected the tampered download
before replacing the app. The relaunch reopened the retained PGlite profile,
kept a setting written just before the update, and received a reply from the
packaged worker. All 14,092 installed files matched the signed payload. The
native tray quit returned exit zero and reaped the Rust server and Node worker.
The fixture used a disposable updater key and local TLS root.
[Windows x64 1.1.2938 signed desktop update record](security/rust-server-2938-win32-x64-desktop-update.json)

The same Windows installation passed a fresh launch and a reopen on each
of PGlite, bundled PostgreSQL and external PostgreSQL. Each reopen used the
saved database configuration and kept the server identity and setting.
All six cases received a real worker reply and exited through the native
tray. The managed PostgreSQL process and PID file were removed on both
bundled PostgreSQL exits.
[Windows x64 1.1.2938 installed matrix](security/rust-server-2938-win32-x64-installed-desktop.json)

The macOS ARM64 `1.1.2938` standalone package from the same source matched
all 1,762 archive manifest entries. The relocated executable passed
migrations, SQL export, settings persistence, hosted reopening and clean
SIGTERM on all three database modes with Node absent from the server PATH.
[macOS ARM64 1.1.2938 standalone record](security/rust-server-2938-darwin-arm64-standalone.json)

The same macOS artifact passed upgrade, post-write return to Node
`1.1.2733`, and return to Rust across all three stores. The populated
profile retained encrypted Chat, draft, file document and Task writes
through the round trip. The original profile stayed byte-identical.

The small PGlite comparison used six runs per implementation. Median
readiness was 1,315 ms for Node and 68 ms for Rust. Median process-tree RSS
was 1,361,064 KiB and 101,560 KiB, respectively. On each of the three stores,
the 16 MiB worker-log stream matched payload hashes, rejected a stalled
consumer with the expected close code, and recovered the accepted write
and identity after restart. Each stream result is a single sample.
[macOS ARM64 1.1.2938 rollback and performance record](security/rust-server-2938-darwin-arm64-rollback-performance.json)

The local Developer ID signed desktop updated from `1.1.2935` to
`1.1.2938` on all three stores with the `1.1.2938` renderer. The
updated WebView retained its device keys, account bindings and saved
setting. The real worker replied after relaunch and the app reaped both
services on shutdown. Each installed bundle matched all 13,571 entries
in the signed archive. The PGlite case rejected a tampered download.

WorkerLink acceptance paired the Node reference and current Rust
package on all three stores. Both passed exact opaque frame transfer,
credit return, revocation, backpressure, quota enforcement and relay
recovery after server crash. The acceptance fixture restarts the worker
transport and gateway, with the full worker evaluated separately.
[macOS ARM64 1.1.2938 signed desktop and WorkerLink record](security/rust-server-2938-darwin-arm64-signed-workerlink.json)

The macOS ARM64 `1.1.2938` standalone server also passed the WorkerLink
lease recovery scenario with the full packaged worker and native broker.
All six Node and Rust cells passed 18 peer renewals and 18 direct renewals,
including recovery after actual server and worker process loss. During
worker reconnect grace, renewals returned HTTP 503 while the mailbox
remained readable. Restart invalidated the old authority, and explicit
release closed the broker with code 1008.

The same Rust package passed the CantripOS root-system scenario on PGlite
with 41 snapshots, five authenticated private outcomes, and the expected
21 Docker root effects. The run preserved checkpoint and mounted data
through replay, root replacement, rollback, and process loss. Docker's
original unpacked image contained an empty entrypoint after a local
storage failure. The retry used a separate local QA image with matching
runtime configuration and filesystem layers. Its first layer adds zero
padding after the tar end to force a fresh Docker snapshot.
[macOS ARM64 1.1.2938 full-worker recovery record](security/rust-server-2938-darwin-arm64-worker-recovery.json)

The Windows x64 `1.1.2881` standalone distribution passed all three stores,
including migration, SQL export, hosted reopening and retained writes.
[Windows x64 standalone record](security/rust-server-2881-win32-x64-standalone.json)

The Windows x64 rebuild at `9e2dd5711` passed standalone migration, SQL
export, retained-state reopening, and graceful supervisor shutdown on all
three stores in a local Windows 11 guest. The native packager produced
2,281 files. Host verification matched all of them to the standalone
archive and the server files embedded in the QA-signed desktop installer.
The installer payload matched all 14,092 file hashes.
[Windows x64 replica repair standalone](security/rust-server-2881-win32-x64-standalone.json#replicaRepairRebuild),
[Windows x64 replica repair installer](security/rust-server-2881-win32-x64-desktop.json#replicaRepairRebuild)

The same installer passed the signed PGlite update from `1.1.2869` and
all six installed desktop cases. The updater rejected tampering and retained
the written setting and service identities. Fresh and reopened profiles on
all three stores received real worker replies and shut down through the tray.
The host matched the guest disk receipts to serial and independently
verified all 14,092 installed files.
[Current Windows desktop qualification](RUST_SERVER_WINDOWS_CURRENT_ACCEPTANCE.md#windows-x64-desktop-rebuild-at-9e2dd5711)

The rebuilt Windows x64 `1.1.2881` desktop installer matched 14,092
installed files. All three stores passed first start and persisted-profile
reopening, real worker replies, accepted writes and clean tray shutdown.
[Windows x64 installed desktop record](security/rust-server-2881-win32-x64-desktop.json)
The same QA-signed installer updated the registered Windows x64 desktop from
`1.1.2869` to `1.1.2881`. The updater rejected a modified download, relaunched
the app, retained the PGlite identity and written theme, and received a real
`1.1.2881` worker version reply. All 14,092 installed files matched again
after the update. Tray quit drained the Rust server and reaped the desktop
services.
The earlier signed desktop update to `1.1.2869` verified 14,089 installed
files and passed tray shutdown and reopening with the retained PGlite
profile. The installed app passed first start, persisted-profile reopening,
worker replies, and tray shutdown across all three stores.
The rebuilt Windows server from `ff6a4b060` matched its 2,281-file
standalone manifest. Its first standalone attempt timed out during
PGlite startup. The rebuilt desktop installer matched all 14,092 files
and its QA updater signature verified. Installed runtime testing remains
open for that installer.
The follow-up Windows PGlite fix passed direct first start and reopening in
the Windows 11 x64 guest. It retained the accepted setting and server
identity, and both launches shut down cleanly on supervision stdin close.
The native archive built with that fix passed the full PGlite standalone
case. The same run reached bundled PostgreSQL readiness and exceeded the
standalone shutdown deadline. The rebuilt NSIS installer matched all
14,092 staged files and its QA updater signature verified.
The patched installed app also passed six first-start and persisted-profile
reopen cases on the three stores. It retained the accepted settings and
identities, received real worker replies, and shut down cleanly through the
tray. A read-only guest disk snapshot matched all 14,092 installed files.
[Windows x64 qualification](RUST_SERVER_WINDOWS_CURRENT_ACCEPTANCE.md)

The Windows x64 rebuild at `01928fcff` passed the standalone three-store
matrix with the original stdin-close shutdown deadline. The rebuilt NSIS
bundle contains the same server executable and matched 14,092 payload
files. Its QA updater signature verified. All six fresh and reopened
desktop cases passed, and the held Task dispatch returned HTTP 409
before the original Task completed and the browser decrypted its answer.
[Windows rebuild qualification](RUST_SERVER_WINDOWS_CURRENT_ACCEPTANCE.md#windows-x64-rebuild-at-01928fcff)
The [native desktop workspace qualification](RUST_SERVER_DESKTOP_WORKSPACE_ACCEPTANCE.md)
also exercises actual macOS popouts, dirty documents, server restart, WebView
reload, application SIGKILL/restart, native close/return and explicit worker-file
saves across all three stores. Its debug app and isolated development vault have
a distinct scope from the release-app encryption qualification.
Final supported-platform shipping and requirement-by-requirement reconciliation
remain open.

The macOS ARM64 `1.1.2881` package passed the same-source local PGlite
runtime benchmark. The worker-log comparison passed 64 MiB streams,
slow-consumer closure, and restart recovery on all three stores.
[Current runtime and stream measurements](security/rust-server-2881-performance-acceptance.json)

The macOS ARM64 rebuild at `01928fcff` also matched the `1.1.2881` Node
reference for 64 MiB WorkerLink downloads and tunnel echoes across all three
stores. Both peers passed selective revocation, slow-consumer closure,
reconnect and crash recovery with retained state.
[WorkerLink rebuild record](security/rust-server-2881-macos-acceptance.json#workerLinkRebuild)

The [packaged replica qualification](RUST_SERVER_PROVISIONING_STATE_CONTRACTS.md#packaged-replica-lifecycle-and-shared-peers)
compares the current local Git attach and detach flow on all three stores.
With shared PostgreSQL and Redis, all four Node and Rust pairings preserve two
remote worker connections, the settled job and its exact replay through the
loss of the browser-facing peer.

The `1.1.2881` package completed eight peer replacements across all four
Node and Rust pairings. The existing browser and full worker retained
their session, encrypted file operations, and workspace state over
shared PostgreSQL and Redis.
[Current rolling resource acceptance](security/rust-server-2881-shared-resource-rolling.json)

The [packaged native admission qualification](RUST_SERVER_NATIVE_RECOVERY_CONTRACTS.md#packaged-autonomous-task-completion)
fixes an autonomous Goal that committed its terminal outcome while its Task
stayed implementing. The browser and packaged worker complete the Task and
retain both encrypted answers across restart on all three stores and two Rust
peers. The Agent queue comparison also exercises actual native receipts on all
three stores.

The [streamed direct Task receipt comparison](RUST_SERVER_NATIVE_RECOVERY_CONTRACTS.md#direct-task-receipt-arriving-before-the-final-stream-event)
forces the durable outcome to overtake its final stream event. The current
package preserves the finished encrypted answer, exact replay and restart
on all three stores and two shared Rust peers. The retained Goal failures
and their reruns have separate acceptance evidence.

The [streamed Goal receipt comparison](RUST_SERVER_NATIVE_RECOVERY_CONTRACTS.md#goal-receipt-arriving-before-the-final-stream-event)
forces the explicit Goal input to deliver its durable result before the
final stream event. The packaged worker and browser preserve the final
answer and exact replay on all three stores and two shared Rust peers.
The controlled autonomous Goal receipt and the same-profile post-write
rollback also pass on all three stores.

The [autonomous Goal lane comparison](RUST_SERVER_NATIVE_RECOVERY_CONTRACTS.md#autonomous-goal-projection-after-recovered-lane-or-peer-loss)
holds the native turn while the actual browser Recovery action reactivates
its lane. The packaged Rust peer releases that exact lane after the
outcome commits. If the worker-owning server is killed before receiving
the observation, a replacement resumes the durable work with the same
worker process and preserves the two encrypted answers across restart.

The [shared dependency comparison](RUST_SERVER_NATIVE_RECOVERY_CONTRACTS.md#autonomous-goal-projection-during-shared-dependency-interruption)
repairs a mixed Redis outage that left an acknowledged Goal outcome
with its recovered lane still active. The Rust peer retries the worker
observation from the terminal marker and settles the original lane.
The [external PostgreSQL interruption comparison](RUST_SERVER_NATIVE_RECOVERY_CONTRACTS.md#mixed-peers-during-the-external-postgresql-outage)
also settles the original Goal on two Rust peers and in both mixed
orientations. The legacy Node readiness and exit behavior have their
own recorded evidence.
The `1.1.2881` macOS ARM64 package and freshly compiled Node reference
repeated both interruptions with both mixed orientations and two Rust
peers. All six complete runs projected the original committed Goal
outcome and preserved the original worker across dependency restart.
[Current Goal dependency acceptance](security/rust-server-2881-goal-dependency-acceptance.json)

The macOS ARM64 `1.1.2881` standalone server and packaged Node worker passed
the encrypted browser Task and autonomous Goal flow on all three stores.
The freshly compiled Node reference ran the same cases. The browser
completed planning, Goal continuation, retry after a controlled model
failure, and restart recovery without duplicate inference.
[Current Task and Goal acceptance](security/rust-server-2881-browser-task-goal.json)

The packaged macOS ARM64 `1.1.2845` server and signed desktop worker passed
the current Task and Agent product matrix against the Node reference. All
six suites cover real native execution across PGlite, bundled PostgreSQL
and external PostgreSQL. The reports record 150 product steps, 42 clean
server exits, 54 clean worker exits and 144 model requests. Protected model
operations also pass 72 paired cases across the same stores, including
cancellation, exact usage, worker loss and retained restart.
[Current product evidence](security/rust-server-current-native-product.json)

The [Task Goal provider transfer qualification](RUST_SERVER_GOAL_RECOVERY_CONTRACTS.md#cancelling-a-prepared-transfer-and-recovering-a-committed-transfer)
uses the existing browser and locally rebuilt worker to cancel a prepared
transfer and recover a committed transfer after worker loss. Both paths keep
the original conversation, send its queued input once and reopen the finished
Goal on all three database modes.

The local source and server boundary audits verify all 17 generated contract
graphs and maps, the current route inventory, real Rust authentication after
restart and current HTTP authority boundaries.

The rebuilt macOS ARM64 server matched the Node reference on 100 App Live
socket cases across the three stores and four authentication or capacity
profiles. Chromium and the existing worker client components also matched
14 steps per store, including replay from a retained cursor, heartbeat,
credential rotation, reconnect and revocation.
[App Live and worker coverage](security/rust-server-coverage.json)

The [Linux Redis TLS comparison](RUST_SERVER_REDIS.md#packaged-linux-redis-tls)
qualifies authenticated TLS, certificate trust, Redis process restart, worker
routing, App Live replay and cross-peer sign-out through the optimized
`1.1.2855` Linux ARM64 and x64 images and the compiled Node reference. Both
images also pass the standalone suite on all three stores.

The [packaged active Task recovery](RUST_SERVER_INFLIGHT_RECOVERY.md#packaged-112845-dependency-recovery)
qualifies `1.1.2845` with the signed desktop worker on external PostgreSQL.
All four Node and Rust pairings complete one original Task during Redis
process loss and recover worker routing afterward. Two Rust servers preserve
and deliver the original worker outcome through PostgreSQL process loss.

The [embedded PGlite cache recovery](RUST_SERVER_DATABASE_LIFECYCLE.md#embedded-pglite-cache-recovery)
repairs actual startup failure from incomplete automatically extracted assets.
Concurrent fresh and retained profile starts pass with the original identity
and accepted write preserved. Configured assets still surface actual failures.

The [host inventory and CantripOS guest comparison](RUST_SERVER_REMOTE_SURFACES.md#current-host-inventory-and-cantripos-guest-surfaces)
fixes the single-worker desktop inventory request. It qualifies encrypted
host inventory, a real guest desktop before and after restart, stale
placement rejection and an encrypted guest TCP tunnel. All 323 worker
command identities now have scoped ledger evidence.

The [current computer-use lifecycle comparison](RUST_SERVER_COMPUTER_USE.md#current-browser-and-full-worker-lifecycle)
qualifies effects sync, operations and preview open/Stop through the browser
and full worker on all three stores and all four PostgreSQL and Redis
pairings. It verifies encrypted approval denial, fresh leases after feature
re-enable and a decoded PNG through the explicit fake capture backend. The
scoped command ledger accounts for 319 of 323 identities.

The [current browser surface lifecycle comparison](RUST_SERVER_REMOTE_SURFACES.md#current-browser-suspend-and-resume)
qualifies suspend and resume through the full worker and actual Chromium on all
three stores and all four PostgreSQL and Redis pairings. An offline resume
persists the existing error. Server restart clears that transient status and
retains exact encrypted state. A successful resume restores authenticated frames
on the original attachment. Scoped worker command coverage accounts for 315 of
323 identities.

The [native Agent approval cancellation comparison](RUST_SERVER_AGENT_APPROVAL_CANCELLATION.md)
passes the full-worker cancellation and normal approval control on all three
stores. Both peers interrupt the next prompt in the canceled Agent before it
reaches the model. Restarting the worker recovers the same Agent, and both
approval outcomes and the recovered reply survive server restart. Scoped worker
command coverage accounts for 313 of 323 identities.

The [first-turn Chat and Agent title comparison](RUST_SERVER_INLINE_CHAT_LABEL_ACCEPTANCE.md)
qualifies private title grants, first-turn inference and byte-for-byte title
retention after restart on all three stores. An unusable label preserves the
existing title and the response completes. A newly provisioned standalone
Chat executes through its opaque scratch routing handle. The direct scratch
resolve handler stays in the worker contract. Scoped worker command coverage
accounts for 312 of 323 identities.

The standalone scratch filesystem comparison ran the existing browser APIs
and App Live client against the rebuilt Rust server and the Node reference
with the same packaged worker. On all three stores, the worker provisioned
the directory and handled encrypted listing, read, reference resolution,
save, and delete requests. A stale file version and a mismatched root binding
were rejected. The file and root identity survived an archive and worker
restart. When the archive committed while the worker was offline, its next
connection applied the retained archive deadline. Permanent deletion removed
the worker directory and registry entry. All 114 captured HTTP exchanges
kept titles, paths, and file contents encrypted. The bundled PostgreSQL
comparison used a separate external cluster for the Node reference.
[Coverage ledger](security/rust-server-coverage.json)

The [automatic Task title comparison](RUST_SERVER_TASK_LABEL_ACCEPTANCE.md)
fixes browser authorization for the worker's private label key. With that key,
the current Rust server and Node reference complete standalone label generation
through the full worker and native Codex on all three stores. The browser opens
the same encrypted title after restart, and an unavailable title key still
allows Task planning admission. Scoped worker command coverage accounts for
311 of 323 identities.

The [provider sign-out comparison](RUST_SERVER_PROVIDER_AUTH_WORKER_ACCEPTANCE.md)
passes the existing browser SDK and full worker for legacy ChatGPT and Grok
accounts on all three stores. The selected credential file is removed while a
neighboring account's file remains byte-for-byte intact. The current status route
uses stored account state and legacy capture, and the original direct status
command remains worker-only. Scoped worker command coverage accounts for 310 of
323 identities.

The [active Task PostgreSQL comparison](RUST_SERVER_INFLIGHT_RECOVERY.md#active-task-during-a-postgresql-process-outage)
passes two 45-second outages with two current Rust production servers and
the full worker. The original outcome stays in the worker's durable outbox
until the same database cluster reopens and accepts it. The existing browser
then sees one completed result, and a new remote worker request succeeds.
Node-reference failures under this fault remain recorded.

The [active Task Redis comparison](RUST_SERVER_INFLIGHT_RECOVERY.md#active-task-during-a-redis-process-outage)
passes all four Node/Rust pairings on shared PostgreSQL. Across a real
45-second Redis outage, the remote Task retains and extends its original
PostgreSQL lease and completes once before Redis restarts. The unchanged worker
reclaims coordination with a fresh connection ID and receives a new remote
request. A separate mixed-pair control passes an actual worker-owner server
crash with the surviving Rust server holding the Task lease.

The [WorkerLink lease recovery comparison](RUST_SERVER_WORKER_LINK_LEASE_RECOVERY.md)
passes real LAN peer and native LOCAL broker renewals through the full worker
on all three stores. It verifies the reconnect grace response, old authority
retirement after worker or server replacement, and fresh lease renewal after
both process kills. Scoped worker command coverage accounts for 308 of 323
identities.

The [terminal and replica qualification](RUST_SERVER_TERMINAL_REPLICA_ACCEPTANCE.md)
passes real CLI scrollback and legacy replica deletion through the existing full
worker on all three Rust storage modes. Current import and worktree-list controls
also account for two retained legacy worker handlers. Scoped worker command
coverage accounts for 306 of 323 identities.

The [current Windows qualification](RUST_SERVER_WINDOWS_CURRENT_ACCEPTANCE.md)
passes `1.1.2869` standalone across all three stores on the Windows x64
guest and verifies 2,281 package files and three SQL export checksums. The installed `1.1.2839` to
`1.1.2841` signed update retains the PGlite profile, server identity and
accepted write and exercises the full worker before and after installation.
The installed app converts an archived Node profile and preserves all
1,660 original files. The installed bundled and external PostgreSQL profiles
also verify their selected database process, an accepted settings write and
the real worker reply. The separate Windows ARM64 guest qualifies Node
`22.23.4` worker restart and owner loss across all three stores, plus
post-write rollback and native re-upgrade of the published Node profile.

The [current Linux ARM64 qualification](RUST_SERVER_WINTERHOLD.md#current-linux-arm64-qualification)
passes all three stores in the `1.1.2845` container and local systemd
rehearsal. All 18 installer cases pass, and ten direct process hashes confirm
the current and previous native releases through post-write rollback.

The [current macOS ARM64 signed-update rehearsal](RUST_SERVER_DESKTOP_SIGNED_UPDATE.md)
passes `1.1.2786` to `1.1.2831` on all three stores with the same Developer
ID. The real updater rejects a changed archive, installs the valid release,
and retains the encrypted WebView session, worker connection, server identity
and accepted write. The two private stores and the external PostgreSQL
connection are verified before and after installation.

The [current Winterhold and Linux x64 qualification](RUST_SERVER_WINTERHOLD.md#current-linux-x64-qualification)
uses the exact `1.1.2881` distribution and container across all three stores.
The container passed 2,546 package hashes per store. All 18 installer cases
passed with verified Caddy TLS, post-write rollback, and ten running
executable hashes. The local x64 runs use emulation on an ARM64 Linux host.
Final desktop and multi-instance acceptance remain open.

The [CantripOS source backup comparison](RUST_SERVER_OS_SOURCE_BACKUP.md)
repairs public backup placement errors and qualifies physical restore and
rollback in an actual guest across all three stores. Both peers recover the
original encrypted worker receipts after lost replies. The guest retains the
source, the original destination home and the write made after restore.
Scoped worker command coverage accounts for 302 of 323 identities.

The [CantripOS Run lifecycle comparison](RUST_SERVER_OS_RUN_LIFECYCLE.md)
uses the existing browser SDK, production servers, full worker and real Linux
guest across all three stores. It verifies encrypted output and the same
process across server and worker loss, then advances the generation on
restart and terminates the replacement on Stop. Scoped worker command coverage
accounts for 300 of 323 identities, including four worker handlers without
current server producers. The worker's large retained-output truncation test
remains open.

The [encrypted Chat steer comparison](RUST_SERVER_LEGACY_CHAT_STEER.md)
exercises an active Chat without a native activation across all nine storage and
authentication combinations. It verifies the actual worker codecs and steer RPC
inputs, rejection, and exact encrypted message and queue state through 18 paused
server restarts. Scoped worker command coverage is 290 of 323. The native turn
and RPC result are controlled, and unpaused reconnect and settlement remain open.

The [encrypted Chat import comparison](RUST_SERVER_ENCRYPTED_CHAT_IMPORT.md)
runs the worker's message, metadata, and relay encryption across all nine
storage and authentication combinations. The tests compare 330 scenarios and
621 HTTP observations, retain ciphertext through 18 server restarts, and reject
all 18 altered relay chunks with partial upload cleanup. The scoped worker
command ledger covers 289 of 323 identities.

The [managed automation resume qualification](RUST_SERVER_AUTOMATION_RESUME_CONTRACTS.md)
restores current-user Live invalidations after successful public Chat execution
mutations. All nine storage and authentication combinations match 108 product
HTTP observations, 27 paired worker SDK requests and 117 Live events, with 18
retained server restarts. Scoped worker command coverage is 288 of 323. Native
resume and Goal mutation results are controlled.

The [current Task execution qualification](RUST_SERVER_TASK_EXECUTION_CONTRACTS.md)
compares scheduled direct and initial planning operations and protected
follow-ups across all nine storage and authentication combinations. The
existing worker codecs and SDK produce 156 paired product HTTP observations,
108 native input acknowledgements, 180 matching Task message events and 36
exact reopens. Two partial mappings bring worker command coverage to 286 of 323. The suite controls model replies and leaves final product and shipping
acceptance open.

The [current Goal recovery qualification](RUST_SERVER_GOAL_RECOVERY_CONTRACTS.md)
connects retained Task and worktree recovery to authenticated worker
connections and heartbeats. All nine storage and authentication combinations
pass, with 165 paired HTTP observations and 54 exact reopens. The new Task
source, Task cycle recovery, Agent source recovery and Agent first-cycle claim
recovery mappings bring scoped worker command coverage to 284 of 323.
Controlled native observations, the remaining 39 command identities and full
shipping acceptance remain open.

The [current native interruption/queue qualification](RUST_SERVER_NATIVE_CONTROL_CONTRACTS.md)
repairs public SQL-error diagnostics after actual failed opaque queue updates.
All nine storage/authentication cells pass, including both Chat contexts, actual
worker codec cryptography, transaction rollback, caller loss, worker replacement,
real notification deadlines and complete retained reopen. Its 531 paired HTTP
observations bind three new command identities, bringing scoped coverage to
280/323. Controlled native replies, remaining 43 identities, historical partials
and full final supported-artifact/product acceptance remain separate.

The [current Chat/control qualification](RUST_SERVER_COMMAND_CONTROL_CONTRACTS.md)
repairs standalone queue reads that omitted the revision required by mutations.
All three nine-cell approval, public Chat and Task matrices pass with 2,208 paired
HTTP cases, 702 command witnesses, actual endpoint cryptography/native SDKs and
exact durable reopen checks. Eight new command mappings bring scoped coverage
to 277/323. Controlled native/model replies, historical partials and full final
supported-artifact/product acceptance remain separate.

The [current filesystem/progress Live qualification](RUST_SERVER_LIVE_OBSERVATION_CONTRACTS.md)
passes eighteen production HTTP storage/authentication cells, retaining 1,821
paired cases and 90 original filesystem/progress frames. Separate core Hub
comparisons qualify owner fanout, unsubscribe and replay for `server` with
controlled IO. All 47 Live identities now have scoped mappings; the `server`
mapping is partial transport evidence, without a verified dedicated HTTP
publisher. Worker commands remain 269/323. No production Rust change was needed;
remaining command identities, historical partials and full final product/artifact
acceptance remain open.

The [current Chat Goal/queue qualification](RUST_SERVER_CHAT_GOAL_QUEUE_CONTRACTS.md)
repairs missing native response-completion Goal invalidations. Its three nine-cell
matrices retain 2,403 paired HTTP cases, 18 caller-disappearance phases, actual
worker transport/cryptography and 468 complete Goal/queue Live events. The new
bindings account for eight commands and two Live types, bringing scoped totals
to 269/323 and 44/47. Controlled worker replies do not qualify leaf Git/native
model execution or complete current supported-artifact shipping acceptance.

The [current provider authentication/quota/inference qualification](RUST_SERVER_PROVIDER_LIVE_CONTRACTS.md)
passes all four nine-cell storage/authentication matrices. It repairs public
SQL-error projection drift, retains account/device/quota effects and validates
coalesced inference delivery with held and rejected-owner acknowledgements,
retry and exact raw provider reopen. Its 2,115 paired HTTP observations bind
seven further commands and two Live resources. Totals are 261/323 commands and
42/47 Live types, including partial scopes. Controlled worker replies do not
establish real OAuth/native inference or final supported-artifact acceptance.

The [current persisted-resource qualification](RUST_SERVER_PERSISTED_RESOURCE_CONTRACTS.md)
adds complete accounting and browser/surface rows, exact raw reopen and public
usage/tenant comparisons across all three stores. Browser HTTP also passes all
three authentication profiles. The 165 repository scenarios, 195 paired SQL
stages and 504 paired HTTP case observations bind the final six table identities
and browser configuration command. All 135 tables now have scoped behavioral
evidence; worker-command and Live totals are 254/323 and 40/47. Partial consumers,
remaining categories and complete final shipping acceptance remain open.

The [current provisioning-state qualification](RUST_SERVER_PROVISIONING_STATE_CONTRACTS.md)
passes both nine-cell folder and replica matrices against the production Rust
HTTP server. It adds complete raw project/job reopen comparisons and 108
independently verified admission fingerprints while retaining existing command,
ordered Live, failure and restart assertions. Its 1,119 paired HTTP observations
bind five commands, three tables and three Live resources. Ledger totals are
253/323 commands, 129/135 tables and 40/47 Live types, including partial scopes.
Controlled worker facts do not establish leaf Git/filesystem execution or
complete supported-platform shipping acceptance.

The [current worker/provider state qualification](RUST_SERVER_WORKER_PROVIDER_CONTRACTS.md)
passes the existing twelve-cell worker-management matrix and a new nine-cell
provider-state matrix. Actual catalog commands, SQL rollback, durable model
suppression, worker/server replacement and inference Live identity fences have
864 paired HTTP observations across all three stores. The ledger now accounts
for 248/323 worker commands, 126/135 tables and 37/47 Live resources, including
partial scopes. Controlled catalog replies do not qualify actual provider
execution or successful inference configuration; final shipping and complete
replacement acceptance remain open.

The [current Git/GitHub command qualification](RUST_SERVER_REPOSITORY_COMMAND_BOUNDARIES.md)
reconciles 88 protected repository inner types across both current HTTP scopes,
all stores and authentication modes. It separately qualifies the active Task
dashboard PR-list producer and proves 76 legacy plaintext HTTP identities return
410 without dispatch. The ledger accounts for 244/323 worker-command identities,
including 87 worker-owned protected operations. Full leaf Git/GitHub execution,
remaining category scopes and original-goal shipping acceptance remain open.

The [current suspension and Task outcome qualification](RUST_SERVER_NATIVE_RECOVERY_CONTRACTS.md)
compares the three previously unmapped internal HTTP identities across all three
stores and authentication modes. It repairs suspension error text, an autonomous
Goal post-commit failure and Goal-cycle conflict status. Actual SQL rollback,
worker replacement, server restart, original encrypted answers and historical
round preservation have current paired evidence. The ledger now maps all 584
HTTP identities, including partial scopes, and 121/135 tables. Remaining
command/table/Live scopes, historical partials and final supported-artifact
acceptance remain open; controlled checkpoint facts do not execute native Core.

The [current OS and execution qualification](RUST_SERVER_OS_EXECUTION_CONTRACTS.md)
repairs attachment acknowledgement, Run response routing and public placement
errors. Current nine-cell HTTP comparisons cover source/backup recovery after
server restart, protected repository operations, worktree commands, durable Run
and secret receipts, and four further Live resources. The ledger now maps
581/584 routes; three internal suspension/Task Goal routes remain unmapped.
Controlled worker replies do not qualify actual guest archive execution, and
remaining category gaps and final supported-artifact acceptance remain open.

The [current resource-state qualification](RUST_SERVER_RESOURCE_STATE_CONTRACTS.md)
reconciles the remaining 24 repository identities and refreshes the historical
partial Chat execution-context mapping. It preserves owned-null model defaults,
qualifies Task/queue/status/ordering and terminal/remote-surface behavior, and
records three unused private-helper dispositions. All 370 repository identities
are now accounted for, including five obsolete helpers; other category gaps and
complete supported-artifact/original-goal acceptance remain open.

The [current project/Run state qualification](RUST_SERVER_PROJECT_STATE_CONTRACTS.md)
adds thirteen active repository identities and two explicit obsolete-helper
dispositions. It repairs strict captured-root validation, status/output/lifecycle
error propagation and actual SQL diagnostics, with all-store repository and
nine-cell HTTP comparisons. Optimized package relocation and public checks pass.
The ledger now maps 346/370 repository identities; full replacement acceptance
remains open.

The [current identity-state qualification](RUST_SERVER_IDENTITY_STATE_CONTRACTS.md)
binds twelve further repository identities, repairs stale model-operation usage
attribution, and exercises actual session/mobile-grant callers and desktop-update
counts across all nine storage/authentication cells. Optimized authentication and
relocated-package checks pass all three stores. The ledger now maps 331/370
repository identities; remaining category gaps and final supported-artifact
acceptance remain open.

The [current worktree observation qualification](RUST_SERVER_WORKTREE_OBSERVATIONS.md)
repairs the omitted native worker-status consumer and compares its durable state,
Live events, failures and restart behavior across all nine local storage/authentication
cells. The subsequent [durable Git-operation qualification](RUST_SERVER_GIT_OBSERVATIONS.md)
implements the remaining consumer and all seven repository methods, including
real SQL failures, shared FIFO ordering, held-inspection shutdown, retained
restart and worker reconnect. Complete original-goal acceptance remains open.

The [current Chat/model identity qualification](RUST_SERVER_CHAT_IDENTITY_CONTRACTS.md)
adds 3,368 paired observations across all three stores and repairs empty model
route selection, offline Plan status handling and missing/null resume identity.
It also binds 26 additional current repository identities and both Plan routes
to successful operations. These scoped results advance the remaining contract
audit; they do not close full supported-artifact or original-goal acceptance.

The [Linux ABI qualification](RUST_SERVER_LINUX_ABI.md) fixes the actual Debian 12
ARM64 native PGlite link failure. Fresh `1.1.2783` ARM64 and x64 images, exported
Ubuntu distributions and systemd/Caddy rehearsals pass their three-store matrix.
This preserves the original Linux baseline; complete desktop acceptance and the
Rust-default/production-Node removal remain separate.

The [current native package qualification](RUST_SERVER_CURRENT_PACKAGED_ACCEPTANCE.md)
adds actual Windows x64 artifact execution on an ARM64 Windows kernel. All three
stores, emoji/space package and profile paths, exports, restart and the embedded
runtime fallback pass after static zlib and per-process UTF-8 repairs. Current
macOS server-package and full-worker desktop-supervisor comparisons also pass
on all three stores. Complete app/platform, update, historical-profile,
performance and final cutover requirements remain separate.

The [current wire reconciliation](RUST_SERVER_CURRENT_WIRE_COMPATIBILITY.md)
closes the missing schema/command fixtures and stale public-surface expectations.
Broad native comparisons, complete outgoing command mutations and protocol
package tests pass locally. Five strengthened fixture families have separate
current native comparisons; their cases overlap the broad run. This establishes
the recorded parser coverage, while full product and shipping acceptance remain
separate.

The [Task Goal worker-loss comparison](RUST_SERVER_TASK_GOAL_WORKER_RECOVERY.md)
now qualifies active implementation recovery with the final optimized executable
on all three stores and all four shared pairings. It preserves one opaque native
answer, the original Task/Goal authority and exact completed restart state. The
six existing production Task and Agent/Task suites also pass. Changed-response
replay, legacy publishers, historical delivery, autonomous cycles and actual SQL
rollback have separate all-store repository qualification. Broader worker/native
loss, platform/artifact, performance and final cutover requirements remain.

The [Task worker-process recovery](RUST_SERVER_TASK_WORKER_RECOVERY.md)
qualification adds explicit terminal observation and guarded failure settlement
for expired direct/planning rounds. Current debug and optimized peers pass
direct-Task worker loss on all three stores and all four shared pairings,
including repeated Recovery, the real legacy retry adoption timer, explicit
Retry and exact history restart. Optimized peers also pass planning-round worker
loss on that complete matrix. Resumption/Goal, broader worker-loss and final
replacement acceptance remain separate.

The [current product and shared Agent recovery](RUST_SERVER_SHARED_AGENT_RECOVERY.md)
qualification refreshes the actual production matrix to the current 92-patch
native runtime and rebuilt worker. All six local storage/product cases and both
active Agent/Goal crash roles across all four shared peer pairings pass. It also
repairs premature logical GUI completion after remote relay-owner loss in both
servers. Remaining platform/artifact, worker-loss, long-outage, performance and
cutover acceptance is separate; broader repository checks retain their failures.

The [credential lifecycle comparison](RUST_SERVER_WORKER_CREDENTIAL_LIFECYCLE.md)
captures enrollment creation/completion/rejection and credential rotation/revocation.
Its debug and optimized production matrices pass all nine storage/authentication pairs,
including actual account/identity replacement, rejected replacement rollback,
delivery outcomes and redaction. Separate logger cases preserve console-only
undefined properties without introducing them into archived JSON. Complete
current artifact/platform and replacement acceptance remain required.

## Browser server switching and mobile QR sign-in

The built `1.1.2856` browser client ran against the optimized macOS ARM64
`1.1.2854` Rust package and the compiled Node reference. The Rust package
ran in hosted account mode on PGlite, bundled PostgreSQL and external
PostgreSQL. The Node reference used external PostgreSQL in each pairing.

The browser scanner initially obtained a camera stream and left the preview
unattached. The dialog portal mounted the video after the scanner effect
had run. The scanner now starts decoding when the video mounts. A component
regression test reproduces the previous failure and verifies that scanner
teardown stops the decoder.

Each pairing signed in through the desktop browser layout, added the second
server and switched between the two accounts. The mobile browser read the
actual QR rendered by the signed-in app from a virtual camera feed. It verified
the responding server identity, opened an independent secure HttpOnly
session, and recovered encrypted access through the existing password
prompt. App Live resubscribed after reload. Mobile sign-out left the issuing
browser signed in. The desktop browser retained each account through
switching, and Rust restart preserved its original identity and session.

The three runs completed six QR transfers and nine clean server exits.
The mobile runs used Chromium's iPhone viewport and virtual camera. Installed
iOS and Android camera integration retains its separate acceptance scope.

The `1.1.2881` web build, packaged macOS ARM64 Rust server and compiled
Node reference repeated this flow on all three Rust stores. Chromium passed
21 scenario steps, six QR exchanges and nine clean server shutdowns.
Both accounts retained their original desktop sessions after switching, and
the Rust account and server identity survived restart. The bundled PostgreSQL
run initially timed out scanning a perfectly static QR frame. A virtual
camera feed with slight rotation decoded the app-rendered QR through the
same browser scanner and completed the real exchange. The
[current browser acceptance record](security/rust-server-2881-browser-mobile-sign-in.json)
binds the reports to the built client and server artifacts.

The `1.1.2976` renderer and macOS ARM64 Rust package repeated the
three-store browser matrix with the compiled Node reference. The runs
completed six QR exchanges and nine clean server shutdowns. Both accounts
survived server switching, and the Rust identity and session survived
restart. The initial PGlite pairing stalled while scanning the Node QR
with the static feed. The rotating feed passed with the same scanner and
session assertions.
[Browser 1.1.2976 evidence](security/rust-server-2976-browser-mobile-sign-in.json)

## Installed mobile sessions and Android QR sign-in

The installed `1.1.2867` clients ran against the packaged macOS ARM64
`1.1.2866` Rust server in hosted account mode. The local TLS fixture ran
one PGlite peer and one bundled PostgreSQL peer. Both clients opened
encrypted accounts, connected to App Live on both peers, and kept access
while switching servers after clean Rust process restarts.

Android Keystore rejected the caller-provided AES-GCM IV during native
installation key creation. The client now uses the IV generated by the
Keystore-backed cipher and stores it in the existing record. The repaired
APK recovered the existing installation in place. The real Keystore
instrumentation test created and reopened a wrapped key, and the frozen
version-one fixture remained readable. The installed Android scanner used
an emulator camera image of the browser-issued QR. The Rust peer returned
secure HttpOnly cookies, the app opened the second encrypted account, and
both accounts remained accessible through one native installation key.

The iOS simulator build used an ad hoc signature with its application
identifier entitlement so the installed app could use Keychain. Its UI test
passed server switching and app relaunch both before and after the Rust
process restarts. The local [acceptance record](security/rust-server-installed-mobile-acceptance.json)
includes the artifacts and observed wire results.

The installed `1.1.2976` Android APK signed in on all three database modes,
switched servers, and retained the same Android Keystore key and three account
bindings through app relaunch and Rust process restarts. The real Keystore
instrumentation test passed. The installed `1.1.2976` iOS simulator app
recovered encrypted access and retained all three account bindings across
app relaunch and Rust process restarts. Both apps used the same verified
1.1.2976 renderer. Authenticated session reads and App Live upgrades were
observed over TLS for all six app and database pairings. The Android native
scanner exchanged a fresh browser-issued QR over external PostgreSQL and
reopened the existing encrypted account with its native key. The
[installed mobile record](security/rust-server-2976-installed-mobile.json)
contains the exact app and server artifacts and the remaining mobile checks.

Xcode exported the ARM64 iOS 1.1.2976 archive locally with App Store
distribution signing. The exported IPA passed signature and provisioning
verification and contained the same 195 renderer files as the installed
simulator build. Physical iOS camera sign-in remains open.

The installed `1.1.2881` iOS simulator app passed sign-in on PGlite, bundled
PostgreSQL and external PostgreSQL against the packaged macOS ARM64 Rust server.
It retained its account bindings and native installation key across app relaunch
and Rust process restarts. Each mode returned an authenticated session and
upgraded App Live over TLS after its restart. The
[current iOS acceptance record](security/rust-server-2881-ios-acceptance.json)
includes four passing XCTest runs and six clean Rust exits. Installed iOS QR
sign-in, physical devices and shipping mobile packages retain separate
acceptance.

The installed `1.1.2881` Android API 36 app also passed sign-in and session
recovery on all three stores. It retained one Android Keystore key and all
three account bindings after app relaunch and Rust restarts. A browser-issued
QR entered through the emulator camera and the native scanner. The Rust
server backed by external PostgreSQL exchanged the grant for a secure session. The
[current Android acceptance record](security/rust-server-2881-android-acceptance.json)
includes the installed APK digest, real Keystore test and wire results.

## Current CLI and queued Task provider transfer

The `1.1.2881` Rust source passed 972 paired CLI calls across PGlite,
bundled PostgreSQL and external PostgreSQL in anonymous, password and
account modes. The suite used the existing worker CLI client and real
worker connections, and included 18 admitted socket disconnects and 18
server restarts.
[Current CLI matrix](security/rust-server-cli-http-contract-matrix.json)

Queued Task provider transfer preserved the encrypted input and fenced the
old dispatch before sending a worker revocation. In all three Rust stores
the route remained draining until the replacement connection acknowledged
settlement. The Node reference stayed draining after positive replies. Its
JSON serialization comparison encountered different property order.
The packaged Rust server and Node worker also passed the offline transfer on
all three stores. After a fresh worker process rejoined with its retained
enrollment, the transfer completed at revision 4 with the original encrypted
input. The local-store cases confirmed the committed state after shutdown.
These cases seeded queued input. In a separate external PostgreSQL run, the
existing browser and packaged worker started a real Codex request. While the
model response was held, both the Node reference and the packaged Rust server
withheld the queued source and returned HTTP 409 `stale-lease` without changing
the Task or its dispatch fence. The original Task completed when the response
resumed. The Linux ARM64 and x64 containers also passed queued settlement and
active-dispatch rejection with external PostgreSQL and the packaged macOS
worker. Both browser runs completed the original Task, a planned Goal, a retry,
and recovery from paused admission. The x64 container ran under Rosetta.
The earlier Linux images also passed both cases with bundled PostgreSQL and
with PGlite on ARM64. The x64 PGlite run exposed a read that combined a
completed transfer with revision 3. The Rust route now reads both fields
from one database snapshot. The rebuilt x64 package settled the queued
PGlite transfer at revision 4 with fence 9 and the original encrypted input.
A separate external PostgreSQL run forced a read across settlement and
returned the complete revision 4 snapshot.
The rebuilt x64 PGlite package also rejected transfer after dispatch and
completed the original Task. On the rebuilt x64 image, queued settlement and
rejection after dispatch passed with all three stores. Migration, SQL export,
restart, and hosted reopening passed on each store. Its native
archive matched all 2,546 manifest entries. The rebuilt ARM64 image passed
the same three-store tests and deterministic read during settlement. Its
native archive matched all 2,546 manifest entries.

Both Linux images rebuilt at `01928fcff` passed queued transfer and active
dispatch rejection on all three stores. Each browser run held the model
response, received HTTP 409 with `stale-lease`, and completed the original
Task with the durable state preserved. Both images also returned the complete
revision 4 snapshot when the external PostgreSQL read crossed settlement.
The browser and packaged worker ran on macOS. The x64 server image ran
through Rosetta in Docker Desktop.

The Windows x64 package rebuilt at `01928fcff` passed queued transfer and
replacement-worker settlement on all three stores. On external PostgreSQL,
the Windows server also returned the complete revision 4 snapshot across a
deliberately held settlement lock. Windows rejection after active dispatch
while a model response is held remains open.
[Task provider transfer record](security/rust-server-task-inference-route-acceptance.json)

## Current implementation and evidence

The macOS ARM64 standalone distribution `1.1.2935` passed migrations, settings
writes, restart, hosted reopening, SQL export and graceful shutdown on PGlite,
bundled PostgreSQL and external PostgreSQL. The runtime test removed Node from
the server's PATH and denied Homebrew access and artifact writes. The retained
archive matches all 1,762 manifest entries. The same release executable passed
the CLI worktree continuation matrix and the two-Rust-peer Goal interruption
cases with the rebuilt worker.

The local signed macOS updater installed `1.1.2935` over `1.1.2869` on all
three stores. Each installed app preserved its database mode, server identity,
worker enrollment, written setting, device keys and account bindings. The
PGlite case rejected a tampered download before stopping either child.
All 13,571 candidate files and links matched the signed archive for each
installation. The QA renderer used the existing generated version module
`1.1.2845`. The shell, worker and server reported `1.1.2935`. This was a local
Developer ID signed build using a disposable updater key.
[macOS release evidence](security/rust-server-2935-macos-release-acceptance.json)

| Area                          | Current evidence                                                                                                                                                                                                           | Remaining acceptance                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Declared HTTP routes          | The computer-use milestone's production probe completes 584 requests per peer with zero generic fallback differences.                                                                                                      | Successful behavior, events and recovery across complete domains; invalid-input routing alone is insufficient.                              |
| Generated contracts           | The refreshed source audit compares all 16 embedded schema graphs plus the endpoint-provider map with rebuilt TypeScript. All 17 match.                                                                                    | Custom semantics and full runtime/product/platform qualification.                                                                           |
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

## Current App Live and shared-server acceptance

The macOS ARM64 1.1.3032 standalone server matched the Node reference in
100 App Live socket cases, 24 HTTP cases and six unauthenticated upgrade
rejections across PGlite, bundled PostgreSQL and external PostgreSQL. The
comparison covered reconnect replay, connection limits, committed worker
invalidations, sign-out and shutdown. The external PostgreSQL run also held an
authorization query and verified that socket ping and close continued.

With shared external PostgreSQL and Redis, the browser and full packaged
worker also passed 128 resource steps across all four initial Node/Rust
pairings. All eight peer replacements retained the worker process and browser
session. App Live reconnected, and each replacement served encrypted file
reads and writes.
[macOS App Live and rolling replacement report](security/rust-server-3032-macos-live-rolling.json)

## Open background-service comparisons

The macOS ARM64 1.1.3032 archive passed account approval expiry and credential
reconnect against the development Node reference with external PostgreSQL.
Each peer drained a started database update on shutdown. The credential run
also recovered from a query failure and preserved the credential revision
through restart and worker purge. The same archive passed eight paired
log-archive scenarios across all three stores, including archive obstruction
and recovery while the server kept serving.
[macOS background-service report](security/rust-server-3032-macos-background-acceptance.json)

The same standalone executable matched the Node reference across all nine
database and authentication combinations for native command permission
transitions, pending requests, continuations and settings evidence. The
comparison includes 636 paired HTTP observations, 99 App Live events and
durable ciphertext verification with the existing worker transport and
controlled replies.
[macOS coordination and catalog report](security/rust-server-3032-macos-coordination-catalog.json)

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
INSERT during shutdown. On the 1.1.3032 executable, Rust completed the real
fifteen-minute interval and committed both held quota rows before exit. The Node
reference completed its real timer and exited after saving one of the two rows.
A separate paired shutdown run without the periodic stage saved both rows on
both peers. Both servers returned 404 for the fixture SQL route. A broader
catalog comparison also reconciles the custom endpoint label in native errors
and worker commands.

The [credential reconnect qualification](RUST_SERVER_CREDENTIAL_RECONNECT.md)
reproduces and repairs the next discrepancy: Rust's existing migration
coordinator had no production worker-connection caller. All nine local
storage/authentication pairs now match capture/purge, identity and revision
guards, nonportable credentials, failures, repeated reconnects and public
counter logs. The current optimized artifact also passes actual deadlines,
query failure/recovery, held credential UPDATE shutdown and retained
restart/purge. This does not establish real provider login or actual worker
credential-file encryption/deletion.

The [server log archive qualification](RUST_SERVER_LOG_ARCHIVE.md) adds the
bounded minimized-record buffer and daily native filesystem archive, wires the
production startup/shutdown lifetime and routes catalog/account lifecycle
diagnostics through shared capture. Sixteen production Node/Rust peer runs
cover all three stores, configuration, signals, failure and actual archive
recovery. The [HTTP and console qualification](RUST_SERVER_HTTP_LOGGING.md)
adds actual response-completion capture, console presentation and stream-error
behavior, and repairs fallback parser ordering exposed by the comparison.
The [request-target and route-level comparison](RUST_SERVER_REQUEST_TARGET.md)
also repairs URL decoding, early 400/414 responses, empty terminal parameters,
method-fallback headers and Pino child-level filtering. Its actual raw HTTP and
controlled-stream comparisons retain their distinct qualification scope.
The [database lifecycle qualification](RUST_SERVER_DATABASE_LIFECYCLE.md) adds
connection/migration/probe diagnostics and repairs connection/subscription retry
boundaries and retained-key initialization. A subsequent production comparison
passes actual role-wide PostgreSQL refusal/recovery under all three authentication
modes, retaining original sessions and accepted writes. Its bounded admission
fault does not establish long outages or other database/product interruptions.
Additional operational consumers remain unreconciled;
scoped passes do not prove identical whole-server logging or complete
background-service invariants.

The [accounting diagnostics comparison](RUST_SERVER_ACCOUNTING_DIAGNOSTICS.md)
reproduces missing native persisted records and routes reconciliation, history
maintenance and bandwidth-meter producers through shared capture and noise
control. Its current local qualification includes actual reference classes,
all nine storage/authentication production pairs and real PostgreSQL timer
failure/recovery and held-final-flush shutdown. Other production consumers and
the original full replacement acceptance remain required.

Continue those comparisons for the remaining product faults, performance and
supported artifacts. Final acceptance requires executable coverage of those
behaviors alongside the source inventory and schema comparisons.

The [worker bridge comparison](RUST_SERVER_WORKER_BRIDGE.md) qualifies native
diagnostics, packet sequence/callback repairs and connected shutdown handshakes.
All nine storage/authentication pairs pass on debug and optimized candidates;
separate actual wire tests cover held/early/missing ACKs, late responses and
blocked credential storage. Rejected authentication also retains its close ACK.
The optimized candidate also passes eighteen dedicated wire/authentication
server runs. Supported-artifact and complete replacement acceptance remain
separate.

The [worker authentication comparison](RUST_SERVER_WORKER_AUTHENTICATION.md)
ports rejected/successful authentication and claim-failure capture with the
existing repetition and redaction policy. Actual Redis paused writes reproduce
and repair a five-hundred-millisecond command timeout and the missing attachment
authentication deadline. Late claims remain owned after timeout, with actual
successful-claim discard and failed-claim capture before a held close ACK. The
debug and optimized matrices pass all nine storage/authentication pairs, with
fourteen additional optimized/reference Redis and closing-handshake process
runs. Current supported artifacts and full replacement acceptance remain separate.
