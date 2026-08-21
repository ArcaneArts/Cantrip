import { randomUUID } from "node:crypto";

import {
  workflowAutomationTriggerWireListSchema,
  workflowAutomationTriggerWireSchema,
  workflowTriggerDeliveryWireSchema,
  workflowTriggerPublicConfigurationSchema,
  type EncryptedWorkflowAutomationTriggerCreate,
  type EncryptedWorkflowAutomationTriggerUpdate,
  type WorkflowAutomationTriggerWire,
  type WorkflowAutomationTriggerQuery,
  type WorkflowTriggerDeliveryWire,
  type WorkflowTriggerProvenance,
} from "@cantrip/protocol/workflows";
import type { WorkflowContentOpaque } from "@cantrip/protocol/workflow-content";
import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";

type TriggerDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type TriggerRow = typeof schema.workflowAutomationTriggers.$inferSelect;
type DeliveryRow = typeof schema.workflowTriggerDeliveries.$inferSelect;

export class WorkflowTriggerConflictError extends Error {}
export class WorkflowTriggerRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
  }
}

function toISOString(value: Date): string {
  return value.toISOString();
}

function toTrigger(row: TriggerRow): WorkflowAutomationTriggerWire {
  return workflowAutomationTriggerWireSchema.parse({
    id: row.id,
    workflowId: row.workflowId,
    workflowRevisionId: row.workflowRevisionId,
    ownerId: row.ownerId,
    projectId: row.projectId,
    type: row.type,
    enabled: row.enabled,
    publicConfiguration: row.publicConfiguration,
    protectedName: row.protectedName,
    protectedConfiguration: row.protectedConfiguration,
    protectedInput: row.protectedInput,
    budget: row.budget,
    permissionManifest: row.permissionManifest,
    selectedModelRouteId: row.selectedModelRouteId,
    selectedPermissionProfileId: row.selectedPermissionProfileId,
    nextRunAt: row.nextRunAt ? toISOString(row.nextRunAt) : null,
    lastDeliveredAt: row.lastDeliveredAt
      ? toISOString(row.lastDeliveredAt)
      : null,
    lastRunId: row.lastRunId,
    lastErrorCode: row.lastErrorCode,
    createdAt: toISOString(row.createdAt),
    updatedAt: toISOString(row.updatedAt),
  });
}

function toDelivery(row: DeliveryRow): WorkflowTriggerDeliveryWire {
  return workflowTriggerDeliveryWireSchema.parse({
    id: row.id,
    triggerId: row.triggerId,
    runId: row.runId,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    trigger: row.publicProvenance,
    protectedPayload: row.protectedPayload,
    errorCode: row.errorCode,
    createdAt: toISOString(row.createdAt),
    updatedAt: toISOString(row.updatedAt),
  });
}

function minimumIntervalSeconds(row: TriggerRow): number {
  const configuration = workflowTriggerPublicConfigurationSchema.parse(
    row.publicConfiguration,
  );
  if (configuration.type === "schedule") {
    return configuration.intervalSeconds;
  }
  return configuration.minimumIntervalSeconds;
}

export interface WorkflowTriggerDeliveryContext {
  credentialHash: string | null;
  row: TriggerRow;
  trigger: WorkflowAutomationTriggerWire;
}

export type WorkflowTriggerClaim =
  | {
      kind: "claimed" | "replay";
      delivery: WorkflowTriggerDeliveryWire;
      context: WorkflowTriggerDeliveryContext;
    }
  | { kind: "disabled" };

export interface WorkflowScheduleDispatchLease {
  dispatchInstanceId: string;
  fencingToken: number;
  leaseToken: string;
}

export type WorkflowScheduleOccurrenceClaim =
  | {
      kind: "claimed";
      claim: Extract<WorkflowTriggerClaim, { kind: "claimed" | "replay" }>;
      lease: WorkflowScheduleDispatchLease;
    }
  | {
      kind: "completed";
      delivery: WorkflowTriggerDeliveryWire;
    }
  | { kind: "busy" }
  | { kind: "disabled" };

export class WorkflowTriggerRepository {
  constructor(private readonly database: TriggerDatabase) {}

  private async assertUnattendedContext(
    ownerId: string,
    workflowRevisionId: string,
    projectId: string,
  ): Promise<{
    workflowId: string;
  } | null> {
    const rows = await this.database
      .select({
        workflowId: schema.workflowDefinitions.id,
        definitionProjectId: schema.workflowDefinitions.projectId,
        definitionScope: schema.workflowDefinitions.scope,
        definitionTrust: schema.workflowDefinitions.trustState,
        revisionTrust: schema.workflowRevisions.trustState,
      })
      .from(schema.workflowRevisions)
      .innerJoin(
        schema.workflowDefinitions,
        and(
          eq(
            schema.workflowDefinitions.id,
            schema.workflowRevisions.workflowId,
          ),
          eq(schema.workflowDefinitions.ownerId, ownerId),
        ),
      )
      .where(eq(schema.workflowRevisions.id, workflowRevisionId))
      .limit(1);
    const context = rows[0];
    if (!context) return null;
    const projectRows = await this.database
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!projectRows[0]) return null;
    if (
      context.definitionScope === "project" &&
      context.definitionProjectId !== projectId
    ) {
      return null;
    }
    if (
      context.definitionTrust !== "trusted" ||
      context.revisionTrust !== "trusted"
    ) {
      throw new WorkflowTriggerConflictError(
        "Unattended triggers require a trusted workflow and revision.",
      );
    }
    return { workflowId: context.workflowId };
  }

  async create(
    ownerId: string,
    input: EncryptedWorkflowAutomationTriggerCreate,
  ): Promise<WorkflowAutomationTriggerWire | null> {
    const context = await this.assertUnattendedContext(
      ownerId,
      input.workflowRevisionId,
      input.projectId,
    );
    if (!context) return null;
    if (input.permissionManifest.approvalMode !== "preauthorized") {
      throw new WorkflowTriggerConflictError(
        "Unattended trigger permission manifests must be preauthorized.",
      );
    }
    const now = new Date();
    const nextRunAt =
      input.publicConfiguration.type === "schedule"
        ? input.publicConfiguration.startAt
          ? new Date(input.publicConfiguration.startAt)
          : new Date(
              now.getTime() + input.publicConfiguration.intervalSeconds * 1_000,
            )
        : null;
    const rows = await this.database
      .insert(schema.workflowAutomationTriggers)
      .values({
        id: input.id,
        workflowId: context.workflowId,
        workflowRevisionId: input.workflowRevisionId,
        ownerId,
        projectId: input.projectId,
        type: input.type,
        enabled: input.enabled,
        publicConfiguration: input.publicConfiguration,
        credentialHash: input.credentialHash,
        protectedName: input.protectedName,
        protectedConfiguration: input.protectedConfiguration,
        protectedInput: input.protectedInput,
        budget: input.budget,
        permissionManifest: input.permissionManifest,
        selectedModelRouteId: input.selectedModelRouteId,
        selectedPermissionProfileId: input.selectedPermissionProfileId,
        nextRunAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return toTrigger(rows[0]!);
  }

  async list(
    ownerId: string,
    query: WorkflowAutomationTriggerQuery,
  ): Promise<WorkflowAutomationTriggerWire[]> {
    const conditions = [eq(schema.workflowAutomationTriggers.ownerId, ownerId)];
    if (query.projectId) {
      conditions.push(
        eq(schema.workflowAutomationTriggers.projectId, query.projectId),
      );
    }
    if (query.type) {
      conditions.push(eq(schema.workflowAutomationTriggers.type, query.type));
    }
    if (query.enabled !== undefined) {
      conditions.push(
        eq(schema.workflowAutomationTriggers.enabled, query.enabled),
      );
    }
    const rows = await this.database
      .select()
      .from(schema.workflowAutomationTriggers)
      .where(and(...conditions))
      .orderBy(desc(schema.workflowAutomationTriggers.createdAt))
      .limit(query.limit);
    return workflowAutomationTriggerWireListSchema.parse(rows.map(toTrigger));
  }

  async get(
    ownerId: string,
    triggerId: string,
  ): Promise<WorkflowAutomationTriggerWire | null> {
    const rows = await this.database
      .select()
      .from(schema.workflowAutomationTriggers)
      .where(
        and(
          eq(schema.workflowAutomationTriggers.id, triggerId),
          eq(schema.workflowAutomationTriggers.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toTrigger(rows[0]) : null;
  }

  async getDeliveryContext(
    ownerId: string,
    triggerId: string,
  ): Promise<WorkflowTriggerDeliveryContext | null> {
    const rows = await this.database
      .select()
      .from(schema.workflowAutomationTriggers)
      .where(
        and(
          eq(schema.workflowAutomationTriggers.id, triggerId),
          eq(schema.workflowAutomationTriggers.ownerId, ownerId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      row,
      trigger: toTrigger(row),
      credentialHash: row.type === "webhook" ? row.credentialHash : null,
    };
  }

  async getWebhookDeliveryContext(
    triggerId: string,
  ): Promise<WorkflowTriggerDeliveryContext | null> {
    const rows = await this.database
      .select()
      .from(schema.workflowAutomationTriggers)
      .where(
        and(
          eq(schema.workflowAutomationTriggers.id, triggerId),
          eq(schema.workflowAutomationTriggers.type, "webhook"),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      row,
      trigger: toTrigger(row),
      credentialHash: row.credentialHash,
    };
  }

  async update(
    ownerId: string,
    triggerId: string,
    input: EncryptedWorkflowAutomationTriggerUpdate,
  ): Promise<WorkflowAutomationTriggerWire | null> {
    const existing = await this.getDeliveryContext(ownerId, triggerId);
    if (!existing) return null;
    if (input.enabled === true) {
      await this.assertUnattendedContext(
        ownerId,
        existing.row.workflowRevisionId,
        existing.row.projectId,
      );
    }
    const rows = await this.database
      .update(schema.workflowAutomationTriggers)
      .set({
        ...(input.protectedName !== undefined
          ? { protectedName: input.protectedName }
          : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.workflowAutomationTriggers.id, triggerId),
          eq(schema.workflowAutomationTriggers.ownerId, ownerId),
        ),
      )
      .returning();
    return rows[0] ? toTrigger(rows[0]) : null;
  }

  async listDueSchedules(now = new Date(), limit = 100) {
    const rows = await this.database
      .select()
      .from(schema.workflowAutomationTriggers)
      .where(
        and(
          eq(schema.workflowAutomationTriggers.type, "schedule"),
          eq(schema.workflowAutomationTriggers.enabled, true),
          lte(schema.workflowAutomationTriggers.nextRunAt, now),
        ),
      )
      .orderBy(asc(schema.workflowAutomationTriggers.nextRunAt))
      .limit(limit);
    return rows.map((row) => ({ row, trigger: toTrigger(row) }));
  }

  async claimScheduleOccurrence(
    ownerId: string,
    triggerId: string,
    scheduledFor: Date,
    provenance: WorkflowTriggerProvenance,
    dispatchInstanceId: string,
    leaseTtlMs: number,
    now = new Date(),
  ): Promise<WorkflowScheduleOccurrenceClaim | null> {
    const initial = await this.getDeliveryContext(ownerId, triggerId);
    if (!initial || initial.row.type !== "schedule") return null;
    const unattendedContext = await this.assertUnattendedContext(
      ownerId,
      initial.row.workflowRevisionId,
      initial.row.projectId,
    );
    if (!unattendedContext) return null;
    return this.database.transaction(async (transaction) => {
      const triggerRows = await transaction
        .select()
        .from(schema.workflowAutomationTriggers)
        .where(
          and(
            eq(schema.workflowAutomationTriggers.id, triggerId),
            eq(schema.workflowAutomationTriggers.ownerId, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      const row = triggerRows[0];
      if (!row) return null;
      if (
        row.type !== "schedule" ||
        !row.enabled ||
        row.workflowRevisionId !== initial.row.workflowRevisionId ||
        !row.nextRunAt ||
        row.nextRunAt.toISOString() !== scheduledFor.toISOString()
      ) {
        return { kind: "disabled" as const };
      }
      const context: WorkflowTriggerDeliveryContext = {
        row,
        trigger: toTrigger(row),
        credentialHash: null,
      };
      const idempotencyKey = scheduledFor.toISOString();
      const existingRows = await transaction
        .select()
        .from(schema.workflowTriggerDeliveries)
        .where(
          and(
            eq(schema.workflowTriggerDeliveries.triggerId, triggerId),
            eq(schema.workflowTriggerDeliveries.idempotencyKey, idempotencyKey),
          ),
        )
        .for("update")
        .limit(1);
      const existing = existingRows[0];
      if (existing && existing.status !== "pending") {
        return {
          kind: "completed" as const,
          delivery: toDelivery(existing),
        };
      }
      if (
        existing?.leaseExpiresAt &&
        existing.leaseExpiresAt.getTime() > now.getTime()
      ) {
        return { kind: "busy" as const };
      }
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs);
      const delivery = existing
        ? (
            await transaction
              .update(schema.workflowTriggerDeliveries)
              .set({
                dispatchInstanceId,
                leaseToken,
                fencingToken: existing.fencingToken + 1,
                leaseExpiresAt,
                updatedAt: now,
              })
              .where(
                and(
                  eq(schema.workflowTriggerDeliveries.id, existing.id),
                  eq(schema.workflowTriggerDeliveries.status, "pending"),
                  eq(
                    schema.workflowTriggerDeliveries.fencingToken,
                    existing.fencingToken,
                  ),
                ),
              )
              .returning()
          )[0]
        : (
            await transaction
              .insert(schema.workflowTriggerDeliveries)
              .values({
                id: randomUUID(),
                triggerId,
                status: "pending",
                idempotencyKey,
                publicProvenance: provenance,
                protectedPayload: null,
                dispatchInstanceId,
                leaseToken,
                fencingToken: 1,
                leaseExpiresAt,
                createdAt: now,
                updatedAt: now,
              })
              .returning()
          )[0];
      if (!delivery) return { kind: "busy" as const };
      await transaction
        .update(schema.workflowAutomationTriggers)
        .set({
          lastDeliveredAt: now,
          lastErrorCode: null,
          updatedAt: now,
        })
        .where(eq(schema.workflowAutomationTriggers.id, triggerId));
      return {
        kind: "claimed" as const,
        claim: {
          kind: existing ? ("replay" as const) : ("claimed" as const),
          delivery: toDelivery(delivery),
          context,
        },
        lease: {
          dispatchInstanceId,
          leaseToken,
          fencingToken: delivery.fencingToken,
        },
      };
    });
  }

  async claimDelivery(
    ownerId: string,
    triggerId: string,
    idempotencyKey: string,
    provenance: WorkflowTriggerProvenance,
    protectedPayload: WorkflowContentOpaque | null,
    now = new Date(),
  ): Promise<WorkflowTriggerClaim | null> {
    const deliveryContext = await this.getDeliveryContext(ownerId, triggerId);
    if (!deliveryContext) return null;
    const unattendedContext = await this.assertUnattendedContext(
      ownerId,
      deliveryContext.row.workflowRevisionId,
      deliveryContext.row.projectId,
    );
    if (!unattendedContext) return null;

    return this.database.transaction(async (transaction) => {
      const triggerRows = await transaction
        .select()
        .from(schema.workflowAutomationTriggers)
        .where(
          and(
            eq(schema.workflowAutomationTriggers.id, triggerId),
            eq(schema.workflowAutomationTriggers.ownerId, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      const row = triggerRows[0];
      if (!row) return null;
      const existingDeliveries = await transaction
        .select()
        .from(schema.workflowTriggerDeliveries)
        .where(
          and(
            eq(schema.workflowTriggerDeliveries.triggerId, triggerId),
            eq(schema.workflowTriggerDeliveries.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      const context = {
        row,
        trigger: toTrigger(row),
        credentialHash: row.type === "webhook" ? row.credentialHash : null,
      };
      if (existingDeliveries[0]) {
        return {
          kind: "replay" as const,
          delivery: toDelivery(existingDeliveries[0]),
          context,
        };
      }
      if (!row.enabled) return { kind: "disabled" as const };
      if (row.lastDeliveredAt) {
        const minimum = minimumIntervalSeconds(row);
        const availableAt = row.lastDeliveredAt.getTime() + minimum * 1_000;
        if (availableAt > now.getTime()) {
          throw new WorkflowTriggerRateLimitError(
            "Workflow trigger delivery is rate limited.",
            Math.max(1, Math.ceil((availableAt - now.getTime()) / 1_000)),
          );
        }
      }
      const deliveryRows = await transaction
        .insert(schema.workflowTriggerDeliveries)
        .values({
          id: randomUUID(),
          triggerId,
          status: "pending",
          idempotencyKey,
          publicProvenance: provenance,
          protectedPayload,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await transaction
        .update(schema.workflowAutomationTriggers)
        .set({
          lastDeliveredAt: now,
          lastErrorCode: null,
          updatedAt: now,
        })
        .where(eq(schema.workflowAutomationTriggers.id, triggerId));
      return {
        kind: "claimed" as const,
        delivery: toDelivery(deliveryRows[0]!),
        context,
      };
    });
  }

  async acceptDelivery(
    ownerId: string,
    deliveryId: string,
    triggerId: string,
    runId: string,
    lease?: WorkflowScheduleDispatchLease,
  ): Promise<WorkflowTriggerDeliveryWire | null> {
    if (!(await this.getDeliveryContext(ownerId, triggerId))) {
      throw new WorkflowTriggerConflictError("Workflow trigger not found.");
    }
    const now = new Date();
    const rows = await this.database
      .update(schema.workflowTriggerDeliveries)
      .set({ status: "accepted", runId, updatedAt: now })
      .where(
        and(
          eq(schema.workflowTriggerDeliveries.id, deliveryId),
          eq(schema.workflowTriggerDeliveries.triggerId, triggerId),
          ...(lease
            ? [
                eq(schema.workflowTriggerDeliveries.status, "pending"),
                eq(
                  schema.workflowTriggerDeliveries.dispatchInstanceId,
                  lease.dispatchInstanceId,
                ),
                eq(
                  schema.workflowTriggerDeliveries.leaseToken,
                  lease.leaseToken,
                ),
                eq(
                  schema.workflowTriggerDeliveries.fencingToken,
                  lease.fencingToken,
                ),
                gt(schema.workflowTriggerDeliveries.leaseExpiresAt, now),
              ]
            : []),
        ),
      )
      .returning();
    if (!rows[0]) return null;
    await this.database
      .update(schema.workflowAutomationTriggers)
      .set({ lastRunId: runId, lastErrorCode: null, updatedAt: now })
      .where(
        and(
          eq(schema.workflowAutomationTriggers.id, triggerId),
          eq(schema.workflowAutomationTriggers.ownerId, ownerId),
        ),
      );
    return toDelivery(rows[0]);
  }

  async failDelivery(
    ownerId: string,
    deliveryId: string,
    triggerId: string,
    errorCode: string,
    lease?: WorkflowScheduleDispatchLease,
  ): Promise<boolean> {
    if (!(await this.getDeliveryContext(ownerId, triggerId))) return false;
    const now = new Date();
    const deliveries = await this.database
      .update(schema.workflowTriggerDeliveries)
      .set({
        status: "failed",
        errorCode,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.workflowTriggerDeliveries.id, deliveryId),
          eq(schema.workflowTriggerDeliveries.triggerId, triggerId),
          ...(lease
            ? [
                eq(schema.workflowTriggerDeliveries.status, "pending"),
                eq(
                  schema.workflowTriggerDeliveries.dispatchInstanceId,
                  lease.dispatchInstanceId,
                ),
                eq(
                  schema.workflowTriggerDeliveries.leaseToken,
                  lease.leaseToken,
                ),
                eq(
                  schema.workflowTriggerDeliveries.fencingToken,
                  lease.fencingToken,
                ),
                gt(schema.workflowTriggerDeliveries.leaseExpiresAt, now),
              ]
            : []),
        ),
      )
      .returning({ id: schema.workflowTriggerDeliveries.id });
    if (!deliveries[0]) return false;
    await this.database
      .update(schema.workflowAutomationTriggers)
      .set({ lastErrorCode: errorCode, updatedAt: now })
      .where(
        and(
          eq(schema.workflowAutomationTriggers.id, triggerId),
          eq(schema.workflowAutomationTriggers.ownerId, ownerId),
        ),
      );
    return true;
  }

  async advanceSchedule(
    ownerId: string,
    triggerId: string,
    expected: Date,
    next: Date,
    lastErrorCode: string | null = null,
  ): Promise<boolean> {
    const rows = await this.database
      .update(schema.workflowAutomationTriggers)
      .set({ nextRunAt: next, lastErrorCode, updatedAt: new Date() })
      .where(
        and(
          eq(schema.workflowAutomationTriggers.id, triggerId),
          eq(schema.workflowAutomationTriggers.ownerId, ownerId),
          eq(schema.workflowAutomationTriggers.nextRunAt, expected),
        ),
      )
      .returning({ id: schema.workflowAutomationTriggers.id });
    return Boolean(rows[0]);
  }
}
