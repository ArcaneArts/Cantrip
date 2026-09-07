# CUA window effects

The foundation is being delivered in sequential manual-change PRs. The shader
ABI and native telemetry are merged in PR #1814; clean capture, Metal rendering,
panel ordering, bundled fragments, and optional history are merged in PR #1815.
Account settings now propagate through the server and worker to the native helper.
Effects remain Off by default. Development shader replacement and the final
lifecycle/delivery audit remain required follow-up work.

## Composition contract

The final presentation has three independent layers: the application, a
nonactivating click-through effect panel, and the existing agent cursor panels.
The shader receives only the original window texture. Neither custom/system
cursor pixels nor any effect panel may enter that texture. Agent snapshots keep
their existing unfiltered capture and subsequent cursor annotation.

The live renderer must use ScreenCaptureKit window frames and Metal textures;
it must not transport encoded PNG frames through the worker or JS runtime. One
capture/effect surface is shared by all sessions attached to a window. No input
receipt is changed by presentation success or failure. Generated event telemetry
is not evidence that the application accepted the input.

## Shader ABI version 1

`cantrip_cua/src/effects/uniforms.rs` and `cantrip_cua/shaders/contract.metal`
define matching C/Metal layouts using only initialized 16-byte lanes. The frame
buffer is 7,040 bytes; bind it as a Metal buffer, not inline fragment bytes.
The fixed fullscreen triangle vertex function only supplies positions and UVs.
Effect logic belongs in fragment entry points.

All coordinates have a top-left origin. Logical cursor coordinates are relative
to the application window, never the desktop. Normalized coordinates divide by
logical window size. Velocity is in logical points per second. Texture size and
X/Y pixel scales are supplied separately, allowing display-scale transitions.

| Frame field | Meaning |
| --- | --- |
| `header` | ABI version, cursor count, event count, wrapping frame number |
| `time` | Render seconds, frame delta, source-frame seconds, capture age |
| `window` | Logical width/height, X/Y pixel scales |
| `texture` | Pixel width/height, reciprocal dimensions |
| `parameters[4]` | Up to 16 descriptor-ordered scalar values; booleans use 0/1 |
| `cursors[16]` | Per-session cursor inputs sorted by stable agent identity |
| `events[64]` | Most recent input events across those cursors, ordered by time/identity/sequence |

Times originate from one process-local monotonic nanosecond clock. The renderer
supplies a local epoch and converts differences to shader seconds; absolute
system timestamps are never converted to floats. Events/source frames before
the renderer epoch can have negative relative times. A click **age** of -1 means
no such event has occurred. Use the age to distinguish that from a negative
relative click timestamp.

Each cursor has a 128-bit identity derived from the thread ID (chat ID fallback),
RGBA color, visibility, logical and normalized positions, raw and smoothed
velocity, held mouse-button and modifier masks, press/release times and ages,
and a 64-bit event sequence split into low/high words. Its recent-event count is
the locally retained count; the global frame buffer may retain fewer events.

Button bits are left=0, right=1, middle=2, back=3, forward=4. Modifier bits are
Shift=0, Control=1, Alt=2, Meta=3. These represent CUA-generated held input, not
human keyboard or mouse state. Cleanup releases use the same observer as normal
releases. Accessibility actions have no held duration and set both click times.

Event kinds: press=1, release=2, key down=3, key up=4, scroll=5, Accessibility
control action=6. Events contain their own location flag/coordinates, modifier
mask, mouse-button or ANSI key code, sequence, timestamp/age, and scroll delta.
Keyboard events have no pointer location. A session retains at most 32 events;
render sampling excludes events older than two seconds. Detach or replacement
by a new target generation clears held state and history; late callbacks cannot
recreate a removed owner.

## Motion and event sources

`effects/live.rs` shares bounded telemetry with the renderer. Locks protect only
plain data; native input and rendering never execute under those locks.

Animated cursor travel and native drag presentation feed the same motion state
that supplies shader positions and velocity. Posted input events record their
own positions without moving that presentation state ahead of queued cursor
updates. Velocity uses exponential smoothing based on elapsed time (60 ms time
constant); idle sampling decays it (80 ms) without feeding render cadence back
into integration. Resizing, display-scale changes, explicit discontinuities, and
long gaps reset motion. Moving the window's desktop origin creates no velocity.

Native mouse/key observers inspect events only after posting. They never post
additional events or change delivery methods. Accessibility telemetry records
issued actions, including ambiguous responses, but excludes errors known to
reject the action. Scroll telemetry records the generated scroll delta. These
observations do not upgrade `unknown`/`unverified` input receipts.

## Bundled descriptors

The default configuration is Off. Descriptors include stable effect ID, ABI
version, fragment entry point, continuous-animation requirement, optional
history-texture requirement, and parameter definitions. History is disabled for
all initial effects; the renderer must allocate it only for descriptors that
request it and must keep it separate from the original capture.

| ID | Fragment | Parameters |
| --- | --- | --- |
| `off` | None | None |
| `pass-through` | `cantrip_passthrough` | None |
| `debug-gradient` | `cantrip_debug_gradient` | `strength` 0–1 (1), `radius` 16–320 points (80), `showTelemetry` 0/1 (1) |

Configuration validation checks the actual supplied parameter values and names.
It does not gate capture or input on cached capability/permission guesses.

## Native rendering and ownership

ScreenCaptureKit uses a desktop-independent filter containing only the selected
application window, at its pixel resolution, with cursor capture, audio, shadows,
and global clipping disabled. Complete frames replace a single retained sample
slot. Idle notifications keep the last clean image; blank/suspended output hides
the panel. The existing low-resolution sharing stream is released while the live
effect stream supplies that window. Agent snapshots retain their separate,
unfiltered screenshot path. Monitor snapshots exclude the helper application
when its panels are present, also covering newly created panels during capture.

CoreVideo imports the sample's IOSurface into a Metal texture without encoding
or reading pixels on the CPU. Each GPU frame retains both its pixel buffer and
CoreVideo texture wrapper until GPU completion. Source timestamps are mapped
from the CoreMedia host clock to the local monotonic epoch before conversion to
shader-relative seconds.

The main queue owns AppKit windows, geometry, capture delegates, and composition
order. A shader compiler thread creates pipelines without blocking CUA or the
main queue. Each target has one render thread with a latest-only mailbox;
drawable acquisition and GPU work cannot block input dispatch. There are at most
three GPU submissions in flight per target. If drawable acquisition waits, the
worker replaces its waiting job with the newest available frame/input context.
Cursor telemetry is sampled when the worker actually renders.

The effect panel is transparent until a matching geometry generation finishes
rendering. Acknowledgments also track the source sample sequence so a dropped
submission is retried even if the source subsequently becomes static. Failed GPU
commands or stopped capture remove the presentation and expose a diagnostic in
`effects.get`. Old asynchronous discovery and render callbacks cannot restore a
detached target. The last owner releases its stream, renderer, compiler resources,
and windows; in-flight GPU references live until completion.

All sessions on a helper share its effect configuration. One target/generation
owns one effect surface; the lexically first session ID supplies initial metadata
when owners have different retained revisions. Actual window geometry takes
precedence. Each agent retains its separate cursor color and telemetry. Window
movement and display scale update the panel, and resize invalidates stale frames.
Closed, minimized, and off-Space targets are removed from presentation. Panels
use the target's level and relative ordering, never activation or target raising.
Cursor panels order above the effect panel. Settings and visual acceptance must
still verify the applicable fullscreen/Space behavior on the user's macOS build.

History is an optional pair of GPU-only render-target textures. The first history
image is cleared; subsequent frames sample the previous effect output and render
into the other texture, then blit into the drawable. Neither history texture can
replace or modify the capture texture. History resets on geometry/effect changes
and is not allocated by the initial bundled effects.

The debug fragment uses a left-to-right gradient inversion of source pixels and
an animated FX badge. Optional telemetry shows raw/smoothed velocity, held-button
and modifier feedback, and overlapping press events. This is a diagnostics
shader, not a final artistic warp effect. The pass-through fragment samples the
source unchanged. A fixed fullscreen triangle is the only vertex stage.

The native approach follows Apple's documentation for
[window capture](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(desktopindependentwindow:)),
[IOSurface-backed screen frames](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos),
and [CoreVideo Metal texture import](https://developer.apple.com/documentation/corevideo/cvmetaltexturecachecreatetexturefromimage(_:_:_:_:_:_:_:_:_:)).

## Remaining delivery and manual acceptance

The remaining milestone must provide development shader replacement with useful
compilation diagnostics and last-working-pipeline/original-window fallback.
It must finish the lifecycle review and document concrete platform limitations.

After those milestones, build/install development artifacts without launching or
restarting the app. The final handoff will include exact setup instructions and
a copyable agent prompt for checking filtering, clean agent snapshots,
unfiltered cursors, click/drag telemetry, window alignment, stacking, and cleanup.

Focused offscreen Metal tests use synthetic textures (no desktop capture, window,
or input). They check pass-through orientation/pixel preservation, debug output
separation, history initialization/accumulation, and compiler diagnostics. Local
telemetry and service tests cover the ABI and existing session behavior. These
checks do not establish live window alignment or stacking. Live visual acceptance
belongs to the user.

## Account settings and worker synchronization

Settings → General → Computer use → Window effects offers Off, Pass-through,
Debug gradient inversion, and the debug shader’s strength, radius, and input
feedback parameters. Effects default to Off. Disabling computer use removes the
active effect while retaining the chosen effect for a later opt-in.

Configuration is account-wide and lives in server-owned user settings, separately
from cursor appearance and input authorization. Migration 0202 advances a durable
revision whenever the effect or computer-use opt-in changes. Settings saves send
the effective configuration to workers immediately; authenticated heartbeats
also carry it every five seconds. The worker ignores older revisions, applies
the newest revision to its current helper, and restores it when a helper starts.
Reading or saving settings never starts the helper or a capture session.

The settings page can select a worker and refresh its actual effect status.
It reports compiler/render errors and unsupported backends; a status of
“presenting” describes native presentation state, not user-verified visual
correctness. Rendering configuration errors do not revoke input authorization or
cause agent input to be replayed. Disabling computer use still uses the existing
session-revocation and input-cleanup behavior.
