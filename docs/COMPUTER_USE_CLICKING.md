# Computer-use clicking

Implemented in the macOS Rust helper and managed `cantrip_cua` tools by merged
[PR #1761](https://github.com/ArcaneArts/Cantrip/pull/1761) (Accessibility) and
[PR #1762](https://github.com/ArcaneArts/Cantrip/pull/1762) (coordinate clicks).
All four existing CI jobs passed on #1762. On 2026-09-05, the user confirmed that
an agent inspected a Codex window, clicked a different chat and read the result.
This satisfies the bounded inspect → click → inspect acceptance condition.
Use an updated development build and worker;
an older installed app may not include these tools. No installed app, saved QA
profile, credentials or macOS permissions were changed by this implementation.

## Custom-cursor actions (current development behavior)

Ordinary `cua.click()` acts at the custom cursor through the attached window's
Accessibility controls. `cua.click({x,y})` first updates that logical position.
The helper searches the selected window hierarchy, not the desktop under the
physical pointer. It does not request activation, window raising or system
pointer movement. There is no automatic global-input fallback.

Use `await cua.moveCursor({x,y}); await cua.click(); await cua.snapshot()` after
attaching a window in the current agent turn. Successful dispatch adds an outer
ring and center dot to the existing cursor appearance until the next movement.
Reference-based `cua.press(reference)` also positions the marker at the control
center when its geometry is available.

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

Process-targeted coordinate delivery remains work for the pointer-preserving
goal. Covered-window user acceptance is pending;
the earlier foreground/global-click acceptance below does not satisfy it.

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
`outcome: "dispatched"`. Native clicks can move the human system pointer.
`moveCursor` still changes only the logical agent cursor.

The teal “Agent” ring is a visual marker rendered into CUA snapshots and shown
in the CUA preview. It is not a second macOS input pointer or a floating cursor
over other applications. Coordinate clicks use the shared system pointer; the
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

Window matching uses the current owning process and a unique Accessibility
window matching geometry and available title. Ambiguous matches or windows
without usable Accessibility metadata fail explicitly. Virtualized or incomplete
AX trees may omit controls. Explicit global coordinate input requires usable AX window geometry
and hit testing for application windows; covered background clicking is not
promised. Human activity can still race native focus and dispatch.

Only Accessibility press and single left-button coordinate clicks are supported.
Double/right clicks, drag, scroll, keyboard/text entry, application launching,
other OS backends and cross-worker control remain outside this tranche.
