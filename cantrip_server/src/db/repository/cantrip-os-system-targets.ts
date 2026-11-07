import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import {
  cantripOsSystemStatusResultSchema,
  type CantripOsSystemControl,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import {
  assertNoActiveSystem,
  ownedSystemInstance,
  systemFail,
} from "./cantrip-os-system-common.js";

const targets = schema.cantripOsSystemTargets,
  operations = schema.cantripOsSystemOperations,
  instances = schema.cantripOsInstances;
export async function beginSystemStatus(
  database: RepositoryDatabase,
  ownerId: string,
  instanceId: string,
) {
  return database.transaction(async (tx) => {
    const instance = await ownedSystemInstance(tx, ownerId, instanceId);
    const [old] = await tx
      .select()
      .from(targets)
      .where(eq(targets.instanceId, instanceId));
    const same = old?.attachmentGeneration === instance.attachmentGeneration;
    const value = {
      instanceId,
      attachmentGeneration: instance.attachmentGeneration,
      observationEpoch: (old?.observationEpoch ?? 0) + 1,
      catalogPowerEpoch: same ? old.catalogPowerEpoch : null,
      catalog: same ? old.catalog : null,
      verifiedAt: same ? old.verifiedAt : null,
    };
    const [target] = await tx
      .insert(targets)
      .values(value)
      .onConflictDoUpdate({ target: targets.instanceId, set: value })
      .returning();
    return { instance, target: target! };
  });
}
const identity = (
  target: NonNullable<
    ReturnType<typeof cantripOsSystemStatusResultSchema.parse>["target"]
  >,
) => [
  target.containerId,
  target.containerName,
  target.imageId,
  target.expected.ownerId,
  target.expected.workerId,
  target.expected.guestInstanceId,
];
export async function recordSystemTarget(
  database: RepositoryDatabase,
  ownerId: string,
  context: Awaited<ReturnType<typeof beginSystemStatus>>,
  raw: unknown,
) {
  const catalog = cantripOsSystemStatusResultSchema.parse(raw),
    expected = catalog.target?.expected;
  if (
    expected &&
    (expected.ownerId !== ownerId ||
      expected.workerId !== context.instance.workerId ||
      expected.guestInstanceId !== context.instance.guestInstanceId)
  )
    systemFail("The system observation belongs to another OS attachment.");
  return database.transaction(async (tx) => {
    const instance = await ownedSystemInstance(
      tx,
      ownerId,
      context.instance.id,
    );
    const [previous] = await tx
      .select()
      .from(targets)
      .where(eq(targets.instanceId, instance.id));
    if (
      !previous ||
      instance.attachmentGeneration !== context.instance.attachmentGeneration ||
      instance.workerId !== context.instance.workerId ||
      instance.guestInstanceId !== context.instance.guestInstanceId ||
      instance.powerEpoch !== context.instance.powerEpoch ||
      previous.observationEpoch !== context.target.observationEpoch ||
      previous.attachmentGeneration !== instance.attachmentGeneration
    )
      systemFail(
        "The system observation changed before its target was recorded.",
      );
    if (catalog.target)
      catalog.target.generation =
        previous.catalog?.target &&
        previous.catalogPowerEpoch === instance.powerEpoch &&
        isDeepStrictEqual(
          identity(previous.catalog.target),
          identity(catalog.target),
        )
          ? previous.catalog.target.generation
          : randomUUID();
    const [saved] = await tx
      .update(targets)
      .set({
        catalog,
        catalogPowerEpoch: instance.powerEpoch,
        verifiedAt: new Date(),
      })
      .where(eq(targets.instanceId, instance.id))
      .returning();
    return saved!;
  });
}
export async function beginSystemRecovery(
  database: RepositoryDatabase,
  ownerId: string,
  instanceId: string,
  operationId: string,
  input: CantripOsSystemControl,
) {
  return database.transaction(async (tx) => {
    const instance = await ownedSystemInstance(tx, ownerId, instanceId);
    const [operation] = await tx
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.ownerId, ownerId),
          eq(operations.instanceId, instanceId),
          eq(operations.operationId, operationId),
        ),
      );
    if (
      !operation ||
      operation.workerId !== instance.workerId ||
      operation.command.action === "capture" ||
      operation.state !== "ready" ||
      !operation.result?.root?.targetContainerId ||
      operation.retiredBy ||
      input.attachmentGeneration !== operation.fenceGeneration ||
      input.targetGeneration !== operation.targetGeneration
    )
      systemFail(
        "No completed original system transition authorizes this recovery.",
      );
    await assertNoActiveSystem(tx, instanceId);
    const recovered = operation.recoveryGeneration !== null;
    if (
      instance.attachmentGeneration !==
      (operation.recoveryGeneration ?? operation.fenceGeneration)
    )
      systemFail(
        "The system recovery attachment changed; no historical target was substituted.",
      );
    return { instance, operation, recovered };
  });
}
export async function adoptSystemTarget(
  database: RepositoryDatabase,
  ownerId: string,
  original: Awaited<ReturnType<typeof beginSystemRecovery>>,
  raw: unknown,
) {
  const catalog = cantripOsSystemStatusResultSchema.parse(raw),
    target = catalog.target,
    op = original.operation;
  if (
    !catalog.supported ||
    !target ||
    target.identityEvidence !== "guest-identity" ||
    target.containerId !== op.result!.root!.targetContainerId ||
    target.containerName !== op.command.target.containerName ||
    target.expected.ownerId !== ownerId ||
    target.expected.workerId !== original.instance.workerId
  )
    systemFail(
      "The recovered system does not match the exact completed transition.",
    );
  return database.transaction(async (tx) => {
    const instance = await ownedSystemInstance(
      tx,
      ownerId,
      original.instance.id,
    );
    const [current] = await tx
      .select()
      .from(operations)
      .where(eq(operations.operationId, op.operationId));
    if (
      current?.recoveryGeneration &&
      instance.attachmentGeneration === current.recoveryGeneration
    )
      return instance;
    if (
      !current ||
      current.retiredBy ||
      current.state !== "ready" ||
      instance.attachmentGeneration !== op.fenceGeneration ||
      instance.powerEpoch !== original.instance.powerEpoch ||
      instance.workerId !== original.instance.workerId ||
      instance.guestInstanceId !== original.instance.guestInstanceId
    )
      systemFail(
        "The system recovery changed before its identity was adopted.",
      );
    await assertNoActiveSystem(tx, instance.id);
    const generation = randomUUID();
    catalog.target = { ...target, generation: randomUUID() };
    const proof = {
      instanceId: instance.id,
      attachmentGeneration: generation,
      observationEpoch: 1,
      catalogPowerEpoch: instance.powerEpoch + 1,
      catalog,
      verifiedAt: new Date(),
    };
    await tx
      .insert(targets)
      .values(proof)
      .onConflictDoUpdate({
        target: targets.instanceId,
        set: { ...proof, observationEpoch: sql`${targets.observationEpoch}+1` },
      });
    await tx
      .update(operations)
      .set({ recoveryGeneration: generation })
      .where(eq(operations.operationId, op.operationId));
    // The existing unique Worker/guest identity constraint rejects simultaneous
    // logical admissions. The trigger requires the proof published above in this
    // transaction. Old source bindings retain their retired generation.
    const [saved] = await tx
      .update(instances)
      .set({
        guestInstanceId: target.expected.guestInstanceId,
        attachmentGeneration: generation,
        runtimeGeneration: null,
        workerProcessGeneration: null,
        status: "unknown",
        powerEpoch: sql`${instances.powerEpoch}+1`,
        lastError: null,
        lastObservedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(instances.id, instance.id))
      .returning();
    return saved!;
  });
}
