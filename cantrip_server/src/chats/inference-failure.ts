import { WorkerCommandError } from "../workers/bridge.js";

/** Only the actual worker response can prove a failed attempt is replayable.
 * Timeouts/disconnects, message regexes and absent activity cannot mint proof. */
export function workerFailureAllowsRetry(
  error: unknown,
  expected: {
    workerId: string;
    chatId: string;
    messageId: string;
    providerId: string;
  },
): boolean {
  if (
    !(error instanceof WorkerCommandError) ||
    error.operation !== "chat.turn" ||
    error.workerId !== expected.workerId ||
    !error.requestId ||
    error.code === "worker-command-timeout"
  )
    return false;
  const proof = error.inference;
  return Boolean(
    proof &&
    proof.chatId === expected.chatId &&
    proof.messageId === expected.messageId &&
    proof.providerId === expected.providerId,
  );
}
