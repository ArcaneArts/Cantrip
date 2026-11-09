import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  cantripOsDispatchScopeSchema,
  cantripOsOperationResultSchema,
  cantripOsWorkspaceOperationSummarySchema,
  type cantripOsWorkspaceCreateSchema,
  type cantripOsWorkspaceOperationListQuerySchema,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { CantripOsPlacementError } from "./cantrip-os-error.js";
import { assertNoActiveSystem } from "./cantrip-os-system-common.js";

const operations = schema.cantripOsWorkspaceOperations;
const instances = schema.cantripOsInstances;
export type WorkspaceOperationRow = typeof operations.$inferSelect;
const fail = (message: string): never => {
  throw new CantripOsPlacementError(message);
};

export function workspaceOperationResult(row: WorkspaceOperationRow) {
  return (
    row.result ??
    cantripOsOperationResultSchema.parse({
      operationId: row.operationId,
      state: "unknown",
      startedAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      receipt: null,
      error:
        "Workspace creation has no verified outcome. Observe this original operation; creation was not repeated.",
    })
  );
}
export function workspaceOperationSummary(row: WorkspaceOperationRow) {
  return cantripOsWorkspaceOperationSummarySchema.parse({
    operationId: row.operationId,
    instanceId: row.instanceId,
    workerId: row.workerId,
    guestWorkspaceId: row.guestWorkspaceId,
    attachmentGeneration: row.attachmentGeneration,
    runtimeGeneration: row.runtimeGeneration,
    state: row.state,
    result: row.result,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** A create admission is durable before dispatch. Repeated requests only observe
 * its original Worker scope; they never rebuild a command from a new attachment. */
export class CantripOsWorkspaceOperationRepository {
  constructor(private readonly database: RepositoryDatabase) {}
  async get(ownerId: string, instanceId: string, operationId: string) {
    const [row] = await this.database
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.ownerId, ownerId),
          eq(operations.instanceId, instanceId),
          eq(operations.operationId, operationId),
        ),
      );
    return row ?? null;
  }
  async admit(
    ownerId: string,
    instanceId: string,
    serverId: string,
    input: ReturnType<typeof cantripOsWorkspaceCreateSchema.parse>,
  ) {
    return this.database.transaction(async (tx) => {
      const [owned] = await tx
        .select({ instance: instances })
        .from(instances)
        .innerJoin(schema.workers, eq(schema.workers.id, instances.workerId))
        .where(
          and(
            eq(instances.id, instanceId),
            eq(instances.ownerId, ownerId),
            eq(schema.workers.ownerId, ownerId),
            isNull(schema.workers.unlinkedAt),
          ),
        )
        .for("update", { of: instances });
      if (!owned) return fail("Owned OS attachment not found.");
      const [old] = await tx
        .select()
        .from(operations)
        .where(eq(operations.operationId, input.operationId));
      if (old) {
        if (
          old.ownerId !== ownerId ||
          old.instanceId !== instanceId ||
          old.command.scope.serverId !== serverId ||
          !isDeepStrictEqual(old.request, input)
        )
          return fail(
            "This workspace operation ID belongs to another admission.",
          );
        return { row: old, created: false };
      }
      const i = owned.instance;
      await assertNoActiveSystem(tx, instanceId);
      if (
        (input.attachmentGeneration !== undefined &&
          input.attachmentGeneration !== i.attachmentGeneration) ||
        (input.runtimeGeneration !== undefined &&
          input.runtimeGeneration !== i.runtimeGeneration)
      )
        return fail(
          "The selected OS attachment or runtime changed before workspace admission.",
        );
      const scope = cantripOsDispatchScopeSchema.parse({
        ownerId,
        serverId,
        workerId: i.workerId,
        instanceId,
        guestInstanceId: i.guestInstanceId,
        attachmentGeneration: i.attachmentGeneration,
        runtimeGeneration: i.runtimeGeneration,
      });
      const command: WorkspaceOperationRow["command"] = {
        type: "cantrip-os.workspaces.create",
        scope,
        transport: i.transport,
        operationId: input.operationId,
        guestWorkspaceId: input.guestWorkspaceId,
      };
      const [row] = await tx
        .insert(operations)
        .values({
          operationId: input.operationId,
          ownerId,
          instanceId,
          workerId: i.workerId,
          guestWorkspaceId: input.guestWorkspaceId,
          attachmentGeneration: scope.attachmentGeneration,
          runtimeGeneration: scope.runtimeGeneration,
          command,
          request: input,
        })
        .onConflictDoNothing()
        .returning();
      if (!row)
        return fail(
          "This workspace operation ID belongs to another admission.",
        );
      return { row, created: true };
    });
  }
  async beginObservation(
    ownerId: string,
    instanceId: string,
    operationId: string,
  ) {
    const [row] = await this.database
      .update(operations)
      .set({ revision: sql`${operations.revision}+1` })
      .where(
        and(
          eq(operations.ownerId, ownerId),
          eq(operations.instanceId, instanceId),
          eq(operations.operationId, operationId),
        ),
      )
      .returning();
    return row ?? fail("Workspace operation not found.");
  }
  async record(original: WorkspaceOperationRow, raw: unknown) {
    const result = cantripOsOperationResultSchema.parse(raw);
    if (
      result.operationId !== original.operationId ||
      (result.receipt &&
        (result.receipt.kind !== "workspace" ||
          result.receipt.workspace.guestWorkspaceId !==
            original.guestWorkspaceId))
    )
      return fail("Workspace receipt does not match its original admission.");
    return this.database.transaction(async (tx) => {
      // Lock order matches admission: instance, then operation.
      const [i] = await tx
        .select()
        .from(instances)
        .where(
          and(
            eq(instances.id, original.instanceId),
            eq(instances.ownerId, original.ownerId),
          ),
        )
        .for("update");
      const [current] = await tx
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.operationId, original.operationId),
            eq(operations.ownerId, original.ownerId),
          ),
        )
        .for("update");
      if (!current) return fail("Workspace operation not found.");
      if (
        current.revision !== original.revision ||
        ["ready", "failed"].includes(current.state)
      )
        return current;
      if (
        result.state === "ready" &&
        result.receipt.kind === "workspace" &&
        i &&
        i.workerId === original.workerId &&
        i.guestInstanceId === original.command.scope.guestInstanceId &&
        i.attachmentGeneration === original.attachmentGeneration &&
        i.runtimeGeneration === original.runtimeGeneration
      ) {
        const observation = result.receipt.workspace;
        const [old] = await tx
          .select()
          .from(schema.cantripOsWorkspaces)
          .where(
            and(
              eq(schema.cantripOsWorkspaces.instanceId, i.id),
              eq(
                schema.cantripOsWorkspaces.guestWorkspaceId,
                observation.guestWorkspaceId,
              ),
            ),
          );
        if (
          old &&
          (old.uid !== observation.uid ||
            old.gid !== observation.gid ||
            old.homeGuestPath !== observation.homeGuestPath)
        )
          return fail(
            "OS workspace identity changed; the existing placement was preserved.",
          );
        if (!old)
          await tx
            .insert(schema.cantripOsWorkspaces)
            .values({ id: randomUUID(), instanceId: i.id, ...observation });
      }
      const [saved] = await tx
        .update(operations)
        .set({
          state: result.state,
          result,
          revision: sql`${operations.revision}+1`,
          updatedAt: new Date(),
        })
        .where(eq(operations.operationId, original.operationId))
        .returning();
      return saved!;
    });
  }
  async unknown(original: WorkspaceOperationRow) {
    const [row] = await this.database
      .update(operations)
      .set({
        state: "unknown",
        result: null,
        updatedAt: new Date(),
        revision: sql`${operations.revision}+1`,
      })
      .where(
        and(
          eq(operations.operationId, original.operationId),
          eq(operations.ownerId, original.ownerId),
          eq(operations.revision, original.revision),
          sql`${operations.state} NOT IN ('ready','failed')`,
        ),
      )
      .returning();
    return (
      row ??
      (await this.get(
        original.ownerId,
        original.instanceId,
        original.operationId,
      )) ??
      fail("Workspace operation not found.")
    );
  }
  async list(
    ownerId: string,
    instanceId: string,
    input: ReturnType<typeof cantripOsWorkspaceOperationListQuerySchema.parse>,
  ) {
    const [parent] = await this.database
      .select({ id: instances.id })
      .from(instances)
      .where(and(eq(instances.ownerId, ownerId), eq(instances.id, instanceId)));
    if (!parent) return fail("Owned OS attachment not found.");
    const cursor = input.cursor
      ? await this.get(ownerId, instanceId, input.cursor)
      : null;
    if (input.cursor && !cursor)
      return fail("Workspace history cursor not found.");
    const rows = await this.database
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.ownerId, ownerId),
          eq(operations.instanceId, instanceId),
          cursor
            ? sql`(${operations.createdAt},${operations.operationId}) < (SELECT created_at,operation_id FROM cantrip_os_workspace_operations WHERE owner_id=${ownerId} AND instance_id=${instanceId} AND operation_id=${cursor.operationId})`
            : undefined,
        ),
      )
      .orderBy(desc(operations.createdAt), desc(operations.operationId))
      .limit(input.limit + 1);
    const items = rows.slice(0, input.limit);
    return {
      items: items.map(workspaceOperationSummary),
      nextCursor: rows.length > input.limit ? items.at(-1)!.operationId : null,
    };
  }
}
