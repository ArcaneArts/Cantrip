# Cantrip CUA runtime

Worker-owned Rust computer-use library and executable. The portable
process/session/image/cursor core and build-chain integration use an explicit
deterministic test backend. A lazy worker service owns the actual process and
private protocol. Encrypted server routing, existing durable permission requests,
and the experimental shared client preview are implemented. The native macOS
backend uses ScreenCaptureKit. The managed `cantrip_cua` MCP connects bounded
JavaScript to that same service through the authenticated worker broker. Native
acceptance and protected operation Trajectory verification are tracked in
[the CUA plan](../docs/planned/CUA.md). Ordinary Cantrip worker startup
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

To additionally exercise native fixture pixels through the real app client
codec, protected server route and worker service, run the explicit integration
test after building workspace test dependencies:

```sh
pnpm cua:test:worker
CANTRIP_CUA_NATIVE_TEST_BINARY="/absolute/stable/cantrip-cua" pnpm --filter @cantrip/server exec vitest run test/computer-use-native-preview.test.ts
```

The native test skips unless that separate opt-in variable is set. It uses
synthetic account keys and only selects its own fixture window; normal test
runs continue to use fake capture. Its route fixture does not prove that a
packaged Tauri app or a real account has completed manual acceptance.

The fixture waits for its own WindowServer geometry and window destruction
before acknowledging resize/close commands. Native capture assertions still
require exact geometry, decoded fixture colors and rejection of the retired
target; no monitor fallback or capture retry is used.

The actual observed platform/fixture results and outstanding manual checks are
recorded in the [first-tranche progress ledger](../docs/planned/CUA.md#first-tranche-implementation-progress).

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
asynchronous cleanup. The managed MCP coordinator registers the running command
before a tool call and resolves each root/child turn from that runtime. Stop and
trusted placement/policy revocation apply independently from preview ownership
and pending approvals, including YOLO execution.

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
Fastify routes, worker permissions/coordinator and Rust fake backend, plus the
managed MCP broker/stdio boundary. These deterministic tests do not establish
native capture or installed-app acceptance; consult the progress ledger for
actual results and outstanding checks.

### Experimental client preview

Open any project or standalone agent chat and choose **Computer use ·
Experimental** above the transcript. Desktop, browser and responsive mobile
clients use the same encrypted app → server → agent-worker route. Opening the
panel does not launch the helper; **Connect to agent worker** in **Manual preview**
performs its real capability request. The default backend uses ScreenCaptureKit on supported
macOS versions; fake pixels are used only by explicitly configured tests.

Choose a monitor/window, request **Snapshot**, or click its displayed image to
move the logical cursor. The four direction buttons provide a keyboard-accessible
alternative. This never moves the system pointer or sends an OS click/key.
Cursor controls support arrow/dot/ring/crosshair, RGB/RGBA color, size 8–96,
optional bounded label, trail and visibility. **Apply cursor** updates the worker
state and requests fresh pixels immediately. Images are snapshots, not video;
they already contain the cursor, so the client never overlays a second cursor.

Manual preview observers of one chat share a target and cursor. Closing the panel
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

Choose **Follow agent** to see an agent's latest completed CUA observation.
Connect, select a source, and use **Refresh observation** to read its exact model
image through the encrypted worker route. The panel shows the real root/child
thread, turn, session and target, with model rendition dimensions separate from
native capture dimensions. This does not take a new screenshot or apply a second
cursor overlay. Manual target and cursor actions stay in **Manual preview**.

The worker retains at most four latest agent images, with at most four concurrent
decoded readers. A new evaluation, reset, failure, cancellation or ended execution
retires the source and cancels in-flight image delivery. Use **Refresh agent sources**
and select the new completed source after the agent takes its next snapshot.
This is a manually refreshed view, not a live stream. Closing an observer or
switching modes preserves the agent; **Stop computer use** stops the chat's CUA
lifetimes. Reading an already-authorized protected agent result adds no capture
approval; the agent's original native operations still use the effective policy.

Focused client and full protected fake-boundary checks:

```sh
pnpm --filter @cantrip/app exec vitest run src/components/computer-use src/lib/computer-use-client.test.ts src/lib/api-client.test.ts
pnpm cua:test:worker
```

### Protected operation history

Computer-use actions appear in the existing Trajectory experience. Agent MCP
records retain the actual root/child execution scope. User preview records are
grouped by their own session, or operation when no session exists, and identify
the actor as **Preview operator**. They do not belong to the preceding agent turn.

Details include the operation and outcome, elapsed time, worker/chat/task and
session attribution, target ID/generation, cursor state, bounded native error
code, and observation dimensions/digest where available. These records use the
existing encrypted chat/task messages. They contain no screenshot copy, script
source or native inventory. Model images still arrive through the MCP image
channel; the preview reads the same completed image separately.

Stop revokes the native session and pending work before publishing its history.
If a chat was archived or its protected history is unavailable, Stop still
releases resources; that final history write may be unavailable. Normal operation
publication failures are reported as protected-activity delivery failures, not
silently treated as a successful history write. See the progress ledger for the
exact integration and manual verification performed.

The server test fixture uses fresh synthetic keys and an in-memory repository;
it does not access encryption profiles, Keychain or production accounts. Ordinary
tests use fake capture; a deliberate native QA opt-in can exercise the same route
with an explicitly selected installed helper. Shared client tests plus browser
QA are not a claim that a packaged Tauri/iOS/Android build has been manually
verified.

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
the outer app can change the absolute path.

The standalone Darwin worker release job imports the same Developer ID
certificate and signs its final `bin/cantrip-cua` before verification and
archival. The importer preserves existing keychains and removes only the
successfully created temporary signing keychain on failure or job cleanup.
The CUA verifier checks the actual code signature, `art.cantrip.cua` identifier,
Developer ID authority and hardened runtime, then launches that exact executable
and exercises the final worker's Sharp image encoder. To reproduce the signing
and verification portion after `pnpm package:worker --target darwin-arm64`:

```sh
node scripts/sign-macos-runtime.mjs --binary artifacts/cantrip-worker-darwin-arm64/bin/cantrip-cua --identity 'Developer ID Application: Your Company (TEAMID)'
node scripts/verify-packaged-worker-cua.mjs artifacts/cantrip-worker-darwin-arm64 --require-developer-id
```

This helper signature does not establish standalone-worker notarization, native
capture authorization, or a signature on unrelated worker binaries. Desktop
packaging retains its existing nested-runtime and enclosing-app signing path.
See the progress ledger for actual artifact and permission evidence.

The CUA native CI matrix runs actual fake-backend tests on macOS, Windows, and
Linux. Windows/Linux native capture remains unavailable. Fake CI intentionally
does not request Screen Recording or claim permission/capture verification.

On platforms without the macOS backend, default execution advertises unavailable
native capture and returns a real `unsupported` result. `--backend fake` explicitly selects two fixture
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
future request. The other message kinds are `response`, `event`, `hostCall` and
`hostResult`. The last two are JavaScript-to-worker rendezvous messages carrying
an `evaluationRequestId`, per-evaluation `callId`, and respectively `action` or
`result`. Both are payload-free. They neither create execution authority nor
consume ordinary native request IDs. Old helpers remain usable for existing
native operations; JavaScript requires its actual advertised capability.

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
| `javascript.evaluate`  | `binding`, `source`                                             |
| `javascript.reset`     | `binding`                                                       |

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

### Managed MCP and bounded JavaScript

Start Cantrip with `pnpm devtop`, open an encrypted project or standalone chat,
and start an agent turn on its worker. Cantrip supplies the managed MCP server
`cantrip_cua` to ordinary chat and direct-task agent execution. Do not add a
user MCP entry or launch a separate sidecar. Other task-processing operations
and unencrypted execution do not receive this managed capability.

The tools are `js` (arguments: `{ "script": "..." }`) and `js_reset`
(arguments: `{}`). First inspect the worker's actual inventory:

```json
{ "script": "await cua.targets()" }
```

Then pass an exact returned target's ID and generation to `cua.attach`, using
the API below, and call `cua.snapshot()`. The result contains an actual MCP PNG
image block, plus text describing the JavaScript value, native target/cursor
metadata and model image dimensions. An inaccessible or unsupported native
operation returns its actual failure; there is no monitor substitution or
foreground activation to make a window snapshot succeed.

The host reads native Codex `threadId` and
`x-codex-turn-metadata.turn_id` from MCP request metadata. These values select an
already-running root or child turn that the worker independently verifies;
tool arguments cannot choose an account, worker, chat, thread or session.
Missing/stale metadata and disabled or revoked broker bindings are rejected.
The native helper is launched lazily only when an authorized operation needs it.

When the selected effective policy requires approval, review the ordinary
approval in the chat. Approval continues the original suspended host operation;
denial, expiry, Stop and cancellation settle that call without replay. Selected
YOLO adds no CUA confirmation. Stop is available independently of a pending
approval or running evaluation. A tool cancellation, MCP host close, interrupted
turn or worker disconnect propagates to pending worker/native work.

The Rust process owns a dedicated QuickJS thread using pinned `rquickjs 0.12.2`
with only standard runtime support, no module loader or ambient I/O. Native
capture keeps its existing executor and macOS main-thread ownership. An awaited
host operation returns to the worker for authorization, then uses the existing
native service and binary transport. JavaScript never holds the native session
queue while waiting for that call or its permission decision.

The frozen API is intentionally limited:

```js
const inventory = await cua.targets();
await cua.attach({
  targetId: inventory.targets[0].id,
  targetGeneration: inventory.targets[0].generation,
});
await cua.configureCursor({
  version: 1,
  style: "ring",
  color: "#20BFA9FF",
  size: 24,
  label: "Agent",
  trail: true,
  visible: true,
});
await cua.moveCursor({ x: 20, y: 30 });
await cua.snapshot();
```

`cua.getState()` returns the current session or null; `cua.cursor()` reads its
logical cursor and `cua.detach()` releases its selected target. Variables declared
with `let`/`const` persist within that one execution context, including top-level
`await`. A successful evaluation returns `{ value }`; undefined becomes null.
Snapshots are collected separately as validated worker-owned PNGs. JavaScript
receives only image metadata and an evaluation-local image index; returning a
forged image object does not create an image result.

The bounds are four JavaScript contexts, one active evaluation per context,
8 MiB heap and 256 KiB stack per context, 32 KiB UTF-8 source, 32 KiB serialized
JavaScript value, 64 host calls per evaluation and one outstanding host call per
context, plus 10,000 cumulative promise jobs. Active JavaScript execution has a
cumulative two-second budget. Managed calls have a 345-second wall deadline
including host/approval waits; individual approvals expire after five minutes.
The CUA broker deadline is 360 seconds and Codex's CUA tool deadline is 370
seconds. The worker-internal default remains 45 seconds. These limits bound the
whole call, so multiple approvals do not each extend its wall deadline.

Native image allocations are bounded separately from the JavaScript heap: at
most two snapshots and 16 MiB aggregate native PNG bytes per evaluation. The
model adapter validates PNGs and preserves images of at most 2.5 MiB unchanged.
Only larger images are resized once, preserving aspect ratio without cropping
or enlargement, to at most 600,000 pixels and encoded as full-color PNG. Output
must fit 2.5 MiB per image and 5 MiB total or the call fails. The broker and host
validate image count, PNG content type and strict bounded base64; the host also
checks the actual serialized JSON-RPC response including its ID and newline
against 8 MiB. Other Cantrip MCP tools retain their 512 KiB response limit and
55-second local deadline.

Model rendition dimensions do not overwrite the original native snapshot
metadata. Convert a model-image point into target-local logical coordinates as
`x * native.session.target.bounds.width / model.width` and
`y * native.session.target.bounds.height / model.height`; do not add the desktop
origin. The cursor is already baked into snapshot pixels and must not be drawn
again. Logical movement does not move the human pointer or inject native input.

The worker binds contexts to the exact execution scope and real turn signal.
It retains at most 16 live lifetime registrations independently from the four
engines, so Stop after reset/error still revokes that original lifetime. Reset
never starts a helper; it discards the engine and native attachment, while an
uninterrupted authorized turn may explicitly evaluate again. Script failure or
per-call cancellation also disposes that context without replaying it. Stop,
permission revocation, turn interruption and disconnect revoke authority; reset
cannot undo them. Late host replies cannot resurrect a disposed context. Failed
evaluations clear their captured image buffers before releasing them.
An engine being reset continues to consume capacity until its actual reset
acknowledgment arrives. Idle engines block on their command channel; a host wait
sleeps until a reply, cancellation or its real deadline, not a polling interval.

No process, environment, filesystem, network, native loader, timers, worker
threads, real clicks or keyboard API is exposed. Unawaited pending host actions
cannot continue after a successful tool response. Ordinary startup, idle Stop,
and reset do not initialize an engine or launch the helper.

State is isolated to the exact authorized native turn. `js_reset` clears its
variables and attachment; it never restores authority after Stop. A subsequent
turn starts with fresh state. Current placement and effective policy are read
before every host action and again after approval. The model receives its PNG
blocks unchanged by secondary raw Trajectory capture, which omits nested image
and binary data. Per-operation metadata is recorded through the protected
Trajectory path described above. Native/packaged product acceptance remains a
separate verification requirement; the progress ledger records that evidence.

## Bounds and cancellation

- One executor owns mutable sessions; an independent reader handles cancellation.
- At most 16 native sessions, 256 inventory targets, and 36 pending requests.
  The worker admits 16 ordinary requests and reserves 20 slots for the 16 native
  session closes and four JavaScript resets, including cancellation correlations.
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
