import { createHash, randomUUID } from "node:crypto";

import {
  workflowDefinitionDetailSchema,
  workflowDefinitionSummarySchema,
  workflowRevisionSchema,
  workflowRevisionSummarySchema,
  type WorkflowDefinitionCreate,
  type WorkflowDefinitionDetail,
  type WorkflowDefinitionQuery,
  type WorkflowDefinitionSummary,
  type WorkflowDefinitionUpdate,
  type WorkflowRevision,
  type WorkflowRevisionCreate,
  type WorkflowRevisionSummary,
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function revisionContentHash(input: WorkflowRevisionCreate): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(input))
    .digest("hex")}`;
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

function toRevisionSummary(
  revision: WorkflowRevisionRow,
): WorkflowRevisionSummary {
  return workflowRevisionSummarySchema.parse({
    id: revision.id,
    workflowId: revision.workflowId,
    revision: revision.revision,
    source: revision.source,
    provenance: revision.provenance,
    trustState: revision.trustState,
    contentHash: revision.contentHash,
    createdByUserId: revision.createdByUserId,
    createdAt: toISOString(revision.createdAt),
  });
}

function toDefinitionSummary(
  definition: WorkflowDefinitionRow,
  latestRevision: WorkflowRevisionRow | null,
): WorkflowDefinitionSummary {
  return workflowDefinitionSummarySchema.parse({
    id: definition.id,
    ownerId: definition.ownerId,
    projectId: definition.projectId,
    scope: definition.scope,
    slug: definition.slug,
    name: definition.name,
    description: definition.description,
    source: definition.source,
    provenance: definition.provenance,
    trustState: definition.trustState,
    archivedAt: definition.archivedAt
      ? toISOString(definition.archivedAt)
      : null,
    latestRevision: latestRevision ? toRevisionSummary(latestRevision) : null,
    createdAt: toISOString(definition.createdAt),
    updatedAt: toISOString(definition.updatedAt),
  });
}

export class WorkflowRepository {
  constructor(private readonly database: WorkflowDatabase) {}

  async listDefinitions(
    ownerId: string,
    query: WorkflowDefinitionQuery,
  ): Promise<WorkflowDefinitionSummary[]> {
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
      .orderBy(
        desc(schema.workflowDefinitions.updatedAt),
        asc(schema.workflowDefinitions.name),
      )
      .limit(query.limit);
    const latestByWorkflow = await this.latestRevisions(
      definitions.map(({ id }) => id),
    );
    return definitions.map((definition) =>
      toDefinitionSummary(
        definition,
        latestByWorkflow.get(definition.id) ?? null,
      ),
    );
  }

  async createDefinition(
    ownerId: string,
    input: WorkflowDefinitionCreate,
  ): Promise<WorkflowDefinitionDetail | null> {
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
          eq(schema.workflowDefinitions.slug, input.slug),
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

    const workflowId = randomUUID();
    try {
      await this.database.transaction(async (transaction) => {
        await transaction.insert(schema.workflowDefinitions).values({
          id: workflowId,
          ownerId,
          projectId: input.projectId,
          scope: input.scope,
          slug: input.slug,
          name: input.name,
          description: input.description,
          source: input.source,
          provenance: input.provenance,
          trustState: input.trustState,
        });
        await this.insertRevision(
          transaction,
          workflowId,
          1,
          ownerId,
          input.revision,
          revisionContentHash(input.revision),
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
  ): Promise<WorkflowDefinitionDetail | null> {
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
    return workflowDefinitionDetailSchema.parse({
      workflow: toDefinitionSummary(definition, revisionRows[0] ?? null),
      revision,
    });
  }

  async updateDefinition(
    ownerId: string,
    workflowId: string,
    input: WorkflowDefinitionUpdate,
  ): Promise<WorkflowDefinitionSummary | null> {
    const definition = await this.definitionRow(ownerId, workflowId);
    if (!definition) return null;
    const now = new Date();
    const rows = await this.database
      .update(schema.workflowDefinitions)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
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
    return toDefinitionSummary(updated, latest.get(workflowId) ?? null);
  }

  async listRevisions(
    ownerId: string,
    workflowId: string,
  ): Promise<WorkflowRevisionSummary[] | null> {
    if (!(await this.definitionRow(ownerId, workflowId))) return null;
    const rows = await this.database
      .select()
      .from(schema.workflowRevisions)
      .where(eq(schema.workflowRevisions.workflowId, workflowId))
      .orderBy(desc(schema.workflowRevisions.revision));
    return rows.map(toRevisionSummary);
  }

  async getRevision(
    ownerId: string,
    workflowId: string,
    revisionNumber: number,
  ): Promise<WorkflowRevision | null> {
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

  async appendRevision(
    ownerId: string,
    workflowId: string,
    input: WorkflowRevisionCreate,
  ): Promise<WorkflowRevision | null> {
    if (!(await this.definitionRow(ownerId, workflowId))) return null;
    const contentHash = revisionContentHash(input);
    const existing = await this.revisionByHash(workflowId, contentHash);
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
              eq(schema.workflowRevisions.contentHash, contentHash),
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
          revisionNumber,
          ownerId,
          input,
          contentHash,
        );
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const duplicate = await this.revisionByHash(workflowId, contentHash);
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
    contentHash: string,
  ): Promise<WorkflowRevisionRow | null> {
    const rows = await this.database
      .select()
      .from(schema.workflowRevisions)
      .where(
        and(
          eq(schema.workflowRevisions.workflowId, workflowId),
          eq(schema.workflowRevisions.contentHash, contentHash),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async insertRevision(
    transaction: WorkflowTransaction,
    workflowId: string,
    revisionNumber: number,
    createdByUserId: string,
    input: WorkflowRevisionCreate,
    contentHash: string,
  ): Promise<void> {
    const revisionId = randomUUID();
    await transaction.insert(schema.workflowRevisions).values({
      id: revisionId,
      workflowId,
      revision: revisionNumber,
      definition: input.graph,
      declaredInputs: input.declaredInputs,
      declaredOutputs: input.declaredOutputs,
      defaults: input.defaults,
      permissionRequirements: input.permissionRequirements,
      source: input.source,
      provenance: input.provenance,
      trustState: input.trustState,
      contentHash,
      createdByUserId,
    });
    const nodeRows = input.graph.nodes.map((node, position) => ({
      id: randomUUID(),
      revisionId,
      nodeKey: node.key,
      nodeType: node.type,
      name: node.name,
      position,
      configuration: node.configuration,
      inputSchema: node.inputSchema,
      outputSchema: node.outputSchema,
      permissionRequirements: node.permissionRequirements,
      mutationMode: node.mutationMode,
      modelRouteId: node.modelRouteId,
      permissionProfileId: node.permissionProfileId,
    }));
    await transaction.insert(schema.workflowRevisionNodes).values(nodeRows);
    if (input.graph.edges.length === 0) return;
    const nodeIdByKey = new Map(
      nodeRows.map((node) => [node.nodeKey, node.id]),
    );
    await transaction.insert(schema.workflowRevisionEdges).values(
      input.graph.edges.map((edge, position) => ({
        id: randomUUID(),
        revisionId,
        fromNodeId: nodeIdByKey.get(edge.from)!,
        toNodeId: nodeIdByKey.get(edge.to)!,
        sourceOutput: edge.sourceOutput,
        targetInput: edge.targetInput,
        condition: edge.condition,
        position,
      })),
    );
  }

  private async loadRevision(
    revision: WorkflowRevisionRow,
  ): Promise<WorkflowRevision> {
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
    const nodeKeyById = new Map(nodes.map((node) => [node.id, node.nodeKey]));
    return workflowRevisionSchema.parse({
      ...toRevisionSummary(revision),
      graph: revision.definition,
      declaredInputs: revision.declaredInputs,
      declaredOutputs: revision.declaredOutputs,
      defaults: revision.defaults,
      permissionRequirements: revision.permissionRequirements,
      nodes: nodes.map((node) => ({
        id: node.id,
        revisionId: node.revisionId,
        key: node.nodeKey,
        type: node.nodeType,
        name: node.name,
        position: node.position,
        configuration: node.configuration,
        inputSchema: node.inputSchema,
        outputSchema: node.outputSchema,
        permissionRequirements: node.permissionRequirements,
        mutationMode: node.mutationMode,
        modelRouteId: node.modelRouteId,
        permissionProfileId: node.permissionProfileId,
        createdAt: toISOString(node.createdAt),
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        revisionId: edge.revisionId,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        from: nodeKeyById.get(edge.fromNodeId),
        to: nodeKeyById.get(edge.toNodeId),
        sourceOutput: edge.sourceOutput,
        targetInput: edge.targetInput,
        condition: edge.condition,
        position: edge.position,
        createdAt: toISOString(edge.createdAt),
      })),
    });
  }
}
