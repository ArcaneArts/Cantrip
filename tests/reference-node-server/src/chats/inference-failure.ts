import { WorkerCommandError } from "../workers/bridge.js";

/** Only correlated worker responses carry execution proof. Observation failures do not. */
export function workerInferenceFailure(error: unknown):
  | {
      workerId: string;
      evidence: import("@cantrip/protocol").InferenceFailureEvidence;
    }
  | undefined {
  if (
    !(error instanceof WorkerCommandError) ||
    error.operation !== "chat.turn" ||
    !error.workerId ||
    !error.requestId ||
    error.code === "worker-command-timeout" ||
    !error.inference
  )
    return;
  return { workerId: error.workerId, evidence: error.inference };
}

/** Safe output/dispatch evidence supplements, rather than replaces, input authority. */
export function workerFailureAllowsRetry(
  error: unknown,
  expected: {
    workerId: string;
    chatId: string;
    messageId: string;
    providerId: string;
  },
): boolean {
  const failure = workerInferenceFailure(error);
  return Boolean(
    failure &&
    failure.workerId === expected.workerId &&
    failure.evidence.chatId === expected.chatId &&
    failure.evidence.messageId === expected.messageId &&
    failure.evidence.providerId === expected.providerId,
  );
}
