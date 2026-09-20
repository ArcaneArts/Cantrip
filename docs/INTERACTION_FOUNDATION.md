# Shared interaction foundation

`cantrip_interaction` is the platform-independent Rust crate used by native CUA
for cursor state, identity color, software rasterization, motion paths, geometry,
and generated input/presentation telemetry. It does not depend on CUA, agent
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

## Integration boundary and remaining extraction

This first extraction supplies the real CUA cursor implementation to other Rust
consumers. It does not yet provide the continuous input session API, held-input
ownership, or a public native host for additional participants. Those are the
next part of the input extraction, not capabilities supplied by a cursor renderer.

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
