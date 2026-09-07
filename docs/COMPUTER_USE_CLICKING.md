# Computer-use clicking

Implemented in the macOS Rust helper and managed `cantrip_cua` tools by merged
[PR #1761](https://github.com/ArcaneArts/Cantrip/pull/1761) (Accessibility) and
[PR #1762](https://github.com/ArcaneArts/Cantrip/pull/1762) (coordinate clicks).
All four existing CI jobs passed on #1762. On 2026-09-05, the user confirmed that
an agent inspected a Codex window, clicked a different chat and read the result.
This satisfies the bounded inspect → click → inspect acceptance condition.
Use an updated development build and worker;
an older installed app may not include these tools. No installed app, saved QA
profile, credentials or macOS permissions were changed by those initial click implementations.

## Finding the tools

Cantrip automatically manages a dedicated `cantrip_cua` MCP server for authorized
agent turns. Its `js` and `js_reset` tools use the computer-use transport for
images and turn-scoped authorization. They have a different namespace from the
general `cantrip` project tools and are not a CLI subcommand.

Start with `cantrip_cua/js` and `{"script":"await cua.targets()"}`. Discover that
exact server name if tools are deferred; do not dump every tool's full description
or restrict discovery to the `cantrip` namespace. The returned native inventory
provides the IDs and generations needed to attach an application window and take
a snapshot. Window sharing starts automatically during capture.

The ordinary `cantrip.target_list` registry and its `remote-desktop`/`remote-surface`
entries are separate. Empty lists there do not establish that native CUA is
unavailable, and creating a remote target does not fix a missing CUA tool. The
agent's thread instructions and general Cantrip MCP guidance identify this
distinction. A missing callable `cantrip_cua` tool is a registration problem;
AppleScript or shell automation is not the Cantrip CUA fallback.

## Text, keys, scrolling and drag

The current development helper adds these awaited methods on an attached
application window. They use experimental macOS window-directed native events;
they never choose global input, request activation or move/restore the human
pointer. App compatibility and actual background delivery require user testing.

```js
await cua.typeText("Hello 🦀");
await cua.keyPress("Enter");
await cua.keyPress("A", ["Meta"]); // Command+A, physical ANSI shortcut key
await cua.scroll(300, 0, { x: 200, y: 200 }); // down 300 pixels at this position
await cua.clickDrag({ x: 50, y: 100 }, { x: 250, y: 100 }); // default 200 ms
await cua.snapshot();
```

Choose and verify the intended text field first. Text attempts to reach the
application's existing keyboard responder; it does not independently select a
field or guarantee delivery to the intended window. Unicode event strings may
be ignored by some application frameworks. `typeText` accepts up to 8192 UTF-8
bytes; newline and tab produce Enter and Tab, with CRLF treated as one newline.
No clipboard is read or changed. `keyPress` accepts Enter, Tab, Escape,
Backspace, Delete, ArrowLeft/Right/Up/Down, Home, End, PageUp, PageDown, Space,
A–Z and 0–9, with optional Shift, Control, Alt and Meta (Command) modifiers.
Letters/digits describe physical ANSI shortcut keys; use `typeText` for text.

`scroll(deltaY, deltaX = 0, point?)` uses pixel deltas, positive down/right,
maximum ±10000 per axis, at the supplied position or current custom cursor.
`clickDrag(start, end, durationMs = 200)` sends one left-button hold, a linear
path at approximately 60 motion events per second, and one release. Duration
is 50–2000 ms. Desktop cursor updates follow dispatched points and retain the
current appearance; covering windows still cover this cursor. Rendering and
event scheduling are best effort. Stop releases at the last dispatched point,
without jumping to the requested endpoint. Keys also always release after down.

All four methods return `background-text`, `background-key`, `background-scroll`
or `background-drag`, with `outcome: "unknown"` and `windowDelivery: "unverified"`.
These mean the native API does not acknowledge application acceptance. Inspect
a fresh snapshot; do not claim success from the receipt or replay an uncertain
action. Protected activity records method/outcome and sampled focus effects,
without typed text in its metadata or cursor label.

### Unfocused-window mouse clicks

User testing on 2026-09-06 found that the same piano mouse press worked with
Brave focused and visible, but failed with Brave unfocused and still visible.
Keyboard notes worked unfocused. This isolates an inactive-window mouse issue;
it does not establish a permission, coordinate-scale or covered-capture failure.
Plain background mouse delivery remains unresolved for this target.

For an **explicitly requested Command-click diagnostic**, use:

```js
await cua.pointerPress({ x, y }, 150, ["Meta"]);
await cua.snapshot();
```

`pointerPress(point, holdMs = 150, modifiers = [])` supports Shift, Control,
Alt and Meta (Command on macOS), each at most once. These flags apply to the
mouse tracking/down/up pair, including release on Stop; no modifier key is
pressed in the human input stream. Keyboard events in the same timeline retain
their own flags. For `inputTimeline`, put `pointerModifiers: ["Meta"]` on the
`pointerDown` frame; its matching `pointerUp` automatically inherits the flags.
Nonempty modifiers on a frame without `pointerDown` are rejected.

Command-click is a distinct action: an application may open a link in a new tab
or alter selection. It is never silently added to ordinary clicks, never chosen
as an automatic retry, and never changes application activation or the posting
route. Published [background-click research](https://github.com/Lakr233/bgclick-rev-skill/blob/main/bgclick-rev-skill.md)
identifies this flag as an inactive-window delivery technique, but Cantrip has
now received user confirmation that a Command-modified G4 press sounded with
Brave unfocused, while sampled pointer/foreground/window order stayed unchanged.
Ordinary inactive mouse input remains unverified. Observe
sound, visible key response, foreground focus and the physical pointer. A native
`unknown` receipt still does not prove acceptance.

### Chords and explicit down/up timelines

For overlapping notes, use `keyChord`, not separate `keyPress` calls:

```js
await cua.keyChord(["C", "B", "M"], 500);
```

This posts all three key downs back-to-back in one native frame, holds them
simultaneously for 500 ms, then releases them. There is no inserted wait or worker
round trip between notes. The OS still receives individual events in order;
this is overlapping held state, not literally simultaneous hardware interrupts.
The default chord hold is 500 ms. Key names are the same as `keyPress`.

Explicit `keyDown` and `keyUp` arrays are available inside `inputTimeline`:

```js
await cua.inputTimeline([
  { atMs: 0, keyDown: ["C", "B"] },
  { atMs: 250, keyDown: ["M"] },
  { atMs: 500, keyUp: ["C", "B", "M"] },
]);
```

Times are absolute offsets from native playback start. Equal-time frames have
no deliberate gap. Within a frame, ups precede downs, allowing a held key to
release and retrigger at the same timestamp. Use a single frame for a chord.
Unlike repeated `keyPress` calls, the whole timeline crosses the worker and
native boundary once. It counts as one JavaScript host call. Scheduling remains
best effort, not sample-accurate audio.

A timeline permits 1–131,072 ordered frames over at most two hours, with up to 16
keys held at once. Downs and ups must balance. Stop/error releases only the keys
or button whose downs were actually dispatched, including cancellation partway
through a chord. Held state never escapes the native operation.

For a website piano key driven by pointer events, use:

```js
await cua.pointerPress({ x: 50, y: 100 }, 150);
```

This uses the window-directed mouse down/hold/up path rather than Accessibility
press or public process-only posting. The default hold is 150 ms. A timeline can
also contain `pointerDown: {x,y}` and `pointerUp: true`, alongside keyboard keys,
with one left mouse button held at a time. Each pointer-up uses its matching
pointer-down position. The custom cursor follows that position. There is no
global input fallback or request to activate the target.

These methods return `background-timeline`, unknown/unverified. A completed
native post does not prove the application played a note. The managed tool
returns an `inputAttempts` summary even when the final script expression is a
snapshot, plus a reminder that actual effect or sound needs observed evidence
or user confirmation. Seeing the cursor alone is not evidence of a click.

### Timed sequences in one tool call

For a user-requested sequence whose positions stay valid, several sequential
`await` calls can share one `cantrip_cua/js` script. For example, after inspecting
a stable piano keyboard and selecting the intended positions:

```js
await cua.backgroundClick({ x: 50, y: 100 });
await cua.wait(150);
await cua.backgroundClick({ x: 90, y: 100 });
await cua.wait(150);
await cua.backgroundClick({ x: 130, y: 100 });
await cua.snapshot();
```

`wait(ms)` accepts 0–10000 ms and cancels on Stop. It begins after the previous
action completes; it is not a real-time music scheduler. Scripts retain the
existing time budget, 16,384 host-call limit (including waits), and two-image limit.
Input is sequential; concurrent calls are rejected. A drag is one native macro;
a whole script is not an exclusive multi-agent window lock. Never catch an input
error to continue the sequence. Distinct preplanned actions on a stable interface
can proceed without intervening screenshots; an action dependent on a changed
layout or focus needs a new observation. This never permits automatic retries
of uncertain input.

## Custom-cursor actions (current development behavior)

Ordinary `cua.click()` acts at the custom cursor through the attached window's
Accessibility controls. `cua.click({x,y})` first updates that logical position.
The helper searches the selected window hierarchy, not the desktop under the
physical pointer. It does not request activation, window raising or system
pointer movement. There is no automatic global-input fallback.

Use `await cua.moveCursor({x,y}); await cua.click(); await cua.snapshot()` after
attaching a window in the current agent turn. Successful dispatch adds an outer
ring, center dot and `[dispatched]` label to the existing cursor appearance until
the next movement. Native click attempts that return errors retain a labelled
ring (`[failed]`, `[unsupported]`, `[cancelled]` or `[unknown]`) without the
dispatch dot in the next observation. Unknown means do not retry automatically.
The original tool error still propagates; the marker does not convert failure
into success. Requests rejected before reaching the helper or a lost helper may
have no new marker. Consult the protected activity/tool error and never treat
an older marker as evidence for the current request.
Reference-based `cua.press(reference)` also positions the marker at the control
center when its geometry is available; otherwise no location is marked. A new
reference press clears the previous marker before attempting the action.

To identify what will receive the action, call `await cua.controls({x,y})`
with the intended window-local point. It uses the same bounded, point-specific
window traversal as `click`, without moving the cursor or sending input. This
can find controls omitted from the shorter `cua.controls()` list. Inspect the
returned labels, roles and bounds, then use `cua.press(reference)` for the
intended control. A truncated result is partial; it is not proof that no other
control exists. Each inspection replaces previous transient references.

Window discovery also considers the attached application's `AXMainWindow` and
`AXFocusedWindow` references when its `AXWindows` list omits the target. Reading
these references does not focus the application. Each candidate must still
match the attached window's title and bounds; repeated references to the same
window are deduplicated and distinct matching windows remain an error.

Accessibility receipts include `control`: the selected reference, inspected
label/role and bounds revalidated before dispatch. Protected Trajectory shows
that AXPress recipient. Requested coordinates alone are not proof that the
intended sidebar item received the action. This metadata identifies dispatch;
a fresh observation is still needed to establish the application result.

The custom cursor and its feedback appear in CUA snapshots and the monitoring
preview. On macOS, the same renderer now supplies a click-through desktop panel over
the attached window. It follows target movement and ordering, stays behind
covering windows, and never becomes the key window. It is not a second hardware
pointer. Detach/session cleanup removes it; `visible:false` hides it. Desktop
presentation uses sparse 256×256 logical-pixel tiles around the cursor, labels
and trail points. Large windows do not require a full-window raster and no longer
lose their desktop cursor when their area exceeds the snapshot pixel budget.
Tiles share the observation renderer and remain clipped to the target window.

Global mouse input now requires explicit `cua.globalClick({x,y})` (or
`globalInput: true` on the low-level `input.click` request). This retains the old
activation and shared-pointer behavior. Do not use it for requests to preserve
the human pointer or act in a covered window without changing focus.

Targeted clicks require a uniquely resolved pressable control. Missing,
ambiguous or incomplete control information returns an error. Applications may
cause their own focus changes when responding to an action; `activation: false`
means Cantrip did not request activation, not that focus was measured unchanged.
Native receipts now include `effects`: pointer, foreground application,
foreground window and window-order changes sampled before and immediately after
input dispatch. Each is `changed`, `unchanged` or `unknown`, with sample start
timestamps and `sampling: "before-after-dispatch"`. These are best-effort,
non-atomic observations: unavailable evidence is unknown and does not block the
input operation. Samples cannot establish causality, rule out intervening human
activity, or exclude later asynchronous application changes. Failed operations
without a receipt have no effects measurement; do not infer unchanged state.
The protected Trajectory summary displays the sampled changes.

An explicit process-targeted coordinate attempt is now available as described
below. Covered-window user acceptance is pending;
the earlier foreground/global-click acceptance below does not satisfy it.

## Experimental background coordinate input

`await cua.backgroundClick({x,y})` (or no argument for the current logical cursor)
uses private macOS SkyLight delivery with an explicit window-local event point.
The user authorized this experimental approach after Accessibility successfully
identified the Jeff button but AXPress caused no visible application change.

The method prepares all native events and required SPI functions before posting,
then sends one window-addressed tracking event and one left-button down/up pair.
It does not activate or raise the target, warp/restore/hide the system pointer,
post through the global HID API, or send a duplicate public-process click.
Unavailable functions return unsupported before any event; there is no fallback.
The existing input authorization, worker/session ownership and queue apply.
Stop before posting cancels the gesture; a posted down always has up cleanup.

Receipts use `method:"background-coordinate"`, `outcome:"unknown"` and
`windowDelivery:"unverified"`, with sampled effects. SPI availability or a void
posting return cannot prove delivery, pointer isolation, or application success.
Observe once and report what changed; never automatically replay uncertain input.
A new user-requested click can explicitly select this method after an earlier
AX action had no visible effect. Monitor targets remain unsupported for input.

Implementation reference: [Cua's mouse delivery source](https://github.com/trycua/cua/blob/7c58a4d5b078b81f657d8e7e906712f8e3a96148/libs/cua-driver/rust/crates/platform-macos/src/input/mouse.rs).
Cantrip uses a single delivery path and does not adopt that driver's dual posting,
foreground assistance, primer clicks, or pointer restoration. Private API behavior
may change between macOS releases; support remains experimental.

The desktop panel is presentation only, never the input destination. Its pixels
use the existing appearance, trails and action labels. An unknown label still
means the intended application result must be checked. Cantrip excludes its own
panels from target inventory, CUA monitor captures and sampled application-window
ordering so presentation does not masquerade as a target or focus effect.

Native fixture checks verified desktop cursor visibility, occlusion, hide/show and
detach cleanup. After the user granted the development helper Accessibility access,
background clicks incremented an AppKit counter beneath a separate foreground
application, with unchanged sampled pointer, foreground and window order. Native
event logging confirmed the intended window and local coordinates. This does not
establish general application support. Subsequent Chromium tests received real
page input after enhanced Accessibility activation, including controlled covered
tests with unchanged pointer, foreground and ordering. Targeted coordinate input
remains unresolved for Chromium. A desktop-independent ScreenCaptureKit stream
could leave the covered page raster stale after a successful Accessibility action.
Using a display stream filtered to **only the selected window** kept that page
rendering in repeated native Chromium fixture tests. The integrated helper's
covered capture showed the changed counter and macOS sharing badge, with unchanged
sampled pointer, foreground application and existing window order. This is fixture
evidence, not general application acceptance; an AX dispatch receipt is still not
proof of a click.

The first window snapshot now starts that window-only display stream, retaining it
across subsequent observations. Full-resolution images and custom-cursor pixels
still use the existing independent-window screenshot path. The stream drains
frames without encoding or retaining them: at most 640 pixels on the longest side,
10 frames/second and three queued buffers, with audio and the system cursor off.
It never shares the other windows on the display. The desktop agent cursor remains
a separate overlay; the macOS sharing badge is system presentation, not an input
cursor or evidence that input succeeded.

Sessions attached to the same window incarnation share one stream. Closing or
detaching the last session, changing the selected window, a stopped native stream,
or 60 seconds without a snapshot releases it (idle/interruption cleanup runs every
10 seconds). Stop/revocation closes the worker-owned native session. A late startup
completion is stopped if its lease was already removed. Moving/resizing a target
or moving it to another display rebuilds the stream on the next observation.
Windows without a display intersection still attempt their independent screenshot;
covered rendering for off-screen, minimized, or other-Space windows remains
unverified. Starting/stopping sharing never activates the target or posts input.

## Explicit process-targeted coordinate attempt

`await cua.processClick()` uses the current custom cursor; passing `{x,y}` moves
it to that target-local position first. It requires an attached macOS application
window and uses the existing native-input authorization and session queue. It is
separate from Accessibility `click` and global `globalClick`; neither method
falls back to it inside the native helper. The agent may choose it for your
already-authorized click without asking you to name this API or confirm again.
Existing native-input permissions still apply. After a confirmed unsupported
action with no dispatch, it may choose another targeted method as a separate
operation; denial, Stop, revocation or uncertain dispatch never authorize that
switch. Global shared-pointer input still requires your explicit request.

Rust resolves the selected window's current identity and geometry, derives the
owning PID and native window ID, then posts one left-button down/up pair through
public `CGEventPostToPid`. Public window event fields 91/92 carry the intended
window ID. No activation, window raise, global event post, pointer restoration,
hiding or input suppression is requested. Mouse-up cleanup remains in place if
Stop arrives after mouse-down. Native control references are invalidated.

The API has no per-window delivery acknowledgement. Its return is recorded as
`method: "process-coordinate"`, `outcome: "unknown"`, and
`windowDelivery: "unverified"`. Session and Trajectory retain the intended target,
generation and coordinates. The cursor marks that **intended** action position;
it cannot establish the actual receiving window. Process routing or window fields
are not proof of delivery to that window: another window of the application may
receive the event, or the application may ignore it. Application-defined pointer,
focus and window-order effects remain unverified. Best-effort before/after effects
samples are included under the limitations described above.

Do not retry automatically or switch methods after this uncertain dispatch.
Request a fresh snapshot and assess the visible result. Covered-window support
and pointer/focus preservation require the user's observation; no native or GUI
acceptance was run by the coding agent.

Public API evidence: Apple's [process posting API](<https://developer.apple.com/documentation/coregraphics/cgevent/posttopid(_:)>)
and public [window field](https://developer.apple.com/documentation/coregraphics/cgeventfield/mouseeventwindowundermousepointer)
are declared in the macOS SDK's `CGEvent.h` / `CGEventTypes.h`. The SDK describes
process event-stream delivery; it does not promise delivery to a specified
covered window or pointer independence. No private event fields or APIs are used.

## Try it

1. Ask a Cantrip agent: “Find and attach [a harmless application window], inspect
   its pressable controls, press [a named button], then capture and describe the
   result.” The agent can use `cua.targets()`, `cua.attach(...)`, `cua.controls()`,
   `cua.press(reference)` and `cua.snapshot()` through managed JavaScript.
2. Try an explicit coordinate action: “Capture this window, single-left-click
   [a harmless position], then capture and describe the result.” This uses
   `cua.click({x,y})` to resolve a pressable control in the selected window.
   Only for expressly requested shared-pointer input use `cua.globalClick({x,y})`;
   global window clicks activate and raise the target before posting input.
3. Outside selected YOLO, expect separate native-input approval through the
   existing permission interaction. An observation or logical-cursor grant does
   not authorize input. Check the protected Trajectory for method, target,
   position, activation and outcome. Press Stop during pending approval or queued
   input: work should cancel. Stop cannot undo a completed action.

Integration testing is performed by the user. The report confirms the visible
clicking result; it does not independently verify Accessibility press, every
permission profile or Stop timing. No interactive testing was run by the coding
agent.

## Script errors and permission changes

The managed tool accepts top-level JavaScript. For discovery, send
`{"script":"await cua.targets()"}` to `cantrip_cua/js`. The last expression is
returned; do not prepend `return` or use `console.log`. A `script-syntax` error
means the script did not parse, before any host action ran. Correct the script.

The JavaScript session preserves top-level variables across calls. Reusing
`let shot` or `const shot` in another call can reject the entire evaluation
before its first host operation. Use a block for temporary bindings, for example:

```javascript
{
  const shot = await cua.snapshot();
  shot;
}
```

`script-evaluation` means evaluation failed before any computer-use host action
was dispatched. Correct the script; this is not evidence that native clicking
was rejected. The message suggests declaration collisions without exposing
private exception text. Failures after a host call retain their existing error
classification and do not claim no dispatch. Inspect the activity/receipt before
considering another action; never retry an uncertain input automatically.

Stop and permission-profile changes revoke computer-use authority for the active
turn. Send another agent message to start a new turn after changing the profile.
`js_reset` clears JavaScript state and attachment; it cannot restore revoked
authority. A syntax failure alone does not revoke authority.

The first user report after tool exposure combined a top-level-return parse
failure with a subsequent permission-profile revocation before reset. It did not
establish a helper crash. The later user report confirms successful window
inspection, clicking and inspection of the result.

## Coordinates and results

All API positions are target-local logical points. For a pixel `(px, py)` in a
resized model image, use:

```text
x = px * session.target.bounds.width / model.width
y = py * session.target.bounds.height / model.height
```

Do not add the desktop origin or multiply by display scale. Rust resolves the
current target geometry and applies its global origin. A coordinate receipt
returns both logical `position` and `globalPosition`, the method, activation and
`outcome: "dispatched"`. Global clicks can move the human system pointer.
`moveCursor` still changes only the logical agent cursor.

The teal “Agent” ring is a visual marker rendered into CUA snapshots and shown
in the CUA preview and the desktop panel for the attached window. It is not a
second macOS input pointer. Explicit global coordinate clicks use the shared system pointer; the
user observed their pointer move during the successful test. Accessibility
`press` invokes the advertised control action directly instead of posting a
mouse click. It depends on the application exposing a usable control.

A dispatch receipt does not prove the intended application change. Quartz event
posting has no success return value; macOS may suppress input. Inspect the fresh
snapshot and any actual OS error. The implementation does not gate attempts on
cached permissions or permission preflight checks.

Never automatically retry an unknown action outcome or fall back from an unknown
Accessibility press to a coordinate click. Observe the result first. Stop before
dispatch cancels both mouse events; after mouse-down, mouse-up cleanup still runs.

## Supported bounds

Accessibility discovery returns up to 32 pressable controls from at most 128
visited elements. Cursor-targeted search prunes known off-point branches and is
bounded to 512 visited elements, 128 children per node and depth 24, with bounded
roles, labels, local bounds and transient references. It never requests AX values or descends into secure fields. Native
handles stay in Rust; reinspection, target changes, detach, reset, Stop and input
retire the references. Press consumes the inspection even if it fails or its
outcome is uncertain. Inspect again when references become stale.

Before window inspection, Cantrip requests the application's enhanced
Accessibility mode when its live `AXEnhancedUserInterface` attribute reports
false. This app-provided attribute is not universally supported. Unsupported
opt-in results do not prevent ordinary inspection, and an already-enabled mode
is not toggled again. Activation can be asynchronous; neither the opt-in nor
discovery of a pressable control proves that an action changed the app.
Cantrip does not disable this shared process mode when a session ends, since
another session or assistive client may use it. It does not change system
VoiceOver settings, activate the app, or restart it with browser flags.

Window matching uses the current owning process and a unique Accessibility
window matching geometry and available title. Ambiguous matches or windows
without usable Accessibility metadata fail explicitly. Virtualized or incomplete
AX trees may omit controls. Explicit global coordinate input requires usable AX window geometry
and hit testing for application windows; covered background clicking is not
promised. Human activity can still race native focus and dispatch.

Accessibility press, single left-button coordinate clicks and the experimental
input macros above are implemented. Double/right clicks, application launching,
other OS backends and cross-worker control remain outside this tranche.

### Failed click recovery

Uncaught JavaScript host failures retain their specific error code, including
unsupported input and unknown dispatch. A failed script releases its attachment;
list targets and attach the intended window again before taking a new snapshot.
This restores observation only: do not replay or switch methods after unknown input.
Worker receipt validation accepts accessibility receipts for custom-cursor clicks,
coordinate receipts for explicit global clicks, and unknown/unverified receipts
for process clicks. A successful receipt still requires user verification of the
application result and pointer/focus behavior.

### A window click is unsupported

`control-not-found` means the completed bounded inspection found no pressable
control at that position. `control-ambiguous` means equally specific candidates
matched. `control-inspection-incomplete` means traversal reached a limit; it does
not prove the intended control is absent. All three occur before AX dispatch.

For an already-authorized click, the agent should reacquire the same application
window after the failed script, snapshot it, and select `cua.backgroundClick({x,y})`
once at the intended window-local point as a separate targeted attempt. Do not
substitute a monitor: it has neither the attached window's control hierarchy nor
its process identity. This does not authorize switching methods after unknown
input, denied permission, Stop or revocation. Window-directed delivery remains unknown;
inspect the fresh result and sampled effects without automatically replaying it.

### Window control-search limits

Targeted Accessibility lookup can traverse up to 512 distinct elements within
the existing deadline. It no longer stops solely at 24 nested wrappers or 128
siblings. Repeated elements are visited once, and a leaf at a depth boundary is
complete when reading its children confirms none. General control discovery
keeps its smaller limits. Actual omitted nodes still produce an incomplete
inspection and no AX action. This expands bounded lookup; it does not establish
that a particular application implements a usable press action.

## Full performances, live help, and explicit focus

`await cua.help()` returns the running native API version (4), method signatures,
and actual limits. On an older helper, `Object.keys(cua)` inventories its methods.
An installed update requires restarting the worker/dev session; `js_reset` only
resets JavaScript and does not replace a running helper binary.

Generate a whole preplanned score in one `inputTimeline` call: up to 131,072 frames
and two hours. A managed script allows 2 MiB of UTF-8 source, 16,384 host calls,
and 125 minutes total wall time including approvals. Generated host actions allow
15 MiB; native/control envelopes allow 16 MiB. The JS heap is 128 MiB and active
JS computation has a 10-second budget, excluding native playback waits. Output
remains 32 KiB with two model images. Do not return the entire generated score.
MCP, HTTP headers/body, and native input deadlines accommodate long playback.
These bounds do not require repeated model turns or tiny music chunks. Stop still
cancels playback and releases held input. Real-time piano QA remains user-owned.

For an explicitly authorized Command-click background route:

```js
await cua.commandClick({ x: 50, y: 100 }, 150);
```

This sends Meta on the window-directed mouse pair, never as a held keyboard key.
It does not activate the window or move the system pointer. Command can change
link and selection semantics; plain unfocused clicking is still app-dependent.
The wrapper makes the existing modified pointer path discoverable; it is not a
new claim that the target app accepted the click.

When the user permits bringing the attached window forward:

```js
await cua.requestFocus();
await cua.snapshot(); // Reacquire coordinates before choosing the next click.
```

Focus requests activation, marks that window main, and raises it via Accessibility.
It sends no mouse event and does not restore previous focus. Receipts distinguish
`focus` with `activation: true`; dispatch is not visual proof of focus. Errors
after any focus attempt remain uncertain. This method is never an implicit retry
or a substitute for background input.

## Experimental target-only AppKit preparation (API 4)

User QA established that Command-modified pointer input triggers piano notes in
unfocused Brave. Ordinary mouse input still fails. Earlier trace evidence showed
mouse events reaching the exact NSWindow but not Chromium's page input handler;
Chromium's default `acceptsFirstMouse` rejects inactive-window click-through.

`await cua.prepareWindowInput()` sends one 248-byte `SLPSPostEventRecordTo`
activation notification (type 0x0d, state 1) addressed to the attached window's
process serial number and native window ID. It changes target AppKit input state;
it sends no mouse/keyboard event, no Command flag, no WindowServer front-process
request and no window raise. It does not send a defocus notification to the human
foreground process and does not restore or cache app state. Target reactions are
not guaranteed: its internal active state and appearance can change, and actual
foreground preservation requires user QA.

The explicit `window-input` receipt reports `activation: true` to disclose the
AppKit activation request. `dispatched` acknowledges API dispatch only. Existing
before/after effects report foreground app/window, ordering and system pointer.
Errors after posting report uncertain state, never a safe-to-retry failure.
The ordinary mouse methods and Command-click route are unchanged.

Test after restarting the development worker:

1. Keep Brave visible but another application focused.
2. Attach the exact piano window and call `await cua.prepareWindowInput()` once.
3. Inspect the receipt/effects. If foreground or window order changed, stop and
   report it. If it fails, send no click.
4. Take a fresh snapshot, locate a white key, then call
   `await cua.pointerPress({x, y}, 1000)` once with no modifiers.
5. Report both receipts and whether the note sounded, pointer/focus changed,
   or the target began displaying active-window controls. Do not retry.

This is an explicit experimental route, not an implicit focus workaround. The
candidate differs from the full activation recipes by deliberately leaving the
foreground process alone. Its effectiveness remains for user validation.

Implementation references (source, not instructions):
[Chromium inactive mouse handling](https://github.com/chromium/chromium/blob/main/content/app_shim_remote_cocoa/render_widget_host_view_cocoa.mm),
[CUA driver's AppKit event records](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/platform-macos/src/input/skylight.rs),
and [yabai window events](https://github.com/koekeishiya/yabai/blob/master/src/window_manager.c).

## Combined preparation and ordinary press (API 5)

The API 4 user trial above failed: the cursor appeared and Brave remained
unfocused, but no note sounded. Its receipts place preparation about 11 seconds
before mouse-down. Do not repeat that trial or treat preparation dispatch as
proof of active input state.

`await cua.preparedPointerPress({x,y},1000)` is a distinct experimental timing
candidate. The helper allocates and addresses the tracking/down/up events first,
then queues target-only preparation followed immediately by one unmodified press
in the same native request. There is no model round trip, extra/primer click,
Command flag, foreground request, window raise, or prior-app deactivation.
The default hold is 150 ms, with explicit holds from 1 to 2000 ms. Ordinary
`pointerPress`, keyboard timelines, and explicit Command-click are unchanged.

Preparation failure prevents the press. After preparation is dispatched, any
subsequent error is uncertain; Stop releases the button if down began. Success
returns method `background-prepared-press`, `activation: true`, `outcome: unknown`
and `windowDelivery: unverified`, with before/after effects. The activation field
discloses the request, not proof that focus changed. AppKit can react to the
notification; foreground preservation and actual acceptance still require QA.

Test with API 5 after restarting the development worker: keep the piano window
unfocused, attach its current window ID/generation, and take a fresh snapshot.
Choose a white key, then call `preparedPointerPress(point,1000)` exactly once.
Report its receipt and whether a note sounded, the custom cursor appeared, or
physical pointer/focus/window order changed. Do not separately prepare, add
modifiers, request focus, or retry. No native integration test has established
that this timing candidate works.

Source inspection also distinguishes application activation from the target
window's key state. On the inspected macOS build, AppKit's left-mouse handler
checks key-window state and `acceptsFirstMouse`; this supports the inactive-window
hypothesis but does not identify the branch taken in the user's trial. The
reference "make key" records carry a Command modifier and are synthetic mouse
records, so they are not an unmodified-click solution and are not used here.
