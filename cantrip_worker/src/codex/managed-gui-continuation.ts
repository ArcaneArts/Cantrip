import { createHash } from "node:crypto";
import type {
  NativeCommandAdmissionResult,
  NativeCommandContinuation,
  NativeCommandReceipt,
  NativeCommandSession,
} from "@cantrip/protocol";
import type { NativeCommandClient } from "../native-command-client.js";
import { protectNativeCommandContent } from "../native-command-content.js";
import {
  CodexNativeRpcError,
  CodexTurnFailureError,
  type RunAgentTurnRetry,
} from "./app-server.js";

/** Derive retry evidence from an actual native failure, never an error-message guess. */
export function managedGuiRetryEvidence(
  retry: RunAgentTurnRetry,
  runtimeGeneration: string,
): NativeCommandContinuation["failure"] {
  if (
    retry.error instanceof CodexTurnFailureError &&
    retry.error.threadId === retry.threadId &&
    retry.error.turnId === retry.turnId
  ) {
    return {
      kind: "native-terminal",
      nativeTurnId: retry.error.turnId,
      runtimeGeneration,
    };
  }
  if (
    retry.error instanceof CodexNativeRpcError &&
    (retry.error.requestMethod === "thread/resume" ||
      retry.error.requestMethod === "turn/start")
  ) {
    return {
      kind: "native-rejected",
      method: retry.error.requestMethod,
      code: retry.error.nativeError.code,
      runtimeGeneration,
    };
  }
  throw retry.error;
}

/** A new native attempt retains the logical GUI request and reserves fresh authority. */
export async function admitManagedGuiContinuation(input: {
  client: Pick<NativeCommandClient, "continueExecution" | "settle">;
  encryption: Parameters<typeof protectNativeCommandContent>[0]["service"];
  root: NativeCommandReceipt;
  previous: NativeCommandReceipt;
  session: NativeCommandSession;
  retry: RunAgentTurnRetry;
  payload: unknown;
  handoff?: NativeCommandContinuation["handoff"];
  /** Record committed authority before checking an abort that raced with the response. */
  onAdmitted(grant: NativeCommandAdmissionResult): void;
}): Promise<NativeCommandAdmissionResult> {
  const { retry, previous, root, session } = input;
  retry.signal.throwIfAborted();
  if (
    retry.operationGeneration !== previous.operationGeneration ||
    !session.runtimeGeneration ||
    session.connectionId !== `gui:${root.operationGeneration}`
  )
    throw new Error("The GUI retry belongs to a replaced execution.");
  const failure = managedGuiRetryEvidence(retry, session.runtimeGeneration);
  // One stable successor per predecessor, including a retried admission request.
  const operationId = `gui-retry:${createHash("sha256")
    .update(JSON.stringify([root.operationId, previous.operationGeneration]))
    .digest("hex")}`;
  const protectedInput = await protectNativeCommandContent({
    service: input.encryption,
    context: { chatId: session.chatId, operationId, direction: "request" },
    content: input.payload,
  });
  retry.signal.throwIfAborted();
  // Do not abort this short transaction's fetch: cancellation is not evidence
  // that the server failed to commit. Retain the returned exact generation.
  const grant = await input.client.continueExecution({
    rootOperationId: root.operationId,
    previousOperationId: previous.operationId,
    previousOperationGeneration: previous.operationGeneration,
    operationId,
    payloadDigest: protectedInput.digest,
    protectedPayload: protectedInput.envelope,
    session,
    reason: retry.reason,
    failure,
    ...(input.handoff ? { handoff: input.handoff } : {}),
  });
  input.onAdmitted(grant);
  if (retry.signal.aborted) {
    await input.client.settle({
      operationId: grant.receipt.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      status: "rejected",
      resultDigest: null,
      protectedResult: null,
      rejectionCode: "cancelled-before-dispatch",
      executionComplete: false,
    });
    retry.signal.throwIfAborted();
  }
  if (grant.receipt.status !== "accepted" || !grant.execution)
    throw new Error("The GUI retry no longer has an admitted execution.");
  return grant;
}
