export type CuaProcessErrorCode =
  | "spawn-failed"
  | "process-exited"
  | "transport-failed"
  | "protocol-error"
  | "capacity"
  | "invalid-request"
  | "cancelled"
  | "timeout"
  | "closed";

export type CuaRequestOutcome = "not-sent" | "unknown";

const messages: Record<CuaProcessErrorCode, string> = {
  "spawn-failed": "The computer-use executable could not be launched.",
  "process-exited": "The computer-use process exited unexpectedly.",
  "transport-failed": "The computer-use process connection failed.",
  "protocol-error":
    "The computer-use process returned an invalid protocol message.",
  capacity: "The computer-use process has too many outstanding requests.",
  "invalid-request":
    "The computer-use request is invalid or exceeds its limit.",
  cancelled: "The computer-use request was cancelled.",
  timeout: "The computer-use request exceeded its deadline.",
  closed: "The computer-use process connection is closed.",
};

/** Safe to expose: never includes script text, paths, native stderr, or target data. */
export class CuaProcessError extends Error {
  readonly name = "CuaProcessError";

  constructor(
    public readonly code: CuaProcessErrorCode,
    public readonly outcome: CuaRequestOutcome = "unknown",
  ) {
    super(messages[code]);
  }
}

export const CUA_NATIVE_ERROR_CODES = [
  "invalid-request",
  "script-syntax",
  "script-evaluation",
  "script-action",
  "protocol-version",
  "capacity",
  "cancelled",
  "unsupported",
  "control-not-found",
  "control-ambiguous",
  "control-inspection-incomplete",
  "session-not-found",
  "ownership-mismatch",
  "target-not-found",
  "stale-target",
  "stale-element",
  "input-unknown",
  "input-failed",
  "capture-failed",
  "capture-inventory-timeout",
  "capture-image-timeout",
  "permission-denied",
] as const;
export type CuaNativeErrorCode = (typeof CUA_NATIVE_ERROR_CODES)[number];

const targetedRecovery =
  " For this already-authorized click, reacquire the same application window, snapshot it, and use await cua.click({x,y}) once at the intended window-local point as a separate targeted attempt if no earlier input has an unknown outcome. Do not retry against a monitor: monitors do not provide window controls or process routing. No global fallback was attempted. Window-directed delivery is unverified; inspect a fresh snapshot and sampled effects without replaying uncertain input.";

export function isCuaUnsupportedCode(code: string | null): boolean {
  return (
    code === "unsupported" ||
    code === "control-not-found" ||
    code === "control-ambiguous" ||
    code === "control-inspection-incomplete"
  );
}

const nativeMessages: Record<CuaNativeErrorCode, string> = {
  "invalid-request": "The computer-use process rejected the request.",
  "script-syntax":
    "Invalid JavaScript syntax. Use top-level await and a final expression, such as await cua.targets(); do not use a top-level return. Correct the script before trying again.",
  "script-evaluation":
    "JavaScript evaluation failed in the script, not necessarily in native input. Check window matching and ordinary JavaScript errors; use cua.findWindows({application,title}) with a partial title because window titles can change (for example an audio indicator). Persistent top-level let/const bindings cannot be redeclared; use a block { ... } for temporary variables. Earlier host operations may have completed; do not replay input based on this error.",
  "script-action":
    "Invalid CUA method arguments; that action was not dispatched. Read cua.help('key') or cua.help('mouse') for signatures. Letter keys accept either case. Command-K: keyPress('k', ['Meta']) or keyChord(['k'], 500, ['Meta']). Mouse timeline example: [{atMs:0,pointerDown:{x:100,y:200}},{atMs:150,pointerUp:true}]. pointerUp must be true, not a point or button object; keyDown/keyUp must be arrays. Earlier actions in the script may have completed.",
  "protocol-version": "The computer-use protocol version is unsupported.",
  capacity: "The computer-use operation exceeded a runtime limit.",
  cancelled: "The computer-use operation was cancelled by the runtime.",
  unsupported:
    "The target or action is unsupported. Targeted click and processClick require an application window, not a monitor. An unsupported error does not establish that the app has no Accessibility controls. After a confirmed no-dispatch rejection, choose the available targeted method under existing native-input authorization; never change methods after uncertain input or denial. No global input fallback was attempted.",
  "control-not-found":
    "Window inspection found no pressable control at this cursor position. No Accessibility action was dispatched." +
    targetedRecovery,
  "control-ambiguous":
    "Window inspection found equally specific pressable controls at this cursor position. No Accessibility action was dispatched." +
    targetedRecovery,
  "control-inspection-incomplete":
    "Window inspection reached its bounded traversal limit. This does not prove the desired control is absent. No Accessibility action was dispatched." +
    targetedRecovery,
  "session-not-found": "The computer-use session no longer exists.",
  "ownership-mismatch":
    "The computer-use session belongs to another execution context.",
  "target-not-found": "The selected computer-use target no longer exists.",
  "stale-target": "The selected computer-use target changed.",
  "stale-element": "The control reference is stale; inspect controls again.",
  "input-unknown":
    "Input outcome is unknown. Do not retry or fall back; take a fresh snapshot to inspect the result.",
  "input-failed": "The native input request failed before dispatch.",
  "capture-inventory-timeout":
    "macOS did not finish enumerating the capture target within 10 seconds. No screenshot was produced; this does not establish input failure. Request another observation without replaying prior input.",
  "capture-image-timeout":
    "macOS found the target but did not finish producing screenshot pixels within 10 seconds. This does not establish input failure. Request another observation without replaying prior input.",
  "capture-failed":
    "The computer-use process could not capture the selected target.",
  "permission-denied": "The operating system denied computer-use permission.",
};

/** An authoritative operation error, distinct from failure of the transport. */
export class CuaNativeError extends Error {
  readonly name = "CuaNativeError";

  constructor(public readonly code: CuaNativeErrorCode) {
    super(nativeMessages[code]);
  }
}
