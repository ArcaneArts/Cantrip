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
  "permission-denied",
] as const;
export type CuaNativeErrorCode = (typeof CUA_NATIVE_ERROR_CODES)[number];

const targetedRecovery =
  " For this already-authorized click, reacquire the same application window, snapshot it, and use await cua.backgroundClick({x,y}) once at the intended window-local point as a separate targeted attempt if no earlier input has an unknown outcome. Do not retry against a monitor: monitors do not provide window controls or process routing. No global fallback was attempted. Window-directed delivery is unverified; inspect a fresh snapshot and sampled effects without replaying uncertain input.";

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
    "JavaScript evaluation failed before any computer-use host action was dispatched. Persistent top-level let/const bindings cannot be redeclared. Use a block { ... } for temporary variables or choose fresh names, then correct the script. This is not a native click rejection.",
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
