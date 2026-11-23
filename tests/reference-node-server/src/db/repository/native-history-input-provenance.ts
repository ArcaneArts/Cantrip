import { and, eq, sql } from "drizzle-orm";
import {
  nativeCommandSessionSchema,
  type NativeHistoryBinding,
  type NativeHistoryResolve,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import { findObservedNativeInputTurn } from "./native-command-turns.js";
import { NativeHistoryError } from "./native-history-bindings.js";

type Association = NativeHistoryResolve["items"][number]["association"];
type Candidate = {
  association: Extract<Association, { kind: "command-input" | "queue-input" }>;
  command: typeof schema.nativeCommands.$inferSelect;
};

/** Called under the authenticated historical binding/chat lock. A client ID
 * finds candidates; actual admitted command/turn evidence decides the alias.
 * The original worker remains on the command, not replaced by the reader. */
export async function resolveObservedNativeInput(
  tx: RepositoryTransaction,
  ownerId: string,
  binding: NativeHistoryBinding,
  item: NativeHistoryResolve["items"][number],
): Promise<Association> {
  if (item.association.kind !== "observed-input") return item.association;
  if (
    item.identity.component !== "user" ||
    item.identity.identityKind !== "canonical"
  )
    throw new NativeHistoryError("observed-input-component-mismatch");
  const clientId = item.association.clientUserMessageId;
  const candidates: Candidate[] = [];
  if (clientId.startsWith("cantrip:")) {
    const commands = await tx
      .select()
      .from(schema.nativeCommands)
      .where(
        and(
          eq(schema.nativeCommands.ownerId, ownerId),
          eq(schema.nativeCommands.chatId, binding.chatId),
          eq(
            schema.nativeCommands.logicalClientMessageId,
            clientId.slice("cantrip:".length),
          ),
        ),
      );
    for (const command of commands) {
      if (command.kind !== "start" && command.method !== "turn/steer") continue;
      candidates.push({
        command,
        association: {
          kind: "command-input",
          operationId: command.operationId,
          operationGeneration: command.operationGeneration,
          clientUserMessageId: clientId,
        },
      });
    }
  }
  // Correlation fields are structural metadata; encrypted prompt content stays
  // opaque. Old claims may use their still-exact prompt revision as evidence.
  const protectedInput = sql`coalesce(${schema.managedQueueInputSnapshots.protectedInput}, ${schema.queuedPrompts.opaqueContent})`;
  const queue = await tx
    .select({
      claim: schema.managedQueueClaims,
      command: schema.nativeCommands,
    })
    .from(schema.managedQueueClaims)
    .innerJoin(
      schema.nativeCommands,
      and(
        eq(
          schema.nativeCommands.operationId,
          schema.managedQueueClaims.operationId,
        ),
        eq(
          schema.nativeCommands.operationGeneration,
          schema.managedQueueClaims.operationGeneration,
        ),
      ),
    )
    .leftJoin(
      schema.managedQueueInputSnapshots,
      eq(
        schema.managedQueueInputSnapshots.claimId,
        schema.managedQueueClaims.id,
      ),
    )
    .leftJoin(
      schema.queuedPrompts,
      and(
        eq(schema.queuedPrompts.id, schema.managedQueueClaims.promptId),
        eq(
          schema.queuedPrompts.revision,
          schema.managedQueueClaims.promptRevision,
        ),
      ),
    )
    .where(
      and(
        eq(schema.managedQueueClaims.chatId, binding.chatId),
        eq(schema.nativeCommands.ownerId, ownerId),
        eq(schema.nativeCommands.chatId, binding.chatId),
        eq(schema.managedQueueClaims.awaitingGoal, false),
        sql`(${protectedInput} IS NULL OR coalesce(${protectedInput} ->> 'nativeClientUserMessageId', 'cantrip:' || (${protectedInput} -> 'pendingMessage' ->> 'id')) = ${clientId})`,
      ),
    );
  for (const { claim, command } of queue)
    candidates.push({
      command,
      association: {
        kind: "queue-input",
        operationId: command.operationId,
        operationGeneration: command.operationGeneration,
        claimId: claim.id,
        promptRevision: claim.promptRevision,
        clientUserMessageId: clientId,
      },
    });
  const matches: Candidate[] = [];
  let unobserved = false;
  for (const candidate of candidates) {
    const session = nativeCommandSessionSchema.parse(
      candidate.command.identity,
    );
    if (
      session.threadId !== binding.threadId ||
      session.chatId !== binding.chatId
    )
      continue;
    const turn = await findObservedNativeInputTurn(tx, candidate.command);
    if (!turn) {
      unobserved = true;
      continue;
    }
    if (
      turn.chatId !== binding.chatId ||
      turn.threadId !== binding.threadId ||
      turn.turnId !== item.identity.turnId ||
      turn.runtimeGeneration !== session.runtimeGeneration
    )
      continue;
    matches.push(candidate);
  }
  // A queue-backed command may also carry its logical GUI ID. Its retained
  // queue revision is the stronger association; never reserve it twice.
  const queueOperations = new Set(
    matches
      .filter((entry) => entry.association.kind === "queue-input")
      .map((entry) => entry.command.operationId),
  );
  const chosen = matches.filter(
    (entry) =>
      entry.association.kind === "queue-input" ||
      !queueOperations.has(entry.command.operationId),
  );
  if (chosen.length > 1)
    throw new NativeHistoryError("input-provenance-ambiguous");
  if (chosen.length === 1) return chosen[0]!.association;
  if (unobserved) throw new NativeHistoryError("input-provenance-unobserved");
  if (candidates.length)
    throw new NativeHistoryError("input-provenance-turn-mismatch");
  if (clientId.startsWith("cantrip:"))
    throw new NativeHistoryError("input-provenance-unavailable");
  // An unmanaged/native client ID with no Cantrip input record has no GUI alias.
  return { kind: "native" };
}
