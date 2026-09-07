# CUA window effects

The foundation is being delivered in sequential manual-change PRs. The shader
ABI and native telemetry are merged in PR #1814; clean capture, Metal rendering,
panel ordering, bundled fragments, and optional history are merged in PR #1815.
Account settings now propagate through the server and worker to the native helper.
Effects remain Off by default. The implementation review, platform limits, and
manual acceptance procedure are recorded below.

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

## Cursor warp

Select **Settings → General → Computer use → Window effects → Cursor warp**.
This fragment samples the clean window through a subtle lens around each visible
agent cursor, adds a wake from smoothed cursor velocity, and emits expanding
ripples at recent mouse presses or accessibility actions. The cursor and glow
remain above the effect. It changes neither agent screenshots nor input coordinates.
There is no debug badge or inversion in this effect.

| Parameter | Default | Range |
| --- | --- | --- |
| Warp strength | 1 | 0–2; 0 is exact pass-through |
| Warp radius (logical points) | 110 | 32–320 |
| Motion response | 1 | 0–2 |
| Click ripple | 1 | 0–2 |
| Dissipation speed | 1 | 0.1–5; lower lingers, higher settles faster |

Strength, radius, motion, and ripple occupy the first uniform lane; dissipation occupies the next lane’s X component. Motion uses the existing
frame-independent smoothed velocity; a stationary cursor keeps only a small lens.
At speed 1, press ripples expire after 650 ms. Speed 0.1 stretches them to 6.5 seconds and slows motion-wake decay tenfold; speed 5 shortens both fivefold. The warp’s sampled smoothed velocity uses this decay without changing the cursor trajectory, raw velocity, or retained input timestamps. Recent events remain bounded to 32 per agent and 64 per frame, so dense input can replace older ripples. Overlapping contributions have a shared maximum
displacement and fade at the window boundary. It needs continuous rendering for
motion/decay, but no history texture or extra capture stream.

For manual testing, reuse the piano prompt below with Cursor warp selected.
Watch straight key edges bend during cursor travel and a brief ripple on a press;
wait to see the motion wake settle back to the subtle lens. Try strength 0 and
then 1, and compare the agent's clean screenshot. Effects remain Off by default.
Restart the development worker after updating the bundled helper, using the same
profile as before. The live shader replacement environment variable, if set,
overrides bundled shaders; unset it and restart to test this bundled effect.

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

## Validation scope

Development artifact installation and the final handoff follow the merged
implementation. The manual acceptance procedure below covers the live behavior.

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

## Development fragment shader replacement

On the Mac running the worker, choose a local UTF-8 fragment file before starting
that worker. For example, from the repository root:

```sh
cp cantrip_cua/shaders/effects.metal /tmp/cantrip-window-effect.metal
CANTRIP_CUA_EFFECT_SHADER=/tmp/cantrip-window-effect.metal pnpm dev
```

Then select **Debug gradient inversion** in Settings and have an agent attach a
window. The helper reads the file on its dedicated compiler thread every 250 ms
while a window owns an enabled effect. Saving changed source recompiles it; no
worker restart is needed for subsequent edits. Source is limited to 1 MiB, with
one latest source/result retained. This opt-in development file is local to the
worker host; it is not an agent tool argument or a saved account setting.

The runtime prepends `contract.metal`, including the fixed vertex function. Do
not duplicate it. Without metadata, the selected effect descriptor supplies the
fragment name and animation/history requirements. For a custom fragment, include
one metadata comment anywhere in the file:

```metal
// cantrip-effect: {"contractVersion":1,"fragment":"my_effect","continuous":true,"history":false}
constexpr sampler cleanSampler(coord::normalized, address::clamp_to_edge, filter::linear);
fragment float4 my_effect(CantripVertex in [[stage_in]],
    texture2d<float> clean [[texture(0)]],
    texture2d<float> previousOutput [[texture(1)]],
    constant CantripFrame &frame [[buffer(0)]]) {
    float4 pixel = clean.sample(cleanSampler, in.uv);
    float pulse = 0.05f * (1.0f + sin(frame.time.x));
    pixel.rgb = mix(pixel.rgb, pixel.a - pixel.rgb, pulse);
    return pixel;
}
```

Use `continuous: true` whenever the effect responds to time or cursor/input
changes on otherwise static video. Set `history: true` to allocate the two
renderer-owned history textures; texture 1 starts transparent black and contains
the previous processed output thereafter. History resets on resize, source
invalidation, effect replacement, and parameter changes. Texture 0 always stays
clean. The active settings descriptor still defines parameter order/types:
selecting Debug exposes strength, radius, and showTelemetry in the first three
scalar slots. To add a new bundled effect with different parameters, extend the
native descriptor registry, matching protocol/settings definitions, and fragment
entry point together.

The settings status displays the active development filename and errors. Metal
line numbers refer to the original file, not the prepended ABI. Missing files,
invalid metadata, missing entry points, and compilation errors preserve the last
working pipeline; if none exists, the original window remains visible. Fixing
and saving the file retries automatically. Disabling effects or ending the last
session releases the watcher and GPU/capture resources. To return to bundled
shaders, unset `CANTRIP_CUA_EFFECT_SHADER` and restart the worker.

No production rendering path reads pixels back to the CPU. Development file
reading and compilation never run on the input, capture, or AppKit queues.

## Implementation review and limits

| Requirement | Implementation evidence |
| --- | --- |
| Clean video and independent cursor/effect layers | `macos/window_effects/capture.rs` uses a desktop-independent original-window filter with cursor capture disabled; `macos/overlay.rs` orders cursor panels above the separate effect panel. Monitor snapshots exclude helper-owned panels, and window snapshots retain their original filter. |
| GPU-only live image processing and bounded ownership | `gpu.rs` imports retained CoreVideo images as Metal textures; command completion releases source owners. `render.rs` replaces pending jobs and bounds in-flight GPU commands to three. No image encoding/readback occurs in this path. |
| Static-video animation and history | The active pipeline’s continuous flag schedules rendering without new source frames; history textures are separate render targets, initialized before sampling and reset on source/pipeline geometry changes. |
| Shared motion/input ABI | `effects/telemetry.rs`, `live.rs`, and `uniforms.rs` provide the versioned frame contract from the same native cursor presentation and generated input events. Unit checks cover layout, elapsed-time smoothing/decay, identity, held state, and geometry changes. |
| Settings, reconnection, and Off | Protocol validation, server migration 0202, worker heartbeat synchronization, and `computer-use/effects.ts` keep durable revisions ordered without launching a helper from settings. |
| Shader replacement and failure handling | `compiler.rs` has one latest job/result and watches the explicit local file off the input/main queues. Failed compilation preserves the active pipeline; GPU/capture errors remove the panel. Stalled drawable presentation reveals the original window while fresh rendering is retried. |
| Window/session lifecycle | The native owner matches current window ID/PID, updates position/scale, resets on resize, removes surfaces when the window leaves the on-screen inventory, and drops all resources when Off or the final attached session ends. Panel creation never activates or raises the target. |

The output format is SDR BGRA8/sRGB; this is not an HDR-preserving compositor.
Effects require macOS 14 or later. Other backends report unsupported when an
actual effect operation is attempted. Capture-protected or unavailable content
can only produce what ScreenCaptureKit supplies. Effects are presentation-only;
they do not remap the application’s input coordinates.

Window stacking, full-screen/Space transitions, visual alignment, and perceived
latency still require the manual test below. Source review and offscreen tests do
not constitute visual acceptance. The bundled cursor warp provides a first motion-sensitive effect; its visual tuning
can be adjusted in settings.

## Manual test after updating

1. Stop the current development session and restart it from the updated Primary
   checkout using the same command/profile as before (`pnpm dev` for browser dev,
   or `pnpm devtop` for desktop dev). Server startup applies migration 0202. Use
   the same profile so the configured provider/model and existing preferences
   remain available. Do not switch between these profiles for this test.
2. Open **Settings → General → Computer use**. Enable computer use if needed;
   select **Debug gradient inversion** under **Window effects**. Leave strength
   at 1 and input feedback enabled. Select the Mac worker to view its status.
3. Open the same Brave piano window with recognizable text, colors, and changing
   content. Give a Cantrip agent the prompt below. The effect begins when the
   agent attaches that window. Agent-owned sessions close at the end of the turn,
   so the prompt includes a 90-second observation period before the final reply;
   perform the window/settings checks during that period. Look for filtered live
   pixels and the animated
   **FX** badge near its upper-left corner. The separate cursor and glow should
   keep their own colors above the filter.
4. Watch cursor travel, a held click, and a drag. Velocity lines should respond
   to movement, settle while idle, and click rings should decay. Check that the
   agent’s screenshot shows original colors and no FX badge, even while you see
   the filter. Compare the two views rather than treating the agent’s claim as
   proof. Listen for notes yourself; screenshots do not prove sound.
5. Move and resize the piano window, move it between displays, partially cover
   it, minimize/restore it, and try your usual full-screen/Space transition. The
   overlay should remain aligned and behind unrelated foreground windows, or
   reveal the original window while waiting for a fresh frame. It must not
   steal focus or move your system pointer.
6. Select **Pass-through**, then **Off**. Pass-through should show the clean live
   pixels; Off should remove the full-window panel while leaving ordinary CUA
   available. Turning computer use off should stop its sessions. Ending the last
   attached session should also remove the effect. If desired, attach a second
   agent to the same window to check one shared effect with separate cursors.

Copyable agent prompt:

```text
Use Cantrip’s computer-use tools to test the existing Brave virtual-piano window.
Read the current CUA help and attach the specific application window. Use fresh
window-local coordinates from your snapshot; do not attach an entire monitor or
request focus, global input, or changes to my system pointer.

Capture the window first. Describe a few recognizable original colors and text,
and report whether your screenshot contains an “FX” badge near the upper-left.
I am testing a user-only filter; report what your actual screenshot shows.

Move your custom cursor between three visible white keys with brief pauses,
then hold one key with a pointer press for about 500 ms. Finally perform one
smooth, roughly one-second clickDrag across five adjacent white keys. Choose all
coordinates from a fresh snapshot. Do not navigate away or type into anything.

Take another screenshot. Report the target ID, window bounds, snapshot dimensions,
coordinates used, exact input receipts, and any actual errors. Distinguish input
dispatch from application acceptance. Do not claim that notes sounded or that the
physical cursor/focus remained unchanged unless you have evidence. Do not replay
uncertain input.

After the input test, keep this turn active for 90 seconds using short CUA waits
within the advertised per-call limits, plus occasional read-only snapshots, so I
can move, resize, and cover the window.
Send a brief progress message when this observation period begins. Do not issue
more input during it. If window geometry changes invalidate the attachment,
reacquire the same window for observation only. If I disable computer use or stop
the turn, respect that immediately. Otherwise detach at the end of the period
and give your final report so I can verify cleanup. Do not promise to retain an
agent-owned session after your turn ends.
```

For shader editing, use the development workflow above during an active
observation turn and intentionally introduce one syntax error, then fix it.
Request a longer observation period or another observation-only turn if needed.
The UI should report the file and line while the
last working effect remains live; saving the correction should replace it. Large
compiler diagnostics are capped at 16 KiB to protect the helper’s metadata channel.
