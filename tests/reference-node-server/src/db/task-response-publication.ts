import type { TaskMessageOpaqueContent } from "@cantrip/protocol/tasks";

/** A legacy assigned publisher or the exact physical root output namespace.
 * Source ownership and dispatch fences remain the caller's responsibility. */
export function taskResponsePublicationKind(
  message: TaskMessageOpaqueContent,
  publication: { id?: string; idempotencyKey: string },
  result: { threadId: string; turnId?: string },
  execution?: { threadId: string; turnId: string } | null,
): "assigned" | "native-root" | null {
  if (
    message.idempotencyKey === publication.idempotencyKey &&
    (!publication.id || message.id === publication.id)
  )
    return "assigned";
  if (
    !execution ||
    !result.turnId ||
    result.threadId !== execution.threadId ||
    result.turnId !== execution.turnId
  )
    return null;
  const prefixes = [
    `agent-message:${result.turnId}:${result.threadId}:${result.turnId}:`,
    `agent-message:root:${result.turnId}:`,
  ];
  return prefixes.some(
    (prefix) =>
      message.idempotencyKey.startsWith(prefix) &&
      message.idempotencyKey.length > prefix.length,
  )
    ? "native-root"
    : null;
}
