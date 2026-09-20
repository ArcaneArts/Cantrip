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
neighboring points. Long gaps do not allocate a frame per sample in advance.
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
host serializes preparation and dispatch, but no timeline delay, screenshot or
cursor animation runs under its mutex. Backend panics unwind after scoped
cleanup; mutex poison from one participant does not strand other participants.
The existing CUA request executor still serializes whole macros; making that
executor cooperative is the next integration step.

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

The current synchronous CUA adapter still occupies its executor during a long
gesture. Fair scheduling across CUA sessions remains required follow-up work.
Native continuous-input consumers can already retain independent session handles.

## Integration boundary and remaining extraction

Cursor presentation, native gesture delivery, ownership, and timeline execution
use the shared contracts today. No remote desktop or browser integration is
included.

Remaining goal work: migrate remaining legacy input paths, make long schedules
yield to unrelated CUA sessions; remove the legacy short drag-duration limit using
bounded, lazy sampling; measure extraction
overhead; and complete native regression/goal acceptance. These are required
follow-ups before the overall extraction can be considered complete.

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
