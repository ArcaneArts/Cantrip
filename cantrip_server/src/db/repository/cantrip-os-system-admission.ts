import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  cantripOsSystemCreateSchema,
  cantripOsSystemOperationCommandSchema,
  type CantripOsSystemCreate,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import {
  assertNoActiveSystem,
  ownedSystemInstance,
  systemFail,
  systemScope,
  type SystemOperationRow,
} from "./cantrip-os-system-common.js";

export async function admitSystemOperation(
  database: RepositoryDatabase,
  ownerId: string,
  instanceId: string,
  serverId: string,
  raw: CantripOsSystemCreate,
) {
  const input = cantripOsSystemCreateSchema.parse(raw),
    o = schema.cantripOsSystemOperations,
    i = schema.cantripOsInstances;
  return database.transaction(async (tx) => {
    const instance = await ownedSystemInstance(tx, ownerId, instanceId);
    const [old] = await tx
      .select()
      .from(o)
      .where(eq(o.operationId, input.operationId));
    if (old) {
      if (
        old.ownerId !== ownerId ||
        old.instanceId !== instanceId ||
        !isDeepStrictEqual(old.request, input)
      )
        systemFail(
          "This system operation ID belongs to another immutable admission.",
        );
      return { row: old, created: false };
    }
    if (
      instance.attachmentGeneration !== input.attachmentGeneration ||
      instance.transport.kind !== "docker"
    )
      systemFail(
        "The selected system attachment changed or has no Docker management path.",
      );
    const source = async (operationId: string) => {
      const [row] = await tx
        .select()
        .from(o)
        .where(
          and(
            eq(o.operationId, operationId),
            eq(o.ownerId, ownerId),
            eq(o.instanceId, instanceId),
            eq(o.workerId, instance.workerId),
          ),
        );
      return (
        row ??
        systemFail(
          "The original system operation is unavailable on this owning Worker.",
        )
      );
    };
    let original: SystemOperationRow | undefined;
    if (input.action === "rollback") {
      original = await source(input.replacementOperationId);
      if (
        original.command.action !== "replace" ||
        original.state === "rejected" ||
        original.targetGeneration !== input.targetGeneration
      )
        systemFail(
          "Rollback requires the original replacement's exact management target.",
        );
      if (
        original.dispatchStage !== "executing" &&
        !original.result?.root?.targetContainerId
      )
        systemFail(
          "The replacement has not been dispatched. Cancel its prepared admission instead.",
        );
    }
    await assertNoActiveSystem(tx, instanceId, original?.operationId);
    const [power] = await tx
      .select({ id: schema.cantripOsPowerOperations.operationId })
      .from(schema.cantripOsPowerOperations)
      .where(
        and(
          eq(schema.cantripOsPowerOperations.instanceId, instanceId),
          eq(
            schema.cantripOsPowerOperations.attachmentGeneration,
            instance.attachmentGeneration,
          ),
          inArray(schema.cantripOsPowerOperations.state, [
            "admitted",
            "running",
            "unknown",
          ]),
        ),
      )
      .limit(1);
    if (power)
      systemFail(
        "A power operation remains active or uncertain. Observe its original outcome before replacing system state.",
      );
    const [targetRow] = await tx
      .select()
      .from(schema.cantripOsSystemTargets)
      .where(eq(schema.cantripOsSystemTargets.instanceId, instanceId));
    const catalog = targetRow?.catalog;
    if (
      !original &&
      (!targetRow ||
        !catalog?.target ||
        !catalog.supported ||
        targetRow.attachmentGeneration !== instance.attachmentGeneration ||
        targetRow.catalogPowerEpoch !== instance.powerEpoch ||
        catalog.target.generation !== input.targetGeneration)
    )
      systemFail(
        "The selected system target changed. Observe actual system status before admitting another operation.",
      );
    const target = original?.command.target ?? catalog!.target!;
    const common = {
      mode: "execute",
      operationId: input.operationId,
      scope: systemScope(instance, serverId),
      transport: instance.transport,
      target,
    };
    let body: unknown;
    if (input.action === "capture")
      body = {
        type: "cantrip-os.system.capture",
        ...common,
        action: "capture",
        checkpointId: randomUUID(),
        resumeOriginal: input.resumeOriginal,
      };
    else if (input.action === "rollback")
      body = {
        type: "cantrip-os.system.rollback",
        ...common,
        action: "rollback",
        startTarget: input.startTarget,
        replacement: {
          operationId: original!.operationId,
          scope: original!.command.scope,
          targetGeneration: original!.targetGeneration,
        },
      };
    else {
      let selected: unknown = input.source;
      if (input.source.kind === "checkpoint") {
        const capture = await source(input.source.operationId),
          command = capture.command;
        if (
          command.action !== "capture" ||
          capture.state !== "ready" ||
          !capture.result?.protectedResult
        )
          systemFail("The selected private system checkpoint is not complete.");
        selected = {
          kind: "checkpoint",
          capture: {
            context: {
              ...command.scope,
              operationId: command.operationId,
              targetGeneration: command.target.generation,
              checkpointId: command.checkpointId,
              containerId: command.target.containerId,
            },
            container: command.target.containerName,
            resumeOriginal: command.resumeOriginal,
          },
        };
      } else {
        const imageId = input.source.imageId;
        if (!catalog!.bases.some((base) => base.imageId === imageId))
          systemFail(
            "The exact base image is not in this verified system catalogue.",
          );
      }
      body = {
        type: "cantrip-os.system.replace",
        ...common,
        action: "replace",
        source: selected,
        startTarget: input.startTarget,
      };
    }
    const command = cantripOsSystemOperationCommandSchema.parse(body),
      fenceGeneration = randomUUID();
    const [row] = await tx
      .insert(o)
      .values({
        operationId: input.operationId,
        ownerId,
        workerId: instance.workerId,
        instanceId,
        attachmentGeneration: instance.attachmentGeneration,
        targetGeneration: input.targetGeneration,
        fenceGeneration,
        admissionEpoch: instance.powerEpoch + 1,
        request: input,
        command,
      })
      .returning();
    if (original)
      await tx
        .update(o)
        .set({ retiredBy: row!.operationId })
        .where(eq(o.operationId, original.operationId));
    // Retain known physical proof for read-only rescue discovery, but require an
    // actual new observation before this catalogue can authorize another job.
    if (targetRow)
      await tx
        .update(schema.cantripOsSystemTargets)
        .set({
          attachmentGeneration: fenceGeneration,
          catalogPowerEpoch: null,
          observationEpoch: sql`${schema.cantripOsSystemTargets.observationEpoch}+1`,
        })
        .where(eq(schema.cantripOsSystemTargets.instanceId, instanceId));
    await tx
      .update(i)
      .set({
        attachmentGeneration: fenceGeneration,
        transport: { kind: "docker", container: target.containerName },
        runtimeGeneration: null,
        workerProcessGeneration: null,
        status: "unknown",
        lastError: null,
        powerEpoch: sql`${i.powerEpoch}+1`,
        updatedAt: new Date(),
      })
      .where(eq(i.id, instanceId));
    return { row: row!, created: true };
  });
}
