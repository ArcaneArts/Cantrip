# Shared interaction foundation

`cantrip_interaction` is the platform-independent Rust crate used by native CUA
for cursor state, identity color, software rasterization, motion paths, geometry,
generated input/presentation telemetry, input vocabulary, timeline execution,
and participant-held-input ownership. It does not depend on CUA, agent
turns, MCP, AppKit, remote desktop, or a browser engine.

## Cursor consumers

A consumer implements `CursorTarget` for its own target description and supplies
`CursorPresentation<T>` to a `CursorRenderer<T>`. The target supplies an opaque
ID, replacement generation, logical bounds, and display scale. No window handle,
process ID, or window kind is required by the shared contracts.
`cantrip_cua::macos::MacOsCursorRenderer` is the concrete native renderer. Its
`present` call receives a complete participant snapshot; a future adapter
coordinator must combine the active participants rather than submit competing
partial snapshots. It does not require `SessionBinding` or agent metadata.

`participant_id` identifies one live cursor owner. `appearance_identity` selects
stable color/effect identity and can survive a session reconnect. The adapter
chooses both. Neither is an authorization token. A renderer must not infer
permission to send input from presentation data.

CUA keeps its `SessionBinding`, ownership checks, and public wire format. Its
adapter maps session ID to participant ID and thread/chat ID to appearance
identity. The macOS overlay consumes presentation data without receiving agent
metadata. The move into this presentation format transfers owned fields instead
of cloning target and cursor data for every frame.

`CursorState` and `CursorAppearance` own logical state, trail, action feedback,
and identity-derived color. `rendering` implements the existing rasterization;
AppKit window positioning and lifecycle stay in the native renderer. Native
cursor panels remain click-through, above optional effects, and outside clean
window captures. Effects remain off by default.

## Motion and coordinates

`Motion::Immediate` produces the destination at time zero for future human
input. `EaseOut` preserves the existing 60–90 ms cubic deceleration.
`Scheduled` supplies a lazy spline ending at a known deadline, with optional
neighboring points. `Linear { duration }` supplies the lazy path used by native
drags. Long gaps and drags do not allocate a frame per sample in advance; zero
duration still yields the exact endpoint before release.
These are presentation paths: they never sleep, post input, or prove delivery.
CUA still owns cancellation and its existing timing adapter.

`Point`/`Bounds` preserve current logical-coordinate compatibility. New adapters
can use `LogicalPoint`, `ImagePoint`, `ViewportPoint`, and `GlobalPoint` with
`Coordinates` to avoid mixing spaces. Captured image dimensions determine image
scale, not the nominal native display scale. A viewport conversion receives the
actual fitted image rectangle so letterbox clicks are rejected. Rebuild the
transform from the geometry associated with the displayed frame after resizing.
Target replacement generation and geometry changes are distinct concepts.

`PresentationDelivery::Latest` permits coalescing obsolete visual states.
`BeforeInput` retains the existing presentation ordering for scripted travel.
Presentation remains best effort; drawing failure must never become an input
readiness gate or claim that a click succeeded.

## Telemetry and effects

Shared `Telemetry` accepts any `CursorSource`/`CursorTarget`. It records generated
input state, monotonic click times, positions, raw/filtered velocity, and bounded
recent events. Only presentation updates advance visual motion. Sampling for an
effect does not modify integration state. Events for a replaced target do not
modify its successor; removing a participant removes its telemetry.

CUA's shader ABI and configuration remain in `cantrip_cua::effects`. Compatibility
exports preserve its current tests and callers. Native event delivery, capture,
and Metal/AppKit rendering are still macOS-specific.

## Input vocabulary and ownership

`input::InputEvent` distinguishes pointer movement/down/up, physical key down/up
(including repeat), scroll, text commit/composition, surface preparation,
explicit host focus, and system media actions. Modifiers, mouse buttons, media
keys, and shortcut normalization are shared with CUA. Native Quartz/IOKit codes
remain in the CUA delivery adapter, not the shared crate. Structural validation
does not pretend to establish that a backend supports or can deliver an event.

`Ownership<C, R>` retains prepared releases across calls. Each live participant
gets a token unique to that registry and lifetime; reopening the same target
cannot accept an old token. Target identity and generation are retained without
assuming a particular surface type. Per-participant sequence fencing rejects
reordered or duplicate commands before dispatch, including retries after an
uncertain result. The adapter, not this registry, verifies authorization.

`C` is a backend-normalized collision key. `R` is the prepared matching release,
including native routing and modifier state if needed. A backend chooses the
collision domain: for example, different windows may share application keyboard
state. Conflicting holds are rejected without releasing the existing owner.
Different controls can be held concurrently. Cleanup removes only the closing
participant's holds, returns releases in reverse acquisition order, and is
idempotent. A drag can replace its retained release position before dispatching
movement. Adapters must attempt every returned release even if one fails and
must report uncertainty without replaying it.

`host::InputHost<B>` now drives this ownership registry and a concrete
`InputBackend`. It accepts typed events across calls or packets preallocated by
a macro compiler. A Down reserves its matching release before posting. Up
removes ownership before posting, so uncertain results are never replayed.
Native packet preparation includes the exact target identity/generation, which
is checked before posting a prepared packet to a different destination.

`Prepared` distinguishes Down, Up, repeat, held movement, and transient actions.
Backends supply canonical controls and retain release routing/modifiers. A
transient pointer movement cannot interfere with another participant's drag.
The native backend uses one pointer collision key for all buttons because an
application has one drag context, and physical key codes canonicalize aliases.

`PostFailure` distinguishes definitely unsent events from uncertain delivery.
An unsent Down does not generate a stray Up; an unsent movement retains the
previous release position. A delivery failure closes only that participant and
attempts all outstanding releases in reverse order. Cleanup errors are returned;
a panic still triggers scoped cleanup before unwinding. Close and Drop are
idempotent. Release packets bypass the cancelled operation token. Successful
native dispatch returns `DispatchedUnverified`, never proof of app behavior.

The concrete backend is `cantrip_cua/src/macos/input_backend.rs`. It reuses the
existing private Quartz source, SkyLight routing and target-only preparation,
matching up-event flags, native dispatch timestamps, and effects telemetry.
Composition returns an explicit unsupported result; committed text and physical
keys remain distinct. Focus and media retain their explicit side-effect domains.

CUA's macro adapter compiles existing timelines and text into prepared packets,
and sends drag movement through the typed continuous interface. The macOS
backend now owns one shared native host and retains one input participant per
CUA session across commands. Macros remain balanced, preserving their public
behavior. Target detach/replacement and session close end the matching input
participant; clearing accessibility caches or taking screenshots does not.

## Persistent native sessions

`cantrip_cua::macos::NativeInputHost` is the concrete reusable entry point. Clones
share a registry and process-level collision domains. Each participant retains
its own private native event source and routing group; CUA balanced macros
refresh their source/group as they did before extraction. Closing a participant
releases only its own native source resources. `open`
returns a `NativeInputSession`; no conversation, turn or MCP binding is required.
The session supports `submit(sequence, event, cancellation)` for adapters with
transport sequences, and `send(event, cancellation)` for ordered in-process
calls. Do not turn a replay into a new event by assigning a fresh sequence.

Holds persist across calls. Explicit Up, close/Drop, a processed cancellation, or
a delivery failure clean up only that participant. Operation cancellation
checks do not replace participant lifecycle: adapters call `close` when an idle
participant disconnects or loses authority. An old cancelled/replayed submission
does not close a live participant. Reopening uses a different ownership token.

`refresh` accepts authoritative geometry and operation context for the same
window generation/process. It cannot transfer a session to a replacement target.
An adapter must resolve its own target and authorize each action before calling
this API; opening a native session does not confer agent authority. CUA continues
to enforce its existing bindings and native target resolution.

`MacOsBackend::input_host()` returns a shared handle, and `with_input_host` allows
an application to provide the same native host to multiple authorized adapters.
Future native consumers must share this host to arbitrate shared application
input; separately constructed hosts intentionally have separate registries.
Neither remote desktop nor a browser adapter is implemented here.

Native buffers are exclusively owned and movable between worker threads. The
host serializes preparation and dispatch. Planned timeline waits, screenshots,
and cursor animation run outside its mutex. Legacy one-click operations retain
their bounded native settling waits, and semantic AX calls are synchronous.
Backend panics unwind after scoped cleanup; mutex poison from one participant
does not strand other participants.

CUA runs prepared native gestures independently, at most one job per session.
The main executor retains authorization and ordered state mutations while
unrelated sessions continue. Exact-binding close/detach/target replacement
cancels only matching input. Queued cancellations finish promptly. Progress uses
one latest cursor state with a bounded trail, sampled again on the presentation
queue to avoid stale updates from another session erasing click feedback.

`InputCapabilities` describes implementation support and limitations: native
surface-directed input, supported buttons, persistent holds, text versus
composition, preparation versus host focus, system media, and shared process
state. It is not a permission/readiness check and does not gate dispatch.
`Support::Unspecified` is distinct from unsupported. The native backend exposes
one simultaneous pointer hold because the application has one drag context.

## Shared timeline execution

CUA now uses `schedule::dispatch_fallible` for its prepared native timelines.
The original infallible `dispatch` remains a compatibility wrapper. Delivery
errors stop the sequence and attempt remaining releases without hiding cleanup
failures.
The shared executor owns ordering, lazy visual lookahead, late cosmetic-frame
dropping, and release-on-exit. Its caller supplies cancellation, waiting, event
preparation, and posting. Failure retains both the caller's error and whether
input began; CUA preserves its existing unverified/no-replay receipts.

The native macro adapter waits using relative elapsed offsets with cancellable
condition-variable sleeps. No absolute clock addition can overflow on a long
safe-integer duration. The shared scheduling core takes caller-supplied clocks;
continuous consumers need no macro or timer to retain held input across calls.

## Compatibility actions and integration boundary

Cursor presentation, native gesture delivery, ownership, and timeline execution
use the shared contracts today. No remote desktop or browser integration is
included.

Legacy background, process, and explicit global clicks now use the same native
participant and shared host through `submit_action`. Physical click pairs declare
the pointer collision control, so they cannot release a different participant's
held drag. AX press and explicit focus use the semantic-action hook without
pretending they post physical pointer events. Their established native routing,
receipts, and explicit activation behavior remain unchanged. There is no fallback
from background delivery to the host cursor.

`submit_action` is a trusted synchronous adapter hook for existing backend-specific
operations. It fences session/target/sequence before the callback, checks declared
control conflicts, and performs participant-scoped failure/unwind cleanup. The
callback must balance its own transient native resources, classify uncertain
input honestly, and never perform a scheduled macro inside this hook. It is not
an agent tool, permission grant, or arbitrary code execution endpoint.

Implementation and migration are complete. The user deferred further native QA
on 2026-09-21; untested application behavior remains explicitly recorded rather
than blocking this implementation handoff. Unit tests and software benchmarks
alone do not prove that a specific application accepted input. See the
[completion record and deferred QA checklist](INTERACTION_FOUNDATION_ACCEPTANCE.md).

A future remote-desktop adapter will supply authorized participant sessions,
window targets, frame geometry, and immediate pointer motion. A future embedded
browser adapter will supply its own page/surface targets and rendering backend.
Neither integration is implemented here. Non-Rust callers will require a typed
host boundary; they should not invoke the agent JavaScript evaluator.

## Local verification

- `pnpm interaction:test` runs shared geometry, motion, and participant tests.
- `pnpm interaction:check` checks Rust formatting and Clippy.
- `pnpm cua:test` includes shared tests followed by existing CUA regression tests.
- `pnpm cua:check` includes both crates.

The native CUA suite continues to cover cursor pixels/tiles, alpha composition,
styles, glow, scheduling cancellation, effect uniforms/telemetry, stale targets,
wire contracts, and script execution. It does not substitute for a visual test
of native event delivery when that implementation changes.

## Connecting another consumer later

A native adapter supplies its own authorization and resolves target metadata. It
shares the application's `NativeInputHost`, opens one session per participant,
keeps that handle across messages, and submits original monotonic sequence IDs.
For example, two separate incoming messages can hold and release a physical key:

```rust
use cantrip_cua::{cancellation::Cancellation, error::Result, macos::NativeInputSession};
use cantrip_interaction::input::InputEvent;

fn note_down(session: &mut NativeInputSession, sequence: u64, cancel: &Cancellation) -> Result<()> {
    session.submit(sequence, InputEvent::KeyDown {
        key: "C".into(), modifiers: vec![], repeat: false,
    }, cancel)?;
    Ok(())
}
fn note_up(session: &mut NativeInputSession, sequence: u64, cancel: &Cancellation) -> Result<()> {
    session.submit(sequence, InputEvent::KeyUp { key: "C".into() }, cancel)?;
    Ok(())
}
```

These functions do not authorize requests or resolve windows. The adapter does
that before calling them. On disconnect, close the handle and remove its cursor
from the renderer's complete participant snapshot. On target replacement, close
and open a new handle; never transfer old held input or replay an uncertain event.
Use `Motion::Immediate` for human cursor updates. Mouse button holds use the same
Down/Move/Up lifecycle, with cleanup retaining the last dispatched drag position.

An embedded browser implemented through page-level APIs instead supplies an
`InputBackend` with its own `Target`, canonical `Control`, prepared `Packet`, and
actual delivery errors. It implements `CursorTarget`/`CursorRenderer` for its
surface rather than fabricating native macOS window IDs. Text composition is
supported only if that backend implements it. If a browser consumer instead
chooses native-window input, it uses the native adapter above. Both remain future
integrations, with their own permissions and transport lifetimes.

## Measuring software overhead

Run the recording-backend workload without desktop permissions or real input:

```sh
cargo run --locked --release --manifest-path cantrip_interaction/Cargo.toml --example overhead
```

It warms up three runs and reports median/p95 from 21 measured runs of 200,000
events. The direct recording backend is compared with that same backend through
shared validation, ownership, sequence handling, and cleanup. Open/close cycles
also repeatedly reuse capacity. This measures software bookkeeping, excluding
Quartz, AX, rendering, capture, network, and application latency. It is not a
native performance claim or an automatic timing gate.

## Worker participant endpoint (remote integration)

The native helper accepts `interaction.request` separately from agent operations.
Its request types are `open`, `input`, `close`, and `closeBinding`. An open supplies an exact window
ID/generation and a worker-derived binding (`workerId`, `surfaceId`, `attachmentId`,
`participantId`). It returns a monotonically allocated helper-local `handle`, the
resolved target, and the shared cursor appearance/state. Input supplies that
binding/handle, an increasing safe-integer `sequence`, and a shared `InputEvent`
encoded as `{type, data}` (for example `keyDown` with `key`, `modifiers`, `repeat`).

The worker must derive these bindings from an authorized remote attachment, retain
the helper runtime identity alongside the handle, and close on detach or revocation.
`closeBinding` releases even an open whose response was lost and is safe to repeat.
A helper restart invalidates every old handle; never submit one to a replacement
helper. This endpoint is not available to agent JavaScript and does not grant
remote-desktop authorization. The worker service owns the participant bridge; remote-desktop adapter and frontend wiring are a subsequent milestone.

Native participant input uses the same `NativeInputHost` as CUA, preserving held
controls between calls. Target replacement, cancellation, or dispatch failure ends
only that participant. Duplicate/out-of-order sequences and mismatched bindings
post nothing. Reopening allocates a fresh handle, even for the same binding.
Surface input cannot substitute monitor/global input, focus activation, or system
media controls. A dispatched receipt explicitly leaves window delivery unverified;
it is not proof that an application reacted.

The macOS backend combines worker participant presentations with active CUA cursor
presentations before rendering. Human positions are presented directly without the
CUA macro travel animation. This native endpoint does not yet provide a video
stream or browser-side cursor rendering. Native interaction QA remains deferred.

`CantripCuaService.participants` owns worker-side handles. `open(binding, target)`
returns initial target/cursor metadata and `send(sequence, event)` / `close()`
methods. Bindings must come from the authorized remote attachment, not client
input. The bridge shares the existing helper, serializes each participant's
input, snapshots queued event values, rejects duplicate sequences, and releases
its exact binding when open/input fails. It never sends old handles or cleanup
to a replacement helper. Agent chat/turn cancellation leaves these independent
participants alone; worker disconnect closes them all. Helper generation is a
worker lifetime fence, not a client-provided field.
