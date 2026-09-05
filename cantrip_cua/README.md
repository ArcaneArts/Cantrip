# Cantrip CUA runtime

Worker-owned Rust computer-use library and executable. The portable
process/session/image/cursor core and build-chain integration use an explicit
deterministic test backend. A lazy worker service owns the actual process and
private protocol. Encrypted server routing, existing durable permission requests,
and the experimental shared client preview are implemented. The native macOS
backend uses ScreenCaptureKit; managed JavaScript and Trajectory remain subsequent
cycles in [the CUA plan](../docs/planned/CUA.md). Ordinary Cantrip worker startup
does not launch the helper. Development preparation builds, installs, and smoke
tests the helper without capturing a real desktop or requesting capture permission.

## Build and verify

```sh
pnpm cua:build
pnpm cua:build:release
pnpm cua:test
pnpm cua:test:worker
pnpm cua:check
pnpm cua:smoke
```

The commands use the locked standalone Cargo manifest. `cua:build` reports the
**actual executable emitted by Cargo**, including custom `.cargo/config.toml`,
`CARGO_TARGET_DIR`, and `CARGO_BUILD_TARGET` settings. `--target <triple>` and
`--target-dir <directory>` are also accepted. Direct equivalents:

```sh
cargo build --locked --manifest-path cantrip_cua/Cargo.toml
cargo build --locked --release --manifest-path cantrip_cua/Cargo.toml
cargo test --locked --manifest-path cantrip_cua/Cargo.toml
cargo fmt --manifest-path cantrip_cua/Cargo.toml -- --check
cargo clippy --locked --manifest-path cantrip_cua/Cargo.toml --all-targets -- -D warnings
```

The `process` integration tests launch the actual executable, send framed
requests, decode its PNG output, verify a configured crosshair at its logical
hotspot, and close the session/process. No permission or desktop content is
needed. `cua:smoke` builds the helper when no binary is specified, then performs
the real framed handshake, both fake target captures, every cursor style, PNG
dimensions/digest checks, deterministic repeat capture, detach, and shutdown.
To test an exact copied or signed executable without rebuilding it:

```sh
pnpm cua:smoke --binary /absolute/path/to/cantrip-cua
node scripts/verify-packaged-worker-cua.mjs /absolute/path/to/worker
```

No screenshot pixels or native target details are printed. Fake image metadata
and digests are public deterministic test results. Ordinary build/test/package
commands continue to use explicit fake capture; native capture is opt-in below.

### Native macOS snapshots

On macOS 14+, the default executable uses the actual
[ScreenCaptureKit screenshot API](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager).
Other platforms, or a macOS runtime without that API, report unavailable. The
framework is weak-linked; this does not change the application's minimum OS.
Checking capability does not enumerate windows or request Screen Recording.
The CLI initializes CoreGraphics on its original main thread before servicing
ScreenCaptureKit callbacks. This is native runtime setup, not a permission or
display-availability gate; its returned display identifier is not used to
approve, reject or redirect a capture.
The first authorized inventory/capture call attempts the real native operation.
Denial returns `permission-denied`; there is no permission preflight, alternate
identity, automatic replay, fake fallback, or selected-window-to-monitor fallback.

Window capture uses a desktop-independent `SCContentFilter`, including ordinary
windows covered by others. The system pointer, audio and window shadows are
excluded; only the logical CUA cursor is composed into PNG pixels. Application
names, titles, identifiers and pixels remain protected by the existing encrypted
route. No Accessibility or system-input permission is requested in this tranche.

- Logical bounds retain native global origins and target-local dimensions.
  Negative monitor origins do not alter local cursor coordinates.
- Retina scale informs output resolution. Large captures are reduced to at most
  4,000,000 pixels and 16,384 pixels on either axis, preserving aspect ratio to
  integer-pixel rounding. This leaves room for PNG overhead within the 16 MiB
  payload budget. `pixelWidth`/`pixelHeight` describe configured output pixels;
  `scaleFactor` is output width / logical width. Rendering derives X/Y ratios
  independently, so downscaling and rounding do not move the cursor.
- Inventory reads native frames without constructing capture filters for
  unrelated windows. Its raster is a bounded nominal 1x descriptor, not a claim
  about physical Retina density; the selected snapshot refreshes actual filter
  geometry, scale and output dimensions. Cancellation stops inventory traversal
  between native entries.
- Inventory is limited to 256 entries and a 60 KiB serialized target budget.
  `truncated: true` identifies omitted/invalid native entries or a size limit
  and is disclosed by the preview; selected-target capture does
  not depend on remaining inside that public list. Native generation tracking
  is bounded to 4,096 live identities.
- Geometry, title and scale changes preserve a target generation. Observed
  disappearance or owner change retires it; an explicit refresh/reselection
  is required after a closed/stale target. macOS native IDs are not permanent
  identities: same-owner ID reuse entirely between observations cannot always
  be distinguished. No absolute unseen-replacement guarantee is claimed.
- Focused/minimized metadata remains unknown rather than treating on-screen,
  active, hidden and minimized as equivalent states. Locked/protected desktops,
  minimized windows and other Spaces retain macOS's actual capture behavior;
  this implementation does not bypass OS protections.
- Native callbacks retain their own bounded lifetimes; cancellation prevents
  late results from publishing. The native wait is bounded to 10 seconds with
  at most 16 unresolved completions. Normal startup has no capture loop or
  permission prompt; the helper uses a serviced original-main run loop only after
  authorized launch.

For a bounded native diagnostic run, `CANTRIP_CUA_NATIVE_DIAGNOSTICS=1` emits at
most 256 structured stderr events per helper process: static operation phases,
inventory counts, our validation reasons, and native error domain/code/key names.
It does not print error descriptions, arbitrary native error values, target
titles or pixels. Ordinary execution leaves this instrumentation off. A locked
desktop can return no displays or a native capture error; the operation's actual
result remains authoritative, without an extra lock-state gate.

Build/install the deliberate stable helper first using the existing
[development identity instructions](#stable-development-helper), then inspect
its exact installed path with `pnpm cua:profile`. Use that path, not a transient
Cargo output, for native permission verification:

```sh
pnpm cua:smoke:native --binary /absolute/stable/cantrip-cua --fixture
pnpm cua:smoke:native --binary /absolute/stable/cantrip-cua --fixture --output /absolute/new-fixture.png
```

Fixture mode briefly opens its own patterned window and covering window. It
checks foreground, partially/fully covered, moved, resized, closed and recreated
windows; decoded corner colors verify orientation and channel order. It exercises
all cursor styles without moving the human pointer. Fixture windows close on
exit. Logs contain bounded scenario/dimension/timing results, not window titles
or screenshot pixels. If macOS asks, grant or deny through the normal OS UI;
denied capture is not retried automatically. Record prompts separately—equal
signatures or successful capture alone do not prove permission continuity.

Omitting `--fixture` deliberately selects the first real monitor; `--target ID`
selects an exact current inventory target. No image file is saved unless
`--output` is specified. Saved files are created exclusively with mode `0600`;
existing files are never overwritten. Native smoke never builds, installs,
signs, resets permission, or switches identity on the user's behalf.

The actual observed platform/fixture results and outstanding manual checks are
recorded in [the cycle-7 progress ledger](../docs/planned/CUA.md#tranche-cycle-7--macos-target-inventory-and-native-snapshots).

### Worker ownership and lifecycle

`cantrip_worker/src/computer-use/service.ts` is the only worker process owner.
Construction, status inspection, idle disconnect, and shutdown perform no CUA
launch, filesystem lookup, or native permission request. First authorized use
launches one helper and performs its actual capability handshake. The worker
uses `CANTRIP_CUA_BIN` verbatim when supplied, otherwise its own module-relative
`bin/cantrip-cua` (`.exe` on Windows). An explicit broken override fails; it never
selects a different installation based on cached metadata or existence checks.
Browser/direct-worker development and `devtop` project the stable named profile
path into this override before starting the worker.

The service retains immutable server/account/worker/chat/task/thread/turn
ownership and generates session IDs. A shared target can be observed repeatedly
without resetting the cursor. Requests include target ID and generation, and
responses are validated against the original binding. Snapshot bytes remain
binary and are checked against bounded PNG metadata and SHA-256; neither target
details nor pixels are written to logs or retained as a second audit store.

Each session serializes its operations. Cancellation of a queued request settles
without sending it; cancellation after sending reports an unknown outcome and
invalidates that session, rather than replaying a possibly completed mutation.
Interrupt, thread relocation, terminal server disconnect, and worker shutdown
revoke matching scopes immediately. Stop is local and does not wait for a child
response. Transport cancellation acknowledgments and process shutdown are
bounded; pending work never retries itself.
Transport admission counts cancelled requests awaiting acknowledgment and
reserves cleanup slots, so a saturated request queue cannot crowd out Stop.

Preview cleanup releases an exact server/account/worker/chat/task/thread/turn
scope and its approval signal. A preview's null task/thread/turn values never
match a live agent's scope as wildcards. Explicit Stop, trusted placement or
policy revocation, and chat interruption still cancel chat-wide CUA work.

The Codex runtime exposes a read-only resolver for genuine root/child native
turn identities and cancellation signals. Only actual turn starts establish
that lifetime; telemetry and caller-supplied identities cannot create one.
Completion, interruption, replacement and shutdown end the signal before
asynchronous cleanup. This is a prerequisite for managed MCP, not an enabled
agent tool. The future MCP coordinator must register every execution lifetime,
including YOLO use, and revoke it on Stop/policy changes even without a preview.

One unexpected helper crash permits one new launch on a **fresh explicit
request**. Old session IDs remain invalid. A second crash, a launch failure, or
an incompatible protocol is terminal until the worker is restarted. Ordinary
native errors such as denied capture permission do not count as crashes.

`pnpm cua:test:worker` builds the actual Rust artifact and passes that exact path
to worker tests. It covers the real worker-service/process boundary, both fake
targets, all cursor styles, binary observations, ownership, cancellation,
disconnect, and crash restart. Generic worker unit runs skip these explicit
artifact tests; the dedicated CUA command and portable CI run them without a
native desktop. The same command now exercises the real app client codec,
Fastify routes, worker permissions/coordinator and Rust fake backend. It is not
yet MCP end-to-end or native capture QA.

### Experimental client preview

Open any project or standalone agent chat and choose **Computer use ·
Experimental** above the transcript. Desktop, browser and responsive mobile
clients use the same encrypted app → server → agent-worker route. Opening the
panel does not launch the helper; **Connect to agent worker** performs its real
capability request. The default backend uses ScreenCaptureKit on supported
macOS versions; fake pixels are used only by explicitly configured tests.

Choose a monitor/window, request **Snapshot**, or click its displayed image to
move the logical cursor. The four direction buttons provide a keyboard-accessible
alternative. This never moves the system pointer or sends an OS click/key.
Cursor controls support arrow/dot/ring/crosshair, RGB/RGBA color, size 8–96,
optional bounded label, trail and visibility. **Apply cursor** updates the worker
state and requests fresh pixels immediately. Images are snapshots, not video;
they already contain the cursor, so the client never overlays a second cursor.

Preview observers of one chat share a target and cursor. Closing the panel
disposes local requests, image buffers and object URLs without stopping another
observer. **Detach target** changes the shared target; **Stop computer use**
revokes the entire preview lease out of band, even during a pending request or
after encryption locks. If Stop cannot reach the worker, its exact lease remains
available for an explicit retry. Reconnect is explicit and gets a new lease.

Selected YOLO adds no new prompt. Otherwise **Review approval in chat** closes
the preview and refreshes the existing durable interaction panel. Approve or deny
there, reopen, and explicitly retry the intended action. Approval never replays
an action. A changed account/server cancels the observer; encryption lock clears
its displayed pixels while preserving Stop. Protected operations are bounded to
35 seconds, independently from the 30-second Stop deadline. No polling or replay
loop is added.

Focused client and full protected fake-boundary checks:

```sh
pnpm --filter @cantrip/app exec vitest run src/components/computer-use src/lib/computer-use-client.test.ts src/lib/api-client.test.ts
pnpm cua:test:worker
```

The server test fixture uses fresh synthetic keys and an in-memory repository;
it does not access encryption profiles, Keychain or production accounts. Ordinary
tests use fake capture; a deliberate native QA opt-in can exercise the same route
with an explicitly selected installed helper. Shared client tests plus browser QA are not a claim that a
packaged Tauri/iOS/Android build has been manually verified.

### Stable development helper

`pnpm dev`, `pnpm dev:postgres`, and `pnpm devtop` preparation runs
`pnpm cua:install:dev`. This builds, stages, optionally signs, smoke tests, and
atomically replaces the development executable. Normal worker startup still
does not launch CUA. To install or inspect separately:

```sh
pnpm cua:install:dev
pnpm cua:profile
```

The location is native user application data under
`art.cantrip.cua/development/<profile>/cantrip-cua[.exe]`. On macOS, the default
is `~/Library/Application Support/art.cantrip.cua/development/default/`.
`CANTRIP_DEV_PROFILE` selects the existing named development profile; `devtop
--profile <name>` passes that selection to its preparation and worker children.
The helper location does not depend on repository, worktree, branch, Cargo
output, Tauri target, or WebView origin. A separate test profile uses a separate
directory, without changing Cantrip account keys or installation catalogs.

For stable macOS code-signing identity, explicitly select an available
certificate once at installation time:

```sh
CANTRIP_CUA_SIGNING_IDENTITY='Apple Development: Your Name (TEAMID)' pnpm cua:install:dev
```

The non-secret signing choice is retained in `installation.json`; subsequent
builds without the environment variable reuse it instead of silently downgrading
to unsigned. The development signing identifier is `art.cantrip.cua.dev`.
Unsigned builds are allowed for fake-backend development but do **not** establish
stable Screen Recording approval across rebuilds. Ad-hoc signing is not offered
as a substitute for a stable certificate. Signing may use macOS signing tooling
at build time; CUA runtime startup never accesses Keychain.

Concurrent installers use `--installation-lock <file>`, a build-only mode of the
fresh executable that holds a kernel file lock until its stdin closes. Another
installer fails precisely while that lock is held; process exit automatically
releases it. The small `.installation.lock` file is not a stale-lock indicator
and must not be removed while an installer runs. A failed signing/smoke step
leaves the previous installed executable intact. A crash after installation
configuration commits but before executable replacement is safe to rerun.
Unexpected lock-holder exit cancels the active smoke and prevents subsequent
installation commit steps; it is never reported as a successful installation.

To reset only this helper deliberately, stop development processes, inspect the
exact directory with `cua:profile`, and move that named helper directory to a
backup. Reinstall with the desired certificate. Do not remove the entire Cantrip
application-data directory or encryption profile. Moving/resetting the helper or
changing its certificate can require new native authorization. Signing identity
and successful fake smoke alone do not prove TCC permission continuity; actual
native tests remain required after the macOS capture adapter lands.

### Distribution and CI

Worker/services packaging builds CUA once and bundles it in `worker/bin`.
Server-only packaging does not build CUA. Desktop runtime packaging inherits the
worker binary; `--from-artifacts` executes the extracted helper rather than
building or substituting a local one. Both paths execute the final-layout fake
smoke. Root build/test/check commands include the Rust crate and script tests.

The desktop macOS runtime signer explicitly uses `art.cantrip.cua`, hardened
runtime, and the distribution's existing certificate. It does not grant CUA JIT
entitlements. Final `.app` verification checks the helper's signature/identifier
and executes its real protocol. Its normal installed location is
`Cantrip.app/Contents/Resources/runtime/worker/bin/cantrip-cua`; moving/translocating
the outer app can change the absolute path. The standalone worker artifact is
not yet certificate-signed by its release job; do not treat desktop signing
coverage as standalone-worker signing coverage.

The CUA native CI matrix runs actual fake-backend tests on macOS, Windows, and
Linux. Windows/Linux native capture remains unavailable. Fake CI intentionally
does not request Screen Recording or claim permission/capture verification.

Default execution advertises an unavailable native backend and returns a real
`unsupported` result for capture. `--backend fake` explicitly selects two fixture
targets; it is never an automatic fallback. `--version` is a standalone CLI
diagnostic, not the worker's capability handshake.

## Wire contract: version 1

The executable listens only on stdin and writes framed responses/events on
stdout. The worker is the future authorization boundary. It alone may authorize
and bind real tasks to this private child process; the Rust core does not
authenticate accounts or independently decide approval policy.

Each frame is:

```text
u32 big-endian JSON-header byte count
u32 big-endian binary-payload byte count
UTF-8 JSON header
raw encoded image bytes (when present)
```

Headers are bounded to 64 KiB; binary payloads to 16 MiB. Headers, versions,
message shapes, and payload eligibility are checked before payload allocation.
Only successful responses may have binary payloads. Requests carry no binary
data in this tranche. Zero-byte EOF before a frame is clean; a partial prefix,
header, or payload closes the invalid stream.

Header shape:

```json
{
  "version": 1,
  "message": {
    "kind": "request",
    "requestId": 1,
    "operation": { "operation": "capabilities.get" }
  }
}
```

`requestId` is a positive exact JavaScript integer, strictly increasing for new
requests on a connection. A `cancel` message's `requestId` references an existing
request; unknown or completed cancellations do nothing and do not poison a
future request. The other message kinds are `response` and `event`.

A response has `result: { status: "ok", data: ... }` or
`result: { status: "error", error: { code, message } }`. An event contains a
monotonic `sequence`, optional `sessionId`, and bounded event metadata. Events do
not duplicate images. JSON, pixels, target titles, and incoming identifiers are
never written to stderr; fatal process diagnostics contain only a fixed reason.

Keep stdin open while awaiting responses. EOF means the worker disconnected:
it cancels outstanding/queued work and shuts down, rather than committing a
batch after its owner vanished.

### Implemented operations

| Operation              | Fields beyond `operation`                                       |
| ---------------------- | --------------------------------------------------------------- |
| `capabilities.get`     | None                                                            |
| `targets.list`         | None                                                            |
| `target.attach`        | `binding`, `targetId`, `targetGeneration`                       |
| `target.detach`        | `binding`                                                       |
| `observation.snapshot` | `binding`, `targetId`, `targetGeneration`                       |
| `cursor.configure`     | `binding`, `targetId`, `targetGeneration`, `appearance`         |
| `cursor.move`          | `binding`, `targetId`, `targetGeneration`, `position: { x, y }` |
| `session.close`        | `binding`                                                       |

The binding contains `sessionId`, `workerId`, `chatId`, and optional `taskId`,
`threadId`, `turnId`. Existing session bindings must match exactly; a failed
lookup does not silently replace a session. The first successful `target.attach`
creates the session. A second observer attaching to the same target preserves
its shared cursor. A target switch retains appearance but resets geometry.

Target-bound operations specify **both ID and native generation**: different
windows may have the same generation. Snapshot verifies the target returned by
the actual capture, not a separate cached readiness guess. The backend returns
current geometry with its pixels; the core rejects target substitution. There
is no monitor fallback on window failure.

Snapshot data contains session/target/cursor state and image media type,
dimensions, encoded byte count, SHA-256, and `cursorIncluded: true`. PNG bytes
follow the header directly. Consumers must not render the baked-in cursor twice.
Later client/server integration must protect sensitive metadata and pixels
using Cantrip's existing endpoint encryption; private stdio is not itself that
network encryption layer.

## Bounds and cancellation

- One executor owns mutable sessions; an independent reader handles cancellation.
- At most 16 sessions, 256 inventory targets, and 32 pending requests.
- At most four queued outgoing frames, each with the bounded payload limit.
- The executor may wait up to two seconds for output capacity; the reader never
  blocks on that queue. Output overload closes the connection instead of growing
  memory without limit. Lost output cancels active native work immediately.
- EOF cancels current and queued work. Final output draining is bounded; the
  executable exits rather than keeping blocked I/O threads alive indefinitely.
- Accepted mutations check cancellation immediately before commit. Cancellation
  after commit does not relabel a successful mutation as uncommitted.
- Capture checks cancellation across backend, raster, composition, and encoding
  stages. Rendering/encoding process a bounded four-million-pixel image; no
  claim is made that an arbitrary native call can be interrupted by Rust alone.
- Image buffers use checked dimensions and an encoded-output bound. Native
  logical target dimensions may be larger than the bounded returned snapshot;
  macOS output pixel metadata describes the configured bounded capture.

Malformed framing is terminal because guessing resynchronization could attach
bytes to the wrong request. An invalid operation produces a bounded error while
leaving a correctly framed connection usable. No retries, network listeners,
input injection, speculative permission preflights, or automatic task
authorization are implemented here.

## Cursor contract: appearance version 1

```json
{
  "version": 1,
  "style": "crosshair",
  "color": "#20BFA9FF",
  "size": 24,
  "label": "Agent",
  "trail": true,
  "visible": true
}
```

- Styles: arrow, dot, ring, crosshair.
- Color: `#RRGGBB` or `#RRGGBBAA`.
- Size: 8–96 target-local logical units.
- Optional label: at most 64 Unicode scalar values and 256 UTF-8 bytes; no
  control characters. No HTML, SVG, external URL, or custom image is interpreted.
- Trail: at most 24 previous points; disabling it clears the trail.
- Arrow hotspot: upper-left tip. Other styles: center.
- Position is target-local, finite, and inside the attached target. Negative
  global monitor origins do not shift it. X/Y pixel scale is derived separately.
- Appearance and movement update cursor revision/timestamp without touching the
  OS pointer. Resize removes invalid trail geometry before rendering.

The first renderer uses a deterministic embedded bitmap font, supporting its
Latin, Greek, Hiragana, and symbol tables. Unsupported glyphs use a visible
replacement box; full shaping, emoji, combining marks, and bidi layout remain
explicit typography limitations, not claims of full Unicode rendering.

The generic core builds on non-macOS targets. Cross-checking a Windows target
is not evidence of running Windows native capture or a Windows executable;
that backend remains unavailable.
