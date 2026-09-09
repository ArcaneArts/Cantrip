import {
  nativeHistoryBatchRejectionSchema,
  nativeHistoryIngestSchema,
  type NativeHistoryBatchRejection,
} from "@cantrip/protocol";
import { CantripServerRequestError } from "./cli-client.js";
import { nativeHistoryBatchPayloadDigest } from "./native-history-batch-archive.js";

/** Only a matched authenticated server response may instantiate this decision.
 * A network failure or ordinary 409 is never proof of permanent nonacceptance. */
export class NativeHistoryBatchRejectedError extends CantripServerRequestError {
  constructor(readonly rejection: NativeHistoryBatchRejection) {
    super("Native history batch was durably rejected.", 409, rejection.code);
  }
}

export function verifyNativeHistoryRejection(
  raw: unknown,
  rawRequest: unknown,
  code: unknown,
) {
  const rejection = nativeHistoryBatchRejectionSchema.parse(raw);
  const { batch, ...request } = nativeHistoryIngestSchema.parse(rawRequest);
  if (
    code !== rejection.code ||
    Object.entries(request).some(
      ([key, value]) => rejection[key as keyof typeof request] !== value,
    ) ||
    rejection.payloadDigest !==
      nativeHistoryBatchPayloadDigest(batch, request.previousDigest)
  )
    throw new Error("Native history returned an unrelated batch rejection.");
  return rejection;
}

export function nativeHistoryRejectionError(
  raw: unknown,
  request: unknown,
  code: unknown,
) {
  return new NativeHistoryBatchRejectedError(
    verifyNativeHistoryRejection(raw, request, code),
  );
}
