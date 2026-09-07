# CUA window effects

The foundation is being delivered in sequential manual-change PRs. The first
milestone defines the shader ABI, bundled effect descriptors, and native input /
shared cursor telemetry. It does **not** yet display a filtered window or expose
settings. Live GPU capture/rendering, panel ordering, configuration, shader
replacement, and lifecycle handling remain required follow-up milestones.

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

## Remaining delivery and manual acceptance

Subsequent milestones must deliver clean live capture, bounded frame/GPU
ownership, independent animation, shader compilation and replacement, optional
history, shared-window ownership, click-through panel stacking, geometry and
Space/fullscreen lifecycle, settings that respect computer-use enablement, and
cleanup on disable/final detach. Off must remain the default. A failed renderer
must reveal the original application rather than cover it with a frozen frame.

After those milestones, build/install development artifacts without launching or
restarting the app. The final handoff will include exact setup instructions and
a copyable agent prompt for checking filtering, clean agent snapshots,
unfiltered cursors, click/drag telemetry, window alignment, stacking, and cleanup.
Live visual acceptance belongs to the user; local tests do not claim it.
