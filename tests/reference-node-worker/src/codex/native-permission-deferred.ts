const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Recognize the pinned native no-input-consumed contract, never an error
 * message or timeout. An uncertain start is not permission to submit again. */
export function isNativePermissionDeferred(
  method: string,
  frame: unknown,
): boolean {
  if (method !== "turn/start" || !object(frame) || !object(frame.error))
    return false;
  const error = frame.error;
  return (
    error.code === -32001 &&
    object(error.data) &&
    error.data.reason === "pendingSettings" &&
    error.data.inputConsumed === false
  );
}

export class NativePermissionDeferredError extends Error {
  constructor() {
    super(
      "Native input was not consumed because a permission transition is pending.",
    );
    this.name = "NativePermissionDeferredError";
  }
}

/** The native start consumed nothing, but canonical ownership may be unresolved. */
export class NativePermissionRetentionError extends Error {
  constructor(
    readonly queueRetention: "notRetained" | "uncertain",
    readonly clientUserMessageId: string | undefined,
    cause: unknown,
  ) {
    super("Deferred input retention could not be confirmed.", { cause });
    this.name = "NativePermissionRetentionError";
  }
}
