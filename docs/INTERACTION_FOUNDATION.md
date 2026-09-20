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

`Ownership` does not post OS events or run cleanup implicitly. Its native host
must consume the returned releases on cancellation, close, and delivery failure.
That integration is still pending; this is not yet a remotely callable input API.

## Shared timeline execution

CUA now uses `schedule::dispatch` for its existing prepared native timelines.
The shared executor owns ordering, lazy visual lookahead, late cosmetic-frame
dropping, and release-on-exit. Its caller supplies cancellation, waiting, event
preparation, and posting. Failure retains both the caller's error and whether
input began; CUA preserves its existing unverified/no-replay receipts.

The current synchronous CUA adapter still occupies its executor during a long
gesture. Fair scheduling across sessions and native continuous-input delivery
are required follow-up work, not capabilities implied by this extraction.

## Integration boundary and remaining extraction

Cursor presentation and timeline execution use the shared implementation today.
The persistent ownership registry and typed continuous events are ready for the
next native delivery/host integration. No remote desktop or browser integration
is included.

Remaining goal work: integrate a typed native host with this ownership registry;
route existing CUA gesture delivery through it; make long schedules yield to
unrelated sessions; remove the legacy short drag-duration limit using bounded,
lazy sampling; expose real backend capability/delivery results; measure extraction
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
