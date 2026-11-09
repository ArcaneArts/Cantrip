import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  nativeHistoryBatchRejectionSchema,
  type NativeHistoryBatchRejection,
  type NativeHistoryIngest,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import { NativeHistoryError } from "./native-history-bindings.js";

export class NativeHistoryBatchRejectionError extends NativeHistoryError {
  constructor(readonly rejection: NativeHistoryBatchRejection) {
    super(rejection.code);
  }
}

function identity(input: NativeHistoryIngest, payloadDigest: string) {
  const { batch: _batch, ...fields } = input;
  return { ...fields, payloadDigest };
}

/** Caller holds the owning chat/binding transaction lock. Check before attempting
 * canonical writes: an acknowledged rejection is permanent even if revisions move. */
export async function readNativeHistoryRejection(
  tx: RepositoryTransaction,
  input: NativeHistoryIngest,
  payloadDigest: string,
) {
  const [row] = await tx
    .select()
    .from(schema.nativeHistoryRejections)
    .where(
      and(
        eq(schema.nativeHistoryRejections.bindingId, input.bindingId),
        eq(schema.nativeHistoryRejections.recordId, input.recordId),
      ),
    );
  if (!row) return null;
  const decision = nativeHistoryBatchRejectionSchema.parse(row.decision);
  const expected = identity(input, payloadDigest);
  if (
    row.id !== decision.rejectionId ||
    Object.entries(expected).some(
      ([key, value]) => decision[key as keyof typeof expected] !== value,
    )
  )
    throw new NativeHistoryError("batch-rejection-conflict");
  return decision;
}

/** Only after the failed canonical attempt has rolled back its savepoint. This
 * records no ciphertext as committed and does not advance the stream head. */
export async function retainNativeHistoryRejection(
  tx: RepositoryTransaction,
  input: NativeHistoryIngest,
  payloadDigest: string,
  code: NativeHistoryBatchRejection["code"],
) {
  const decision = nativeHistoryBatchRejectionSchema.parse({
    ...identity(input, payloadDigest),
    rejected: true,
    rejectionId: randomUUID(),
    code,
  });
  await tx.insert(schema.nativeHistoryRejections).values({
    id: decision.rejectionId,
    bindingId: input.bindingId,
    recordId: input.recordId,
    decision,
  });
  return decision;
}
