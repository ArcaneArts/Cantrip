import { managedQueueLookupResultSchema } from "@cantrip/protocol";
import { CantripApiError, request } from "./api-client";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
  type ClientSessionIdentitySnapshot,
} from "./client-session";

/** Recover an actual committed queue receipt; never replay an uncertain mutation. */
export async function requestQueueMutation(input: {
  chatId: string;
  operationId: string;
  nativeMethod:
    | "thread/queue/add"
    | "thread/queue/update"
    | "thread/queue/delete"
    | "thread/queue/reorder";
  promptId?: string;
  path: string;
  init: RequestInit;
  identity?: ClientSessionIdentitySnapshot | null;
}): Promise<unknown> {
  const identity =
    input.identity === undefined
      ? getClientSessionIdentitySnapshot()
      : input.identity;
  const behavior = {
    expectedIdentity: identity ?? undefined,
    allowCsrfRecovery: false,
  };
  try {
    return await request(input.path, input.init, behavior);
  } catch (error) {
    // A definite rejection or an explicit client cancellation is not a lost ACK.
    if (
      (error instanceof CantripApiError && error.status < 500) ||
      input.init.signal?.aborted ||
      !identity ||
      !clientSessionIdentityMatches(identity)
    )
      throw error;
    let recovered;
    try {
      recovered = managedQueueLookupResultSchema.parse(
        await request(
          `/api/chats/${encodeURIComponent(input.chatId)}/queue/operations/${encodeURIComponent(input.operationId)}`,
          undefined,
          behavior,
        ),
      );
    } catch {
      throw error;
    }
    if (
      !recovered.found ||
      recovered.receipt.operationId !== input.operationId ||
      recovered.receipt.chatId !== input.chatId ||
      recovered.receipt.method !== input.nativeMethod
    )
      throw error;
    if (recovered.receipt.status === "rejected")
      throw new CantripApiError(
        "The queue action was rejected. Refresh the queue before retrying.",
        409,
        recovered.receipt.rejectionCode,
      );
    if (recovered.receipt.status !== "applied") throw error;
    if (
      input.nativeMethod === "thread/queue/add" ||
      input.nativeMethod === "thread/queue/update"
    ) {
      const accepted = recovered.acceptedItem;
      if (
        !accepted ||
        accepted.chatId !== input.chatId ||
        (input.promptId && accepted.id !== input.promptId)
      )
        throw error;
      return accepted;
    }
    return undefined;
  }
}
