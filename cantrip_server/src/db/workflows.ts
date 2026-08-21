import {
  encryptedWorkflowDefinitionCreateSchema,
  encryptedWorkflowDefinitionUpdateSchema,
  encryptedWorkflowRevisionCreateSchema,
  workflowDefinitionWireDetailSchema,
  workflowDefinitionWireSummarySchema,
  workflowRevisionWireSchema,
  workflowRevisionWireSummarySchema,
  type EncryptedWorkflowDefinitionCreate,
  type EncryptedWorkflowDefinitionUpdate,
  type EncryptedWorkflowRevisionCreate,
  type WorkflowDefinitionQuery,
  type WorkflowDefinitionWireDetail,
  type WorkflowDefinitionWireSummary,
  type WorkflowRevisionWire,
  type WorkflowRevisionWireSummary,
} from "@cantrip/protocol/workflows";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";

type WorkflowDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type WorkflowTransaction = Parameters<
  Parameters<WorkflowDatabase["transaction"]>[0]
>[0];
type WorkflowDefinitionRow = typeof schema.workflowDefinitions.$inferSelect;
type WorkflowRevisionRow = typeof schema.workflowRevisions.$inferSelect;

export class WorkflowConflictError extends Error {}

function toISOString(value: Date): string {
  return value.toISOString();
}

function isUniqueViolation(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (typeof current === "object") {
      const code = "code" in current ? current.code : null;
      if (code === "23505") return true;
      if (
        current instanceof Error &&
        /duplicate key|unique constraint/iu.test(current.message)
      ) {
        return true;
      }
      current = "cause" in current ? current.cause : null;
    } else {
      break;
    }
  }
  return false;
}

function toRevisionWireSummary(
  revision: WorkflowRevisionRow,
): WorkflowRevisionWireSummary {
  return workflowRevisionWireSummarySchema.parse({
    id: revision.id,
    workflowId: revision.workflowId,
    revision: revision.revision,
    source: revision.source,
    trustState: revision.trustState,
    content: {
      protectedProvenance: revision.protectedProvenance,
      protectedContentHash: revision.protectedContentHash,
    },
    createdByUserId: revision.createdByUserId,
    createdAt: toISOString(revision.createdAt),
  });
}

function toDefinitionWireSummary(
  definition: WorkflowDefinitionRow,
  latestRevision: WorkflowRevisionRow | null,
): WorkflowDefinitionWireSummary {
  return workflowDefinitionWireSummarySchema.parse({
    id: definition.id,
    ownerId: definition.ownerId,
    projectId: definition.projectId,
    scope: definition.scope,
    source: definition.source,
    content: {
      protectedSlug: definition.protectedSlug,
      protectedName: definition.protectedName,
      protectedDescription: definition.protectedDescription,
      protectedProvenance: definition.protectedProvenance,
    },
    trustState: definition.trustState,
    archivedAt: definition.archivedAt
      ? toISOString(definition.archivedAt)
      : null,
    latestRevision: latestRevision
      ? toRevisionWireSummary(latestRevision)
      : null,
    createdAt: toISOString(definition.createdAt),
    updatedAt: toISOString(definition.updatedAt),
  });
}

export class WorkflowRepository {
  constructor(private readonly database: WorkflowDatabase) {}

  async listDefinitions(
    ownerId: string,
    query: WorkflowDefinitionQuery,
  ): Promise<WorkflowDefinitionWireSummary[]> {
    const conditions = [eq(schema.workflowDefinitions.ownerId, ownerId)];
    if (query.scope) {
      conditions.push(eq(schema.workflowDefinitions.scope, query.scope));
    }
    if (query.projectId) {
      conditions.push(
        eq(schema.workflowDefinitions.projectId, query.projectId),
      );
    }
    if (!query.includeArchived) {
      conditions.push(isNull(schema.workflowDefinitions.archivedAt));
    }
    const definitions = await this.database
      .select()
      .from(schema.workflowDefinitions)
      .where(and(...conditions))
      .orderBy(desc(schema.workflowDefinitions.updatedAt))
      .limit(query.limit);
    const latestByWorkflow = await this.latestRevisions(
      definitions.map(({ id }) => id),
    );
    return definitions.map((definition) =>
      toDefinitionWireSummary(
        definition,
        latestByWorkflow.get(definition.id) ?? null,
      ),
    );
  }

  async createDefinition(
    ownerId: string,
    rawInput: EncryptedWorkflowDefinitionCreate,
  ): Promise<WorkflowDefinitionWireDetail | null> {
    const input = encryptedWorkflowDefinitionCreateSchema.parse(rawInput);
    if (
      input.scope === "project" &&
      !(await this.projectBelongsToOwner(ownerId, input.projectId!))
    ) {
      return null;
    }
    const existing = await this.database
      .select({ id: schema.workflowDefinitions.id })
      .from(schema.workflowDefinitions)
      .where(
        and(
          eq(schema.workflowDefinitions.ownerId, ownerId),
          eq(schema.workflowDefinitions.scope, input.scope),
          eq(schema.workflowDefinitions.slugBlindIndex, input.slugBlindIndex),
          input.scope === "personal"
            ? isNull(schema.workflowDefinitions.projectId)
            : eq(schema.workflowDefinitions.projectId, input.projectId!),
        ),
      )
      .limit(1);
    if (existing[0]) {
      throw new WorkflowConflictError(
        "A workflow with this slug already exists in the selected scope.",
      );
    }

    const workflowId = input.id;
    try {
      await this.database.transaction(async (transaction) => {
        await transaction.insert(schema.workflowDefinitions).values({
          id: workflowId,
          ownerId,
          projectId: input.projectId,
          scope: input.scope,
          slugBlindIndex: input.slugBlindIndex,
          protectedSlug: input.content.protectedSlug,
          protectedName: input.content.protectedName,
          protectedDescription: input.content.protectedDescription,
          source: input.source,
          protectedProvenance: input.content.protectedProvenance,
          trustState: input.trustState,
        });
        await this.insertRevision(
          transaction,
          workflowId,
          ownerId,
          input.revision,
          1,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WorkflowConflictError(
          "A workflow with this slug already exists in the selected scope.",
        );
      }
      throw error;
    }
    return this.getDefinition(ownerId, workflowId);
  }

  async getDefinition(
    ownerId: string,
    workflowId: string,
  ): Promise<WorkflowDefinitionWireDetail | null> {
    const definition = await this.definitionRow(ownerId, workflowId);
    if (!definition) return null;
    const revisionRows = await this.database
      .select()
      .from(schema.workflowRevisions)
      .where(eq(schema.workflowRevisions.workflowId, workflowId))
      .orderBy(desc(schema.workflowRevisions.revision))
      .limit(1);
    const revision = revisionRows[0]
      ? await this.loadRevision(revisionRows[0])
      : null;
    return workflowDefinitionWireDetailSchema.parse({
      workflow: toDefinitionWireSummary(definition, revisionRows[0] ?? null),
      revision,
    });
  }

  async updateDefinition(
    ownerId: string,
    workflowId: string,
    rawInput: EncryptedWorkflowDefinitionUpdate,
  ): Promise<WorkflowDefinitionWireSummary | null> {
    const input = encryptedWorkflowDefinitionUpdateSchema.parse(rawInput);
    const definition = await this.definitionRow(ownerId, workflowId);
    if (!definition) return null;
    const now = new Date();
    const rows = await this.database
      .update(schema.workflowDefinitions)
      .set({
        ...(input.content?.protectedName !== undefined
          ? { protectedName: input.content.protectedName }
          : {}),
        ...(input.content?.protectedDescription !== undefined
          ? { protectedDescription: input.content.protectedDescription }
          : {}),
        ...(input.trustState !== undefined
          ? { trustState: input.trustState }
          : {}),
        ...(input.archived !== undefined
          ? {
              archivedAt: input.archived
                ? (definition.archivedAt ?? now)
                : null,
            }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.workflowDefinitions.id, workflowId),
          eq(schema.workflowDefinitions.ownerId, ownerId),
        ),
      )
      .returning();
    const updated = rows[0];
    if (!updated) return null;
    const latest = await this.latestRevisions([workflowId]);
    return toDefinitionWireSummary(updated, latest.get(workflowId) ?? null);
  }

  async listRevisions(
    ownerId: string,
    workflowId: string,
  ): Promise<WorkflowRevisionWireSummary[] | null> {
    if (!(await this.definitionRow(ownerId, workflowId))) return null;
    const rows = await this.database
      .select()
      .from(schema.workflowRevisions)
      .where(eq(schema.workflowRevisions.workflowId, workflowId))
      .orderBy(desc(schema.workflowRevisions.revision));
    return rows.map(toRevisionWireSummary);
  }

  async getRevision(
    ownerId: string,
    workflowId: string,
    revisionNumber: number,
  ): Promise<WorkflowRevisionWire | null> {
    if (!(await this.definitionRow(ownerId, workflowId))) return null;
    const rows = await this.database
      .select()
      .from(schema.workflowRevisions)
      .where(
        and(
          eq(schema.workflowRevisions.workflowId, workflowId),
          eq(schema.workflowRevisions.revision, revisionNumber),
        ),
      )
      .limit(1);
    return rows[0] ? this.loadRevision(rows[0]) : null;
  }

  async getRevisionById(
    ownerId: string,
    workflowId: string,
    revisionId: string,
  ): Promise<WorkflowRevisionWire | null> {
    if (!(await this.definitionRow(ownerId, workflowId))) return null;
    const rows = await this.database
      .select()
      .from(schema.workflowRevisions)
      .where(
        and(
          eq(schema.workflowRevisions.id, revisionId),
          eq(schema.workflowRevisions.workflowId, workflowId),
        ),
      )
      .limit(1);
    return rows[0] ? this.loadRevision(rows[0]) : null;
  }

  async appendRevision(
    ownerId: string,
    workflowId: string,
    rawInput: EncryptedWorkflowRevisionCreate,
  ): Promise<WorkflowRevisionWire | null> {
    const input = encryptedWorkflowRevisionCreateSchema.parse(rawInput);
    if (!(await this.definitionRow(ownerId, workflowId))) return null;
    const existing = await this.revisionByHash(
      workflowId,
      input.contentBlindIndex,
    );
    if (existing) return this.loadRevision(existing);

    let revisionNumber = 1;
    try {
      await this.database.transaction(async (transaction) => {
        const existingRows = await transaction
          .select()
          .from(schema.workflowRevisions)
          .where(
            and(
              eq(schema.workflowRevisions.workflowId, workflowId),
              eq(
                schema.workflowRevisions.contentBlindIndex,
                input.contentBlindIndex,
              ),
            ),
          )
          .limit(1);
        if (existingRows[0]) {
          revisionNumber = existingRows[0].revision;
          return;
        }
        const latestRows = await transaction
          .select({ revision: schema.workflowRevisions.revision })
          .from(schema.workflowRevisions)
          .where(eq(schema.workflowRevisions.workflowId, workflowId))
          .orderBy(desc(schema.workflowRevisions.revision))
          .limit(1);
        revisionNumber = (latestRows[0]?.revision ?? 0) + 1;
        await this.insertRevision(
          transaction,
          workflowId,
          ownerId,
          input,
          revisionNumber,
        );
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const duplicate = await this.revisionByHash(
        workflowId,
        input.contentBlindIndex,
      );
      if (duplicate) return this.loadRevision(duplicate);
      throw new WorkflowConflictError(
        "Another revision was appended concurrently; retry this request.",
      );
    }
    return this.getRevision(ownerId, workflowId, revisionNumber);
  }

  private async definitionRow(
    ownerId: string,
    workflowId: string,
  ): Promise<WorkflowDefinitionRow | null> {
    const rows = await this.database
      .select()
      .from(schema.workflowDefinitions)
      .where(
        and(
          eq(schema.workflowDefinitions.id, workflowId),
          eq(schema.workflowDefinitions.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async projectBelongsToOwner(
    ownerId: string,
    projectId: string,
  ): Promise<boolean> {
    const rows = await this.database
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    return Boolean(rows[0]);
  }

  private async latestRevisions(
    workflowIds: string[],
  ): Promise<Map<string, WorkflowRevisionRow>> {
    if (workflowIds.length === 0) return new Map();
    const rows = await this.database
      .select()
      .from(schema.workflowRevisions)
      .where(inArray(schema.workflowRevisions.workflowId, workflowIds))
      .orderBy(desc(schema.workflowRevisions.revision));
    const latest = new Map<string, WorkflowRevisionRow>();
    for (const row of rows) {
      if (!latest.has(row.workflowId)) latest.set(row.workflowId, row);
    }
    return latest;
  }

  private async revisionByHash(
    workflowId: string,
    contentBlindIndex: string,
  ): Promise<WorkflowRevisionRow | null> {
    const rows = await this.database
      .select()
      .from(schema.workflowRevisions)
      .where(
        and(
          eq(schema.workflowRevisions.workflowId, workflowId),
          eq(schema.workflowRevisions.contentBlindIndex, contentBlindIndex),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async insertRevision(
    transaction: WorkflowTransaction,
    workflowId: string,
    createdByUserId: string,
    input: EncryptedWorkflowRevisionCreate,
    revisionNumber: number,
  ): Promise<void> {
    const revisionId = input.id;
    await transaction.insert(schema.workflowRevisions).values({
      id: revisionId,
      workflowId,
      revision: revisionNumber,
      declaredInputs: {},
      declaredOutputs: {},
      defaults: {},
      permissionRequirements: {},
      source: input.source,
      protectedProvenance: input.content.protectedProvenance,
      trustState: input.trustState,
      contentBlindIndex: input.contentBlindIndex,
      protectedContentHash: input.content.protectedContentHash,
      protectedDefinition: input.content.protectedDefinition,
      createdByUserId,
    });
    const nodeRows = input.manifest.nodes.map((node, position) => ({
      id: node.id,
      revisionId,
      nodeKey: `node-${position + 1}`,
      nodeType: node.type,
      name: "Encrypted workflow node",
      position,
      configuration: {},
      inputSchema: {},
      outputSchema: {},
      permissionRequirements: {
        filesystem:
          node.mutationMode === "write" ? "workspace-write" : "read-only",
        network: "none",
        approvalMode: "interactive",
        skills: [],
        mcpServers: [],
        nativeSubagents: false,
      },
      mutationMode: node.mutationMode,
      modelRouteId: node.modelRouteId,
      permissionProfileId: node.permissionProfileId,
    }));
    await transaction.insert(schema.workflowRevisionNodes).values(nodeRows);
    if (input.manifest.edges.length === 0) return;
    await transaction.insert(schema.workflowRevisionEdges).values(
      input.manifest.edges.map((edge, position) => ({
        id: edge.id,
        revisionId,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        sourceOutput: null,
        targetInput: null,
        condition: null,
        position,
      })),
    );
  }

  private async loadRevision(
    revision: WorkflowRevisionRow,
  ): Promise<WorkflowRevisionWire> {
    const [nodes, edges] = await Promise.all([
      this.database
        .select()
        .from(schema.workflowRevisionNodes)
        .where(eq(schema.workflowRevisionNodes.revisionId, revision.id))
        .orderBy(asc(schema.workflowRevisionNodes.position)),
      this.database
        .select()
        .from(schema.workflowRevisionEdges)
        .where(eq(schema.workflowRevisionEdges.revisionId, revision.id))
        .orderBy(asc(schema.workflowRevisionEdges.position)),
    ]);
    const manifestNodes = nodes.map((node) => ({
      id: node.id,
      type: node.nodeType,
      mutationMode: node.mutationMode,
      modelRouteId: node.modelRouteId,
      permissionProfileId: node.permissionProfileId,
      createdAt: toISOString(node.createdAt),
    }));
    const manifestEdges = edges.map((edge) => ({
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      createdAt: toISOString(edge.createdAt),
    }));
    const summary = toRevisionWireSummary(revision);
    return workflowRevisionWireSchema.parse({
      ...summary,
      content: {
        ...summary.content,
        protectedDefinition: revision.protectedDefinition,
      },
      manifest: {
        version: 1,
        nodes: manifestNodes,
        edges: manifestEdges,
      },
    });
  }
}
