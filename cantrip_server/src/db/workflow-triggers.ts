import { randomUUID } from "node:crypto";

import {
  workflowAutomationTriggerListSchema,
  workflowAutomationTriggerSchema,
  workflowPermissionRequirementsSchema,
  workflowTriggerDeliverySchema,
  type WorkflowAutomationTrigger,
  type WorkflowAutomationTriggerCreate,
  type WorkflowAutomationTriggerQuery,
  type WorkflowAutomationTriggerUpdate,
  type WorkflowTriggerDelivery,
  type WorkflowTriggerProvenance,
} from "@cantrip/protocol/workflows";
import { and, asc, desc, eq, lte } from "drizzle-orm";
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

function publicConfiguration(row: TriggerRow): Record<string, unknown> {
  if (row.type !== "webhook") return row.configuration;
  const { credentialHash: _credentialHash, ...configuration } =
    row.configuration;
  return { ...configuration, credentialConfigured: true };
}

function toTrigger(row: TriggerRow): WorkflowAutomationTrigger {
  return workflowAutomationTriggerSchema.parse({
    id: row.id,
    workflowId: row.workflowId,
    workflowRevisionId: row.workflowRevisionId,
    ownerId: row.ownerId,
    projectId: row.projectId,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    configuration: publicConfiguration(row),
    structuredInput: row.structuredInput,
    budget: row.budget,
    permissionManifest: row.permissionManifest,
    selectedModelRouteId: row.selectedModelRouteId,
    selectedPermissionProfileId: row.selectedPermissionProfileId,
    nextRunAt: row.nextRunAt ? toISOString(row.nextRunAt) : null,
    lastDeliveredAt: row.lastDeliveredAt
      ? toISOString(row.lastDeliveredAt)
      : null,
    lastRunId: row.lastRunId,
    lastError: row.lastError,
    createdAt: toISOString(row.createdAt),
    updatedAt: toISOString(row.updatedAt),
  });
}

function toDelivery(row: DeliveryRow): WorkflowTriggerDelivery {
  return workflowTriggerDeliverySchema.parse({
    id: row.id,
    triggerId: row.triggerId,
    runId: row.runId,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    trigger: row.triggerProvenance,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: toISOString(row.createdAt),
    updatedAt: toISOString(row.updatedAt),
  });
}

function minimumIntervalSeconds(row: TriggerRow): number {
  if (row.type === "schedule") {
    return Number(row.configuration.intervalSeconds);
  }
  return Number(row.configuration.minimumIntervalSeconds ?? 1);
}

export interface WorkflowTriggerDeliveryContext {
  credentialHash: string | null;
  row: TriggerRow;
  trigger: WorkflowAutomationTrigger;
}

export type WorkflowTriggerClaim =
  | {
      kind: "claimed" | "replay";
      delivery: WorkflowTriggerDelivery;
      context: WorkflowTriggerDeliveryContext;
    }
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
        revisionPermissions: schema.workflowRevisions.permissionRequirements,
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
    const requirements = [
      workflowPermissionRequirementsSchema.parse(context.revisionPermissions),
      ...(
        await this.database
          .select({
            permissions: schema.workflowRevisionNodes.permissionRequirements,
          })
          .from(schema.workflowRevisionNodes)
          .where(
            eq(schema.workflowRevisionNodes.revisionId, workflowRevisionId),
          )
      ).map(({ permissions }) =>
        workflowPermissionRequirementsSchema.parse(permissions),
      ),
    ];
    if (
      requirements.some(({ approvalMode }) => approvalMode !== "preauthorized")
    ) {
      throw new WorkflowTriggerConflictError(
        "Unattended triggers require every workflow stage to be preauthorized.",
      );
    }
    return { workflowId: context.workflowId };
  }

  async create(
    ownerId: string,
    input: WorkflowAutomationTriggerCreate,
  ): Promise<WorkflowAutomationTrigger | null> {
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
      input.type === "schedule"
        ? input.configuration.startAt
          ? new Date(input.configuration.startAt)
          : new Date(
              now.getTime() + input.configuration.intervalSeconds * 1_000,
            )
        : null;
    const rows = await this.database
      .insert(schema.workflowAutomationTriggers)
      .values({
        id: randomUUID(),
        workflowId: context.workflowId,
        workflowRevisionId: input.workflowRevisionId,
        ownerId,
        projectId: input.projectId,
        name: input.name,
        type: input.type,
        enabled: input.enabled,
        configuration: input.configuration,
        structuredInput: input.structuredInput,
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
  ): Promise<WorkflowAutomationTrigger[]> {
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
    return workflowAutomationTriggerListSchema.parse(rows.map(toTrigger));
  }

  async get(
    ownerId: string,
    triggerId: string,
  ): Promise<WorkflowAutomationTrigger | null> {
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
      credentialHash:
        row.type === "webhook" &&
        typeof row.configuration.credentialHash === "string"
          ? row.configuration.credentialHash
          : null,
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
      credentialHash:
        typeof row.configuration.credentialHash === "string"
          ? row.configuration.credentialHash
          : null,
    };
  }

  async update(
    ownerId: string,
    triggerId: string,
    input: WorkflowAutomationTriggerUpdate,
  ): Promise<WorkflowAutomationTrigger | null> {
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
        ...(input.name !== undefined ? { name: input.name } : {}),
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

  async claimDelivery(
    ownerId: string,
    triggerId: string,
    idempotencyKey: string,
    provenance: WorkflowTriggerProvenance,
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
        credentialHash:
          row.type === "webhook" &&
          typeof row.configuration.credentialHash === "string"
            ? row.configuration.credentialHash
            : null,
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
          triggerProvenance: provenance,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await transaction
        .update(schema.workflowAutomationTriggers)
        .set({ lastDeliveredAt: now, lastError: null, updatedAt: now })
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
  ): Promise<WorkflowTriggerDelivery> {
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
        ),
      )
      .returning();
    await this.database
      .update(schema.workflowAutomationTriggers)
      .set({ lastRunId: runId, lastError: null, updatedAt: now })
      .where(
        and(
          eq(schema.workflowAutomationTriggers.id, triggerId),
          eq(schema.workflowAutomationTriggers.ownerId, ownerId),
        ),
      );
    return toDelivery(rows[0]!);
  }

  async failDelivery(
    ownerId: string,
    deliveryId: string,
    triggerId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    if (!(await this.getDeliveryContext(ownerId, triggerId))) return;
    const now = new Date();
    await this.database
      .update(schema.workflowTriggerDeliveries)
      .set({
        status: "failed",
        errorCode,
        errorMessage: errorMessage.slice(0, 5_000),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.workflowTriggerDeliveries.id, deliveryId),
          eq(schema.workflowTriggerDeliveries.triggerId, triggerId),
        ),
      );
    await this.database
      .update(schema.workflowAutomationTriggers)
      .set({ lastError: errorMessage.slice(0, 5_000), updatedAt: now })
      .where(
        and(
          eq(schema.workflowAutomationTriggers.id, triggerId),
          eq(schema.workflowAutomationTriggers.ownerId, ownerId),
        ),
      );
  }

  async advanceSchedule(
    ownerId: string,
    triggerId: string,
    expected: Date,
    next: Date,
    lastError: string | null = null,
  ): Promise<boolean> {
    const rows = await this.database
      .update(schema.workflowAutomationTriggers)
      .set({ nextRunAt: next, lastError, updatedAt: new Date() })
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
