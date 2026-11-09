/** Server-observed transport closure, not evidence that native inference ended. */
export function isNativeTransportClosure(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    "kind" in value &&
    "source" in value &&
    value.kind === "transport-ended" &&
    value.source === "worker-command"
  );
}
