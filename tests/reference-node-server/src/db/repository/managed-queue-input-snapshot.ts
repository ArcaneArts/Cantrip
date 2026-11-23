import { eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { queuedPromptOpaqueContentSchema } from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import { NativeCommandError } from "./native-command-errors.js";

/** Capture the exact encrypted revision under the claim transaction. Legacy
 * plaintext queues are left for worker-side migration, never copied in clear. */
export async function retainManagedQueueInput(
  tx: RepositoryTransaction,
  claimId: string,
  prompt: typeof schema.queuedPrompts.$inferSelect,
) {
  if (!prompt.opaqueContent) return null;
  const protectedInput = queuedPromptOpaqueContentSchema.parse(
    prompt.opaqueContent,
  );
  if (protectedInput.id !== prompt.id)
    throw new NativeCommandError("queue-input-snapshot-mismatch");
  const value = {
    claimId,
    promptId: prompt.id,
    promptRevision: prompt.revision,
    protectedInput,
  };
  const [existing] = await tx
    .select()
    .from(schema.managedQueueInputSnapshots)
    .where(eq(schema.managedQueueInputSnapshots.claimId, claimId));
  if (existing) {
    if (!isDeepStrictEqual(existing, value))
      throw new NativeCommandError("queue-input-snapshot-conflict");
    return existing;
  }
  await tx.insert(schema.managedQueueInputSnapshots).values(value);
  return value;
}
