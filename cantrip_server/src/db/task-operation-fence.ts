import type { TaskDispatchFence } from "@cantrip/protocol/task-scheduling";
import { and, desc, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import * as schema from "./schema.js";
import { TaskDispatchConflictError } from "./task-dispatch.js";

export type TaskOperationLeaseFence = {
  kind: "leased";
  lease: TaskDispatchFence;
};
export type TaskOperationDispatchFence =
  | TaskOperationLeaseFence
  | {
      kind: "expired";
      cycleId: string;
      operationId: string;
      fencingToken: number;
    };

/** Lock actual dispatch authority in the transaction that writes its round.
 * A successful heartbeat before this transaction cannot fence a later write. */
export async function assertTaskOperationDispatchFence(
  transaction: PgDatabase<PgQueryResultHKT, typeof schema>,
  ownerId: string,
  chatId: string,
  operationId: string,
  expected: TaskOperationDispatchFence,
  association = false,
): Promise<void> {
  const fail = (): never => {
    throw new TaskDispatchConflictError(
      "The Task dispatch lease is stale or no longer active.",
      "stale-lease",
    );
  };
  const fence = expected.kind === "leased" ? expected.lease : expected;
  if (fence.operationId !== operationId) fail();
  // Same owner lock as claim/enqueue. Hold it and the cycle row through the
  // round mutation, so recovery cannot replace this authority between them.
  const [owner] = await transaction
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, ownerId))
    .for("update")
    .limit(1);
  if (!owner) fail();
  const [cycle] = await transaction
    .select()
    .from(schema.taskDispatchCycles)
    .where(
      and(
        eq(schema.taskDispatchCycles.id, fence.cycleId),
        eq(schema.taskDispatchCycles.ownerId, ownerId),
        eq(schema.taskDispatchCycles.chatId, chatId),
        eq(schema.taskDispatchCycles.operationId, operationId),
      ),
    )
    .for("update")
    .limit(1);
  const [latest] = await transaction
    .select({ id: schema.taskDispatchCycles.id })
    .from(schema.taskDispatchCycles)
    .where(
      and(
        eq(schema.taskDispatchCycles.ownerId, ownerId),
        eq(schema.taskDispatchCycles.chatId, chatId),
      ),
    )
    .orderBy(
      desc(schema.taskDispatchCycles.createdAt),
      desc(schema.taskDispatchCycles.id),
    )
    .limit(1);
  if (!cycle) return fail();
  if (latest?.id !== cycle.id || cycle.fencingToken !== fence.fencingToken)
    fail();
  if (expected.kind === "expired") {
    if (cycle.state !== "expired") fail();
  } else {
    const sameOwner = cycle.leaseOwner === expected.lease.leaseOwner;
    // A fast completion may settle before its launch callback binds history.
    // That association can finish under the same fence; it cannot settle work.
    const valid = association
      ? [
          "claimed",
          "running",
          "paused",
          "succeeded",
          "failed",
          "cancelled",
        ].includes(cycle.state)
      : ["claimed", "running"].includes(cycle.state) &&
        cycle.leaseExpiresAt !== null &&
        cycle.leaseExpiresAt.getTime() > Date.now();
    if (!sameOwner || !valid) fail();
  }
}
