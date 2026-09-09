import { and, eq } from "drizzle-orm";
import type {
  NativeHistoryBinding,
  NativeHistoryTurn,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import { NativeHistoryError } from "./native-history-bindings.js";
import { nativeHistoryPayloadDigest } from "./native-history-digest.js";

/** Called only inside the binding-locked canonical ingestion transaction. */
export async function persistNativeHistoryTurns(
  tx: RepositoryTransaction,
  binding: NativeHistoryBinding,
  turns: NativeHistoryTurn[],
): Promise<void> {
  for (const turn of turns) {
    if (turn.threadId !== binding.threadId)
      throw new NativeHistoryError("turn-thread-mismatch");
    const key = and(
      eq(schema.nativeHistoryTurns.bindingId, binding.id),
      eq(schema.nativeHistoryTurns.turnId, turn.turnId),
    );
    const [existing] = await tx
      .select()
      .from(schema.nativeHistoryTurns)
      .where(key);
    const payloadDigest = nativeHistoryPayloadDigest(turn);
    if (existing) {
      if (turn.revision < existing.revision) continue;
      if (turn.revision === existing.revision) {
        if (existing.payloadDigest !== payloadDigest)
          throw new NativeHistoryError("turn-revision-conflict");
        continue;
      }
      // An older snapshot may arrive after terminal live evidence. It cannot
      // resurrect that turn, even if journaled later. Do not advance the saved
      // content revision for rejected state: later terminal enrichment remains
      // eligible. The batch receipt still acknowledges the observed stale input.
      if (existing.status !== "inProgress" && turn.status === "inProgress")
        continue;
    }
    const saved = {
      bindingId: binding.id,
      turnId: turn.turnId,
      revision: turn.revision,
      ordinal: turn.ordinal,
      status: turn.status,
      // Nullable evidence stays nullable; never manufacture timing from receipt
      // or database timestamps. Late terminal metadata may enrich the same turn.
      startedAtMs: turn.startedAtMs,
      completedAtMs: turn.completedAtMs,
      metadata: turn.metadata,
      payloadDigest,
    };
    if (existing)
      await tx.update(schema.nativeHistoryTurns).set(saved).where(key);
    else await tx.insert(schema.nativeHistoryTurns).values(saved);
  }
}
