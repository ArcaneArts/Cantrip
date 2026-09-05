# Computer-use clicking

Implemented in the macOS Rust helper and managed `cantrip_cua` tools. User
integration acceptance is pending. Use an updated development build and worker;
an older installed app may not include these tools. No installed app, saved QA
profile, credentials or macOS permissions were changed by this implementation.

## Try it

1. Ask a Cantrip agent: “Find and attach [a harmless application window], inspect
   its pressable controls, press [a named button], then capture and describe the
   result.” The agent can use `cua.targets()`, `cua.attach(...)`, `cua.controls()`,
   `cua.press(reference)` and `cua.snapshot()` through managed JavaScript.
2. Try an explicit coordinate action: “Capture this window, single-left-click
   [a harmless position], then capture and describe the result.” This uses
   `cua.click({x,y})`. Window clicks activate and raise the attached window and
   verify that it owns the position before posting input. Monitor clicks act
   within that selected monitor.
3. Outside selected YOLO, expect separate native-input approval through the
   existing permission interaction. An observation or logical-cursor grant does
   not authorize input. Check the protected Trajectory for method, target,
   position, activation and outcome. Press Stop during pending approval or queued
   input: work should cancel. Stop cannot undo a completed action.

Integration testing is yours; these steps have not been performed by the agent.

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

A dispatch receipt does not prove the intended application change. Quartz event
posting has no success return value; macOS may suppress input. Inspect the fresh
snapshot and any actual OS error. The implementation does not gate attempts on
cached permissions or permission preflight checks.

Never automatically retry an unknown action outcome or fall back from an unknown
Accessibility press to a coordinate click. Observe the result first. Stop before
dispatch cancels both mouse events; after mouse-down, mouse-up cleanup still runs.

## Supported bounds

Accessibility inspection returns up to 32 pressable controls from at most 128
visited elements, with bounded roles, labels, local bounds and transient
references. It never requests AX values or descends into secure fields. Native
handles stay in Rust; reinspection, target changes, detach, reset, Stop and input
retire the references. Press consumes the inspection even if it fails or its
outcome is uncertain. Inspect again when references become stale.

Window matching uses the current owning process and a unique Accessibility
window matching geometry and available title. Ambiguous matches or windows
without usable Accessibility metadata fail explicitly. Virtualized or incomplete
AX trees may omit controls. Coordinate input requires usable AX window geometry
and hit testing for application windows; covered background clicking is not
promised. Human activity can still race native focus and dispatch.

Only Accessibility press and single left-button coordinate clicks are supported.
Double/right clicks, drag, scroll, keyboard/text entry, application launching,
other OS backends and cross-worker control remain outside this tranche.
