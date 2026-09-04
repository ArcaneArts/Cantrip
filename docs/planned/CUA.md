# Cantrip Computer Use

Status: Planned

This document proposes a first-party computer-use subsystem named
`cantrip_cua`. It is a future implementation plan, not a description of
currently available product behavior.

The intended user experience is:

1. Start an agent on a macOS worker.
2. Give that agent a task that requires seeing or operating applications on
   the same worker.
3. Let the agent select a monitor, application, or individual window and
   inspect it even when that window is behind another window.
4. Let the agent use its own visible logical cursor, accessibility actions,
   pointer and keyboard input, clipboard operations, application controls,
   and structured Finder/file operations.
5. Continue using the computer while the agent works. The agent observes
   relevant human input events and adapts instead of automatically pausing.
6. Watch the session from Cantrip on desktop, web, iPhone, or Android, with
   trajectory history showing what the agent saw and did.

Computer use runs only on the worker hosting the agent. A client may prompt,
observe, approve, or stop that agent from another device, but the agent does
not control the client device. Worker-to-worker desktop control is a possible
future capability and is not part of the first release.

The first release targets macOS only. Windows and Linux are future backends.

## Goals

- Add a top-level first-party Rust package named `cantrip_cua`.
- Make the worker that runs an agent the sole machine on which that agent may
  execute computer-use operations.
- Capture a selected monitor or individual application window without
  requiring the window to be unobscured or foregrounded when macOS APIs allow
  direct window capture.
- Give the agent a distinct logical cursor that is visible in observations
  and monitoring UI without treating the human pointer as the agent's durable
  state.
- Let agents and humans collaborate without automatically pausing the agent on
  every human input event.
- Report human pointer, keyboard, focus, window, and scene-change events to the
  agent when they are relevant to its active target.
- Integrate authorization with Cantrip's existing effective permission
  profile and durable agent-interaction system. Selected YOLO mode must not
  add a separate computer-use confirmation.
- Expose a provider-neutral managed MCP interface, including a persistent
  JavaScript execution surface optimized for models that can efficiently
  compose computer actions.
- Record computer-use actions, including ordinary typed text, in the existing
  protected Trajectory path with appropriate secret-field redaction.
- Allow desktop, web, iPhone, and Android Cantrip clients to observe the
  worker-local session.
- Ship `cantrip-cua` with the worker distribution in the same general manner as
  the bundled Codex and Cantrip CLI runtimes.
- Keep normal worker startup fast by loading the computer-use runtime lazily.
- Produce real native errors when capture or input fails rather than blocking
  valid operations with cached or secondary preflight guesses.

## Non-goals for the first release

- Controlling the desktop, browser, iPhone, or Android device running a
  Cantrip client.
- Letting an agent running on one worker control a different worker.
- Reusing the current Remote Desktop adapter, session model, capture pipeline,
  or persisted Remote Desktop tab as the computer-use runtime.
- Windows, Linux, X11, Wayland, iOS UI automation, or Android UI automation.
- Headless display creation or virtual-machine orchestration.
- Bypassing macOS login-window, lock-screen, privacy, sandbox, or other
  operating-system security boundaries.
- A permanent application blocklist maintained separately from Cantrip's
  permission system.
- Per-click confirmations when the effective permission profile already
  authorizes the operation.
- A general-purpose JavaScript, shell, filesystem, or network sandbox exposed
  to the model.
- Retaining full screenshots or accessibility trees in a second audit
  database.

## Fixed product decisions

The following decisions are part of the initial contract.

### Worker-local execution

The agent and `cantrip-cua` execute on the same worker. The app and server do
not perform native input on the agent's behalf. The server continues to own
durable state and routing, while the worker owns native desktop observation
and side effects.

The initial implementation must reject a target that belongs to another
worker. Future worker-to-worker control requires an explicit protocol and
authorization design rather than silently widening this scope.

### macOS-first delivery

The first complete backend is macOS. It must be designed as a platform-neutral
core with an explicit backend trait, but incomplete Windows or Linux adapters
must not delay the first release or create misleading capability claims.

### First-party implementation

`cantrip_cua` is a purpose-built Cantrip package. It may use maintained crates
that expose narrow operating-system bindings, image codecs, serialization, or
an isolated JavaScript engine. It must not embed a broad computer-use product
whose unrelated tools, authorization rules, logging, or protocol become part
of Cantrip by accident.

The current `@zavora-ai/computer-use-mcp` dependency may be studied for
behavioral characterization and parity tests. It is not the target runtime.
The implementation should prefer direct macOS frameworks through focused Rust
bindings over forking the whole dependency.

### Existing permission system remains authoritative

Computer use does not invent another global permission-mode selector. The
chat's selected and effective Cantrip permission profile remains authoritative.
When the effective profile requires an approval, the request uses the existing
durable agent-interaction path. When selected YOLO mode resolves to Codex's
`never` approval policy, computer use proceeds without an extra Cantrip prompt.

The Rust process receives capability-scoped authorization from the worker. It
does not independently decide whether the user should be prompted.

### Collaborative input

Human activity does not automatically pause the agent. The system distinguishes
agent-generated events from human-generated events, publishes relevant human
activity into the computer-use session, and lets the agent respond to the new
scene.

The UI still provides explicit Stop and Disable Computer Use actions. A user
may stop a session immediately without waiting for the current model turn to
finish.

### Independent CUA observation path

Computer use is not implemented as an extension of
`ManagedDesktopRemoteSurfaceAdapter`. It has a dedicated target model, capture
session, input scheduler, observation stream, and client monitor.

The implementation may reuse low-level authenticated WorkerLink routing,
encrypted binary framing, common viewport helpers, or generic image components
where their semantics fit. It must not inherit Remote Desktop's foreground
window assumptions, human-input ownership, persisted surface lifecycle, or
capture fallback behavior.

## Architectural decision

`cantrip_cua` is a worker-owned Rust sidecar with a versioned private protocol.
The worker remains the authorization and orchestration boundary. A managed MCP
host gives Codex a provider-neutral computer-use interface, and a dedicated
CUA observation channel lets Cantrip clients monitor the same worker-local
session.

```text
Cantrip client on desktop, web, iPhone, or Android
  - prompts and approvals
  - live CUA monitor
  - user/agent cursor presentation
  - Stop / Disable Computer Use
                |
                | existing authenticated app/server/worker routing
                v
Cantrip worker running the agent
  - effective permission profile
  - durable approval bridge
  - task/turn ownership
  - CantripCuaService
  - trajectory publication
                |
                | private framed child-process protocol
                v
cantrip-cua Rust sidecar
  - native target inventory
  - window and monitor capture
  - logical agent cursor
  - human-input observation
  - accessibility snapshot/actions
  - pointer/keyboard/clipboard input
  - applications and Finder/file operations
  - bounded persistent JavaScript sessions
                |
                v
macOS frameworks
  - ScreenCaptureKit
  - Accessibility
  - CoreGraphics
  - AppKit / Foundation
```

There is no app-to-sidecar connection and no sidecar network listener. All
access is mediated by the worker hosting the agent.

## Relationship to existing Cantrip systems

Cantrip already has useful seams that should be extended selectively:

- Permission profiles live in
  [`packages/protocol/src/permission-profiles.ts`](../../packages/protocol/src/permission-profiles.ts).
- Durable command, file, permission, user-input, and MCP approval behavior is
  documented in
  [`docs/AGENT_INTERACTIONS.md`](../AGENT_INTERACTIONS.md).
- Worker-managed MCP configuration is assembled in
  [`cantrip_worker/src/mcp/managed.ts`](../../cantrip_worker/src/mcp/managed.ts).
- Protected raw tool capture is produced in
  [`cantrip_worker/src/codex/raw-capture.ts`](../../cantrip_worker/src/codex/raw-capture.ts).
- Trajectory's protected diagnostic contract is documented in
  [`docs/TRAJECTORY.md`](../TRAJECTORY.md).
- The current native input wrapper is in
  [`cantrip_worker/src/desktop/automation-client.ts`](../../cantrip_worker/src/desktop/automation-client.ts).
- The current Remote Desktop capture implementation is in
  [`cantrip_worker/src/desktop/desktop-frame-source.ts`](../../cantrip_worker/src/desktop/desktop-frame-source.ts).
- Worker packaging and the desktop's bundled worker runtime are assembled in
  [`scripts/package-distributions.mjs`](../../scripts/package-distributions.mjs).

Existing Remote Desktop behavior is a characterization source, not the CUA
architecture. CUA-specific protocol types should live in their own protocol
module rather than extending `remote-desktops.ts` with a second meaning for
the same records.

## Rust package layout

The repository currently keeps Rust packages independent rather than using a
root Cargo workspace. `cantrip_cua` should initially follow the same shape as
`cantrip_cli`.

```text
cantrip_cua/
  Cargo.toml
  Cargo.lock
  README.md
  src/
    lib.rs
    main.rs
    protocol.rs
    service.rs
    session.rs
    target.rs
    observation.rs
    capture.rs
    input.rs
    cursor.rs
    accessibility.rs
    applications.rs
    filesystem.rs
    permissions.rs
    javascript.rs
    platform/
      mod.rs
      macos.rs
  tests/
    fixtures/
    protocol.rs
    session.rs
```

Naming conventions:

- Repository directory: `cantrip_cua`
- Cargo package: `cantrip-cua`
- Library crate: `cantrip_cua`
- Executable: `cantrip-cua` on macOS and `cantrip-cua.exe` on a future Windows
  backend

The library owns native and session behavior. The executable owns process
transport, structured stderr logging, graceful shutdown, and crash containment.

## Worker service ownership

Add one `CantripCuaService` to the worker process. It is the single owner of:

- Lazy sidecar discovery and launch.
- Sidecar version and capability negotiation.
- Task, thread, turn, and worker authorization bindings.
- CUA session creation and teardown.
- Managed MCP calls.
- Client observation attachments.
- Existing permission-profile decisions and approval requests.
- Trajectory event publication.
- Sidecar crash recovery and session failure reporting.

The service starts the sidecar on the first authorized computer-use request.
It does not add native initialization to ordinary worker startup. Once started,
the sidecar remains available for the worker lifetime unless it crashes or is
explicitly disabled.

The worker may restart an unexpectedly terminated sidecar once and report the
actual failure. It must not retry indefinitely or hide a repeated crash behind
a permanent loading state.

## Private worker-to-sidecar protocol

Use a versioned, length-prefixed protocol over child-process stdin and stdout.
Do not expose a TCP listener, HTTP endpoint, Unix socket, or named pipe in the
initial implementation.

The protocol contains:

- A JSON or compact structured header validated on both sides.
- Optional binary payload bytes for screenshots and thumbnails.
- Request, response, event, and cancellation frames.
- Monotonic request and event sequence numbers.
- Explicit protocol version and capability negotiation.
- Bounded message, image, accessibility-tree, and text sizes.
- Session and target-generation identifiers on state-sensitive operations.
- Structured, redacted diagnostics on stderr only.

Do not base a decision to run an operation on a stale cached permission status
or a secondary health guess. Attempt the authorized native operation and
return its real result. Target generations are used only when the target is
known to have changed or disappeared.

Initial operations should include:

- `capabilities.get`
- `targets.list`
- `target.attach`
- `target.detach`
- `observation.snapshot`
- `observation.subscribe`
- `input.batch`
- `window.activate`
- `window.restore`
- `accessibility.snapshot`
- `accessibility.query`
- `accessibility.action`
- `application.list`
- `application.launch`
- `clipboard.read`
- `clipboard.write`
- `filesystem.open`
- `filesystem.reveal`
- `filesystem.copy`
- `filesystem.move`
- `filesystem.rename`
- `filesystem.trash`
- `javascript.evaluate`
- `javascript.reset`
- `session.close`

Action batching lets the model compose several low-latency inputs without a
separate MCP round trip for every mouse movement or keystroke. The sidecar
returns a fresh observation after a batch when requested.

## Target model and capture semantics

CUA targets are transient worker-local native objects, not durable Remote
Desktop records. A target can be:

- A monitor.
- A native window.
- An application, resolved to one or more windows.

Every target includes:

- Opaque native target ID.
- Target kind.
- Application and process identity when available.
- Window title when available.
- Logical bounds in the global desktop coordinate space.
- Pixel dimensions.
- Scale factor.
- Occlusion, minimized, hidden, and focused state when knowable.
- A target generation that changes when the native object is replaced.

Coordinates exposed to the model use target-local logical points. The Rust
backend owns conversion to native global points, pixels, scale factors, and
negative monitor origins.

### Individual-window capture

The macOS backend should use ScreenCaptureKit window capture so an attached
window remains visible to the agent when another window covers it. The
implementation must characterize and report the actual behavior for:

- Background and unfocused windows.
- Partially or fully occluded windows.
- Windows on another Space.
- Hidden applications.
- Minimized windows.
- Windows that move, resize, close, or are recreated.

Where macOS does not produce frames for a particular state, CUA reports that
state precisely. It must not silently replace a selected window with the full
monitor or focus the window merely to make capture appear successful.

The macOS login window and lock screen are protected operating-system surfaces.
CUA must not claim it can bypass those boundaries. This is distinct from
capturing a normal background or occluded application window.

### Monitor capture

Monitor mode supports every display reported by macOS, including mixed scale
factors, Retina displays, rotated displays, and negative global coordinates.
The primary display is a property, not an implicit default after the user or
agent selects another display.

## Agent cursor and human collaboration

macOS exposes one real system pointer. Cantrip therefore represents the agent
cursor as explicit CUA session state rather than pretending the operating
system provides two independent native pointers.

The agent cursor contains:

- Target-local logical coordinates.
- Cursor shape or action state when known.
- Last agent movement and action time.
- Visibility and color identity for observation rendering.
- The task and session that own it.

Snapshots returned to the model and frames shown in the CUA monitor render the
agent cursor as an overlay. Human pointer presentation remains distinct.

For an accessibility-addressable control, prefer a targeted Accessibility
action that does not require moving the human pointer or foregrounding the
window. Coordinate-based CoreGraphics input may still use the shared native
pointer and focus rules. The protocol and trajectory must identify which
method was used instead of implying that arbitrary coordinate clicks are
physically independent.

The macOS backend should mark generated CoreGraphics events with a private
source tag and observe native input with an event tap. This allows the session
to distinguish agent-generated events from human-generated events.

Relevant human events are published into the session, including:

- Pointer movement, click, drag, and scroll within the active target.
- Keyboard and modifier activity routed to the active target.
- Target focus, movement, resize, visibility, and content changes.
- Clipboard changes initiated through Cantrip when observable.

Human input increments the scene revision and becomes part of the agent's next
observation. It does not automatically pause or cancel the agent. If human and
agent actions overlap, the input scheduler preserves the real event ordering
and the resulting scene is authoritative.

Secure text fields require special handling. Human or agent text directed at a
field identified by Accessibility as password or secure input is represented
as a redacted input event with length metadata rather than plaintext.

## macOS native backend

The first backend should use focused Rust bindings to native macOS frameworks:

- ScreenCaptureKit for direct display and window frames.
- Accessibility APIs for window inventory, semantic snapshots, focus,
  control actions, and secure-field detection.
- CoreGraphics for coordinate pointer, scroll, and keyboard events where a
  semantic action is unavailable.
- AppKit and Foundation for application activation, clipboard, icons, paths,
  and Finder integration.
- ImageIO, Accelerate, Metal, or a focused image codec only where measurement
  shows that conversion or encoding needs it.

Native handles stay inside the Rust process. The worker sees validated opaque
IDs and bounded serializable results.

### Permissions and stable identity

Screen Recording and Accessibility permission belong to a stable shipped
runtime identity. `cantrip-cua` is bundled with the worker alongside the Codex
and Cantrip CLI runtimes, signed as part of the desktop distribution, and
resolved from a stable installed location.

Development must also use a deliberate stable helper identity and location.
Rebuilding a worktree must not produce a new permission identity or cause
repeated macOS prompts. The initial macOS spike must prove the development and
release signing behavior before broader implementation proceeds.

Permission status is diagnostic information. The actual capture or input call
remains authoritative. A denial returns a precise recovery state and opens the
normal macOS/Cantrip guidance; it must not cause an infinite retry or a generic
loading screen.

## Accessibility model

Accessibility is a first-class observation and action path rather than a
post-hoc optimization.

An accessibility snapshot should contain a bounded target-local tree with:

- Stable-within-generation element IDs.
- Role, subrole, label, value, description, and state.
- Target-local bounds.
- Focus, enabled, selected, expanded, editable, and secure flags.
- Supported semantic actions.
- Parent/child relationships.

The tool can query by element ID or bounded predicates and perform only actions
the snapshot advertised. Element IDs are invalidated when the target generation
changes or the native element is no longer present.

Accessibility actions are preferred for buttons, fields, menus, lists, tabs,
and other semantic controls. Screenshots and coordinate input remain available
for canvases, games, custom renderers, and other interfaces without adequate
accessibility metadata.

## Applications, Finder, and file operations

Routine filesystem work should use structured worker-owned operations rather
than pixel navigation through Finder:

- Open a file or directory.
- Reveal a path in Finder.
- Copy, move, rename, or trash an exact path.
- Launch or activate an application.
- Open a path with a selected or default application.

These operations remain constrained by the task's effective permission profile
and worker filesystem authority. They use the existing approval path when an
approval is required.

Finder remains available as a visual CUA target when manipulating Finder itself
is the requested task. Structured operations and visual operations share
trajectory attribution but are not disguised as one another.

## Managed MCP and model interface

Add a worker-managed MCP server named `cantrip_cua`. It is injected only when:

- The current worker reports a compatible CUA runtime.
- The current agent context supports computer use.
- The current task is bound to that worker.

The MCP host connects to `CantripCuaService` through the existing
capability-scoped worker broker. It never launches or connects to the Rust
sidecar directly.

The initial model-facing tools are:

- `js`
- `js_reset`
- `snapshot`, if measurements show that a small direct first-observation tool
  materially improves discovery or failure handling

The persistent `js` environment exposes a documented `cua` object. A typical
flow should be possible in one call:

```javascript
const state = await cua.getState();
const target = await cua.getWindow(state.windows[0].id);
await target.activate();
await target.click(420, 180);
await target.type("hello");
await target.key("ENTER");
await target.snapshot();
```

The same service exposes structured action primitives internally for provider
portability, deterministic tests, and future models that do not use a code
execution interface.

### JavaScript isolation

The persistent evaluator should run in the Rust sidecar using a maintained,
embeddable JavaScript engine selected during the initial spike. The exposed
environment contains only the `cua` API and safe language built-ins.

It must not expose:

- Native process or environment access.
- Arbitrary filesystem access.
- Network access.
- Dynamic native-library loading.
- Unbounded timers, workers, memory, output, or execution time.

Each evaluator is scoped to one authorized CUA session. It has bounded memory,
script size, execution duration, action count, screenshot count, and output.
`js_reset`, turn interruption, task stop, permission revocation, worker
disconnect, and session teardown all cancel pending work and dispose the
context.

## Permission and approval behavior

The effective permission profile selected through Cantrip is the source of
truth. Define CUA operation classes in the worker policy projection, such as:

- Observe screen or accessibility state.
- Use pointer and keyboard input.
- Read or write the clipboard.
- Launch or focus applications.
- Perform structured filesystem mutations.

The profile-to-operation mapping belongs in Cantrip's existing policy and
permission integration, not in platform-specific Rust code. Any required
approval becomes an ordinary durable agent interaction with task, thread,
turn, item, worker, target, and operation provenance.

Selected YOLO mode does not receive a second CUA prompt. Other profiles may
require an approval according to their effective policy. There is no separate
application denylist and no unconditional ban on Cantrip, terminals, password
managers, system settings, or security applications. The user-selected policy
and operating-system permissions remain authoritative.

The client always retains an out-of-band Stop/Disable control. This is a
lifecycle control, not an approval prompt.

## CUA observation and client monitoring

Create a dedicated CUA observation protocol rather than persisting a Remote
Desktop surface. The live channel carries:

- Current target metadata and generation.
- Encoded target frames.
- Agent cursor overlay state.
- Human pointer and input-event summaries.
- Capture, input, and permission status.
- Task, turn, and session attribution.
- Current agent action and outcome.

The server routes the stream to authorized clients but does not decode or
persist frame content. Desktop, browser, iPhone, and Android clients can attach
as observers. Client input to the worker's desktop remains a distinct future
decision; the first CUA monitor is primarily for observation, approval, and
Stop/Disable controls.

The monitor should be reachable from the active task and Trajectory. It should
show which worker, application/window or monitor, task, and agent own the
session. Multiple clients may observe the same session without creating
multiple capture sessions.

## Trajectory and audit behavior

CUA actions are ordinary protected agent activities and extend the existing
Trajectory model instead of creating a separate audit database.

Each activity records:

- Task, agent, thread, turn, and item correlation.
- Worker and CUA session identity.
- Target identity and generation.
- Action kind and execution method, such as Accessibility or CoreGraphics.
- Target-local coordinates and agent cursor state when applicable.
- Ordinary typed text.
- Key combinations and clipboard operation metadata.
- Timing, duration, status, and bounded native error information.
- Scene revision before and after the action.
- Whether intervening human input was observed.

Typed text is captured inside the existing encrypted protected-raw envelope,
not plaintext logs or server metadata. Known credentials continue through the
existing redaction path. Text sent to an Accessibility-secure field, text
explicitly marked sensitive by the calling tool, and values recognized as
credentials are stored as redacted metadata rather than plaintext.

Screenshots and full accessibility trees are not copied into a second audit
store. When a bounded screenshot is already part of the model-visible tool
result, existing encrypted message and attachment behavior remains
authoritative. Trajectory may retain a digest, dimensions, target generation,
and omission/truncation metadata.

Human collaboration events appear in the same turn trajectory so a reviewer
can understand why the scene changed between agent actions. Raw native event
streams are coalesced into meaningful bounded events rather than persisting
every mouse-move sample.

## Persistence

CUA sessions and native target IDs are transient worker state. They do not
require durable server database tables in the first release.

Durable information remains in existing systems:

- Selected and effective permission profile in chat state.
- Approvals in durable agent interactions.
- Actions and results in encrypted chat/trajectory content.
- Worker capability observations in the existing worker capability path.

If a future feature needs persistent CUA preferences, store only explicit user
preferences such as monitor or application selection. Never persist a native
window handle as a durable identity.

## Development and packaging

Add root scripts consistent with `cantrip_cli`:

- `cua:build`
- `cua:build:release`
- `cua:test`
- `cua:check`

Add a focused build helper under `scripts/cantrip-cua/` that:

- Builds the standalone Cargo manifest with `--locked`.
- Resolves debug and release artifacts without relying on a worktree-specific
  target path as durable runtime identity.
- Bundles `cantrip-cua` into the worker's `bin` directory.
- Makes the executable bit explicit on macOS.
- Verifies the packaged runtime by launching it and completing the real
  version/capability handshake.

The worker runtime resolver should check an explicit development override and
the known packaged binary location. It should invoke the selected binary and
let launch or handshake fail with the real error rather than rejecting it
based only on a version file or filesystem heuristic.

The desktop runtime already bundles the packaged worker. No separate
app-to-sidecar path or Tauri command should be introduced.

### macOS signing and updates

The release pipeline must sign `cantrip-cua` before signing the enclosing
runtime and application. Verification must assert the nested executable's
signature and launch the packaged handshake from the final application layout.

Update tests must prove that replacing Cantrip in place preserves the stable
CUA permission identity. Development tests must prove that branch changes and
worktree rebuilds do not create a new permission identity or helper path.

## Testing strategy

### Pure Rust tests

- Protocol framing, bounds, cancellation, and version negotiation.
- Session and target-generation state machines.
- Action batching and output ordering.
- Logical-to-native coordinate conversion.
- Agent cursor and scene revisions.
- Human-versus-agent event classification.
- JavaScript isolation, limits, persistence, reset, and cancellation.
- Secret-field and typed-text audit handling.
- Fake-backend capture, accessibility, input, and failure behavior.

### Worker tests

- Sidecar lazy start and one-time crash recovery.
- Task and worker ownership enforcement.
- Effective permission-profile projection.
- YOLO execution without a duplicate prompt.
- Durable approval routing for profiles that require it.
- MCP task/session binding and stale-call rejection.
- Observation fan-out to multiple clients.
- Protected trajectory capture and redaction.
- No computer-use initialization during an ordinary worker startup.

### macOS integration harness

Build a deterministic fixture application with standard controls, custom
drawn content, a secure field, multiple windows, and observable state. Exercise:

- Monitor and individual-window inventory.
- Direct capture of a fully occluded window.
- Window movement, resize, focus, hide, minimize, close, and recreation.
- Retina scaling and multiple displays with negative origins.
- Accessibility click, value set, selection, scroll, and focus.
- Coordinate click, drag, scroll, key combinations, and Unicode text.
- Distinct agent cursor rendering.
- Human input arriving between and during agent action batches.
- Permission denial and revocation.
- Sleep, lock, unlock, and session recovery as allowed by macOS.
- Packaged and development signing identities.

Tests must describe actual macOS restrictions instead of treating unsupported
secure surfaces as implementation regressions.

### End-to-end acceptance

1. Start an agent on a macOS worker.
2. Select an application window that is behind another window.
3. Capture and understand its current state without bringing it forward.
4. Use an Accessibility action without moving the human pointer.
5. Use coordinate input where the application has no semantic control.
6. Show the agent cursor distinctly in the observation and client monitor.
7. Let the user interact while the agent continues and confirm the agent sees
   the resulting user event and new scene.
8. Run under a profile that requires approval and resolve it through the
   existing interaction UI.
9. Run under selected YOLO mode without a second CUA-specific prompt.
10. Observe the session from a browser or mobile client.
11. Inspect the completed actions and typed text in protected Trajectory data.
12. Stop the session from the client and verify native input ends immediately.

## Performance requirements

Establish baselines before replacing the current native dependencies. Measure:

- Lazy sidecar cold start and handshake.
- Warm target inventory.
- Monitor and window snapshot latency.
- Action-to-observed-frame latency.
- Accessibility query and action latency.
- Image conversion, encoding, and IPC copy cost.
- Idle CPU and memory with and without observers.
- CUA monitor fan-out cost.

Do not set permanent thresholds before the macOS spike measures representative
hardware. After measurement, add release-regression budgets for cold start,
warm observation, input-to-frame latency, idle CPU, and memory.

The normal worker startup path must not eagerly launch the sidecar, request
Screen Recording permission, enumerate displays, or initialize a JavaScript
engine.

## Implementation cycles

Each cycle is an independently reviewable worktree PR and must auto-merge
before the next dependent cycle begins.

### Cycle 1 — Contracts and macOS feasibility

- Add the architecture record and protocol vocabulary.
- Characterize current dependency behavior and parity requirements.
- Prototype stable development/release helper identity.
- Prove ScreenCaptureKit capture of an occluded window.
- Prove agent/human event tagging and Accessibility actions.
- Select focused Rust bindings and the isolated JavaScript engine using
  measured prototypes.

### Cycle 2 — Rust package and fake backend

- Create `cantrip_cua` with locked dependencies.
- Implement protocol framing, capability negotiation, cancellation, session
  ownership, target generations, and fake backend.
- Add Rust build, test, check, and packaging helpers.

### Cycle 3 — Worker service and packaging

- Implement lazy `CantripCuaService` and the sidecar client.
- Bundle the executable with standalone and desktop workers.
- Add real packaged handshake verification and macOS signing coverage.
- Keep product behavior disabled behind capability negotiation.

### Cycle 4 — macOS inventory and capture

- Implement monitor, application, and window inventory.
- Implement direct monitor/window capture, scale conversion, binary image
  transport, and target lifecycle events.
- Add the macOS fixture harness for background and occluded windows.

### Cycle 5 — macOS input, cursor, and collaboration

- Implement the logical agent cursor.
- Implement Accessibility-first actions and CoreGraphics fallback input.
- Tag generated events and observe relevant human events.
- Implement clipboard behavior and scene revisions.

### Cycle 6 — Applications, Finder, and filesystem operations

- Implement application launch, activation, and inspection.
- Implement open, reveal, copy, move, rename, and trash operations.
- Route authorization through the effective permission profile.

### Cycle 7 — Managed MCP and JavaScript execution

- Add the `cantrip_cua` managed MCP.
- Implement bounded persistent `js` and `js_reset` sessions.
- Add provider-neutral structured action support beneath the MCP adapter.
- Return model-visible image observations and precise native failures.

### Cycle 8 — Permission and durable interaction integration

- Define CUA operation classes in the existing permission projection.
- Route required approvals through durable agent interactions.
- Verify selected YOLO mode adds no second prompt.
- Add client Stop/Disable behavior independent from approval state.

### Cycle 9 — CUA monitoring UI

- Add the dedicated observation channel.
- Add desktop, browser, iPhone, and Android monitoring views.
- Render agent and human cursors distinctly.
- Expose active target, worker, agent, action, and Stop/Disable controls.

### Cycle 10 — Trajectory integration

- Add CUA action and human collaboration event kinds.
- Record ordinary typed text in protected raw capture.
- Redact secure-field and credential values.
- Add CUA filters, previews, raw details, timing, and scene correlation.

### Cycle 11 — Legacy native dependency retirement

- Run parity coverage against the macOS release candidate.
- Remove `@zavora-ai/computer-use-mcp` from CUA paths.
- Remove `node-screenshots` only after confirming no remaining product owner.
- Remove duplicated compatibility adapters rather than retaining two native
  execution stacks indefinitely.

### Cycle 12 — Release hardening

- Run the full macOS integration and packaged-app matrix.
- Verify signing, update compatibility, stable permissions, crash recovery,
  and development rebuild behavior.
- Measure and enforce agreed performance budgets.
- Update user, security, developer, release, and troubleshooting documentation.

Windows planning begins only after the macOS completion criteria are met.

## Risks and mitigations

### macOS privacy identity churn

An unstable helper path or signing requirement could repeatedly invalidate
Screen Recording or Accessibility permission. Prove stable development and
release identity in Cycle 1 and treat it as a release compatibility contract.

### Separate cursor expectations

macOS has one real pointer. Maintain an independent logical agent cursor,
prefer Accessibility actions, and label coordinate injection accurately. Do
not promise physical pointer isolation the operating system cannot provide.

### Background-window differences

ScreenCaptureKit behavior varies across minimized, hidden, other-Space, and
protected windows. Characterize each state and report it precisely; never
substitute monitor capture without disclosure.

### Sensitive trajectory text

Typed text can contain credentials. Keep it in encrypted protected raw capture,
redact secure fields and known secret forms, bound its size, and keep it out of
logs, analytics, public metadata, and server-side search.

### Human and agent contention

Concurrent input can change the scene between observation and action. Preserve
real ordering, publish user events, increment scene revisions, and let the
agent re-observe. Do not add speculative preflight checks that prevent a valid
native action.

### Broad native surface area

Keep Rust dependencies narrow and platform modules explicit. Every new native
capability must have an owned protocol operation, permission class, failure
contract, and integration test.

## Completion criteria

The macOS computer-use goal is complete only when:

- `cantrip_cua` exists as a first-party Rust package and bundled worker
  executable.
- Computer use runs on the same worker as the agent and cannot target another
  worker.
- Normal worker startup does not launch or initialize CUA.
- A selected monitor or individual macOS window can be observed directly.
- A normal occluded/background window can be captured without foregrounding
  it when ScreenCaptureKit supports that state.
- Accessibility-first actions and coordinate fallback input both work.
- The agent has a distinct logical cursor visible to the model and monitoring
  clients.
- Human input does not automatically pause the agent and appears as bounded
  collaborative session events.
- Existing permission profiles and durable approvals authorize CUA operations.
- Selected YOLO mode does not receive a duplicate CUA confirmation.
- The managed MCP provides bounded persistent JavaScript execution and a
  provider-neutral structured action layer.
- Desktop, web, iPhone, and Android clients can monitor the worker-local
  session without becoming automation targets.
- Ordinary typed text is visible in encrypted Trajectory details, while secure
  and credential values are redacted.
- The packaged sidecar has a stable signed macOS identity across updates and a
  stable deliberate development identity across worktrees and rebuilds.
- Actual packaged binaries complete a version/capability handshake in CI.
- The existing Remote Desktop implementation continues to work independently.
- Legacy native CUA dependencies are removed after verified parity.
- Focused Rust, worker, protocol, app, packaging, signing, update, and macOS
  integration tests pass.
- User, developer, security, release, and troubleshooting documentation
  describe the implemented behavior and real macOS limitations.

The work must not stop at a protocol scaffold, screenshot-only prototype,
foreground-only automation path, or tool that cannot be monitored and audited
through Cantrip.
