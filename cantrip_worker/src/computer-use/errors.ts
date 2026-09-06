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
  "protocol-version",
  "capacity",
  "cancelled",
  "unsupported",
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

const nativeMessages: Record<CuaNativeErrorCode, string> = {
  "invalid-request": "The computer-use process rejected the request.",
  "script-syntax":
    "Invalid JavaScript syntax. Use top-level await and a final expression, such as await cua.targets(); do not use a top-level return. Correct the script before trying again.",
  "protocol-version": "The computer-use protocol version is unsupported.",
  capacity: "The computer-use operation exceeded a runtime limit.",
  cancelled: "The computer-use operation was cancelled by the runtime.",
  unsupported: "The computer-use operation is unavailable on this runtime.",
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
