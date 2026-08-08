import { randomUUID } from "node:crypto";

import {
  workflowApprovalGateSchema,
  workflowNodeAttemptSchema,
  workflowPermissionRequirementsSchema,
  workflowRunDetailSchema,
  workflowRunEventPageSchema,
  workflowRunEventSchema,
  workflowRunNodeDependencySchema,
  workflowRunNodeSchema,
  workflowRunSchema,
  type WorkflowPermissionRequirements,
  type WorkflowRun,
  type WorkflowRunCreate,
  type WorkflowRunDetail,
  type WorkflowRunEventPage,
  type WorkflowRunEventQuery,
  type WorkflowRunQuery,
} from "@cantrip/protocol/workflows";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";

type WorkflowRunDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type WorkflowRunRow = typeof schema.workflowRuns.$inferSelect;

export class WorkflowRunConflictError extends Error {}

function toISOString(value: Date): string {
  return value.toISOString();
}

function nullableISOString(value: Date | null): string | null {
  return value ? toISOString(value) : null;
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

function permissionManifestCovers(
  manifest: WorkflowPermissionRequirements,
  requirement: WorkflowPermissionRequirements,
): boolean {
  const filesystemRank = { "read-only": 0, "workspace-write": 1 } as const;
  const networkRank = { none: 0, restricted: 1, unrestricted: 2 } as const;
  const manifestSkills = new Set(manifest.skills);
  const manifestMcpServers = new Set(manifest.mcpServers);
  return (
    filesystemRank[manifest.filesystem] >=
      filesystemRank[requirement.filesystem] &&
    networkRank[manifest.network] >= networkRank[requirement.network] &&
    (requirement.approvalMode !== "preauthorized" ||
      manifest.approvalMode === "preauthorized") &&
    requirement.skills.every((skill) => manifestSkills.has(skill)) &&
    requirement.mcpServers.every((server) => manifestMcpServers.has(server)) &&
    (!requirement.nativeSubagents || manifest.nativeSubagents)
  );
}

function toRun(run: WorkflowRunRow): WorkflowRun {
  return workflowRunSchema.parse({
    id: run.id,
    workflowId: run.workflowId,
    workflowRevisionId: run.workflowRevisionId,
    ownerId: run.ownerId,
    projectId: run.projectId,
    status: run.status,
    trigger: {
      ...run.triggerProvenance,
      type: run.triggerType,
      sourceId: run.triggerId,
    },
    idempotencyKey: run.idempotencyKey,
    structuredInput: run.structuredInput,
    structuredResult: run.structuredResult,
    budget: run.budget,
    measuredUsage: run.measuredUsage,
    permissionManifest: run.permissionManifest,
    selectedModelRouteId: run.selectedModelRouteId,
    selectedPermissionProfileId: run.selectedPermissionProfileId,
    workerId: run.workerId,
    worktreeId: run.worktreeId,
    codexThreadId: run.codexThreadId,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    pauseReason: run.pauseReason,
    cancelReason: run.cancelReason,
    recoveryState: run.recoveryState,
    queuedAt: toISOString(run.queuedAt),
    startedAt: nullableISOString(run.startedAt),
    pausedAt: nullableISOString(run.pausedAt),
    cancelRequestedAt: nullableISOString(run.cancelRequestedAt),
    completedAt: nullableISOString(run.completedAt),
    createdAt: toISOString(run.createdAt),
    updatedAt: toISOString(run.updatedAt),
  });
}

export interface WorkflowRunCreateResult {
  created: boolean;
  run: WorkflowRunDetail;
}

export class WorkflowRunRepository {
  constructor(private readonly database: WorkflowRunDatabase) {}

  async listRuns(
    ownerId: string,
    query: WorkflowRunQuery,
  ): Promise<WorkflowRun[]> {
    const conditions = [eq(schema.workflowRuns.ownerId, ownerId)];
    if (query.workflowId) {
      conditions.push(eq(schema.workflowRuns.workflowId, query.workflowId));
    }
    if (query.projectId) {
      conditions.push(eq(schema.workflowRuns.projectId, query.projectId));
    }
    if (query.status) {
      conditions.push(eq(schema.workflowRuns.status, query.status));
    }
    if (query.recoveryState) {
      conditions.push(
        eq(schema.workflowRuns.recoveryState, query.recoveryState),
      );
    }
    const rows = await this.database
      .select()
      .from(schema.workflowRuns)
      .where(and(...conditions))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(query.limit);
    return rows.map(toRun);
  }

  async createRun(
    ownerId: string,
    input: WorkflowRunCreate,
  ): Promise<WorkflowRunCreateResult | null> {
    const contextRows = await this.database
      .select({
        definition: schema.workflowDefinitions,
        revision: schema.workflowRevisions,
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
      .where(eq(schema.workflowRevisions.id, input.workflowRevisionId))
      .limit(1);
    const context = contextRows[0];
    if (!context) return null;

    const effectiveProjectId = await this.effectiveProjectId(
      ownerId,
      context.definition,
      input.projectId,
    );
    if (effectiveProjectId === undefined) return null;

    const existing = await this.runByIdempotencyKey(
      ownerId,
      input.idempotencyKey,
    );
    if (existing) {
      this.assertIdempotentInput(existing, effectiveProjectId, input);
      return {
        created: false,
        run: (await this.getRun(ownerId, existing.id))!,
      };
    }

    if (context.definition.archivedAt) {
      throw new WorkflowRunConflictError("Archived workflows cannot be run.");
    }
    if (
      context.definition.trustState === "blocked" ||
      context.revision.trustState === "blocked"
    ) {
      throw new WorkflowRunConflictError("Blocked workflows cannot be run.");
    }

    const [revisionNodes, revisionEdges] = await Promise.all([
      this.database
        .select()
        .from(schema.workflowRevisionNodes)
        .where(eq(schema.workflowRevisionNodes.revisionId, context.revision.id))
        .orderBy(asc(schema.workflowRevisionNodes.position)),
      this.database
        .select()
        .from(schema.workflowRevisionEdges)
        .where(eq(schema.workflowRevisionEdges.revisionId, context.revision.id))
        .orderBy(asc(schema.workflowRevisionEdges.position)),
    ]);
    if (input.budget.maxNodes < revisionNodes.length) {
      throw new WorkflowRunConflictError(
        "The run node budget is smaller than this workflow revision.",
      );
    }
    const requirements = [
      workflowPermissionRequirementsSchema.parse(
        context.revision.permissionRequirements,
      ),
      ...revisionNodes.map((node) =>
        workflowPermissionRequirementsSchema.parse(node.permissionRequirements),
      ),
    ];
    if (
      requirements.some(
        (requirement) =>
          !permissionManifestCovers(input.permissionManifest, requirement),
      )
    ) {
      throw new WorkflowRunConflictError(
        "The run permission manifest does not cover every workflow requirement.",
      );
    }
    const routeIds = new Set(
      [
        input.selectedModelRouteId,
        ...revisionNodes.map(({ modelRouteId }) => modelRouteId),
      ].filter((id): id is string => id !== null),
    );
    if (!(await this.modelRoutesAreAvailable(ownerId, [...routeIds]))) {
      throw new WorkflowRunConflictError(
        "A selected workflow model route is unavailable.",
      );
    }

    const runId = randomUUID();
    const now = new Date();
    try {
      await this.database.transaction(async (transaction) => {
        await transaction.insert(schema.workflowRuns).values({
          id: runId,
          workflowId: context.definition.id,
          workflowRevisionId: context.revision.id,
          ownerId,
          projectId: effectiveProjectId,
          status: "queued",
          triggerType: input.trigger.type,
          triggerId: input.trigger.sourceId,
          triggerProvenance: input.trigger,
          idempotencyKey: input.idempotencyKey,
          structuredInput: input.structuredInput,
          budget: input.budget,
          permissionManifest: input.permissionManifest,
          selectedModelRouteId: input.selectedModelRouteId,
          selectedPermissionProfileId: input.selectedPermissionProfileId,
          recoveryState: "stable",
          queuedAt: now,
          createdAt: now,
          updatedAt: now,
        });

        const incomingCount = new Map(
          revisionNodes.map((node) => [node.id, 0]),
        );
        for (const edge of revisionEdges) {
          incomingCount.set(
            edge.toNodeId,
            (incomingCount.get(edge.toNodeId) ?? 0) + 1,
          );
        }
        const runNodes = revisionNodes.map((node) => {
          const dependencies = incomingCount.get(node.id) ?? 0;
          return {
            id: randomUUID(),
            runId,
            revisionNodeId: node.id,
            nodeKey: node.nodeKey,
            nodeType: node.nodeType,
            status: dependencies === 0 ? "ready" : "blocked",
            dependencyState: { remaining: dependencies },
            structuredInput: dependencies === 0 ? input.structuredInput : {},
            budget: input.budget,
            permissionManifest: node.permissionRequirements,
            modelRouteId: node.modelRouteId ?? input.selectedModelRouteId,
            permissionProfileId:
              node.permissionProfileId ?? input.selectedPermissionProfileId,
            writeCapable: node.mutationMode === "write",
            attemptCount: 0,
            readyAt: dependencies === 0 ? now : null,
            createdAt: now,
            updatedAt: now,
          } as const;
        });
        await transaction.insert(schema.workflowRunNodes).values(runNodes);

        if (revisionEdges.length > 0) {
          const runNodeIdByRevisionNodeId = new Map(
            runNodes.map((node) => [node.revisionNodeId, node.id]),
          );
          await transaction.insert(schema.workflowRunNodeDependencies).values(
            revisionEdges.map((edge) => ({
              id: randomUUID(),
              runId,
              revisionEdgeId: edge.id,
              fromNodeId: runNodeIdByRevisionNodeId.get(edge.fromNodeId)!,
              toNodeId: runNodeIdByRevisionNodeId.get(edge.toNodeId)!,
              status: "blocked",
              resultMapping: {
                sourceOutput: edge.sourceOutput,
                targetInput: edge.targetInput,
                condition: edge.condition,
              },
              createdAt: now,
            })),
          );
        }

        await transaction.insert(schema.workflowRunEvents).values({
          runId,
          runNodeId: null,
          attemptId: null,
          sequence: 0,
          eventKey: `run-created:${runId}`,
          type: "run.created",
          payload: {
            workflowId: context.definition.id,
            workflowRevisionId: context.revision.id,
            revision: context.revision.revision,
            nodeCount: revisionNodes.length,
            readyNodeCount: runNodes.filter(({ status }) => status === "ready")
              .length,
          },
          actorType: input.trigger.actorType,
          actorId: input.trigger.actorId,
          createdAt: now,
        });
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const duplicate = await this.runByIdempotencyKey(
        ownerId,
        input.idempotencyKey,
      );
      if (!duplicate) throw error;
      this.assertIdempotentInput(duplicate, effectiveProjectId, input);
      return {
        created: false,
        run: (await this.getRun(ownerId, duplicate.id))!,
      };
    }
    return { created: true, run: (await this.getRun(ownerId, runId))! };
  }

  async getRun(
    ownerId: string,
    runId: string,
  ): Promise<WorkflowRunDetail | null> {
    const run = await this.runRow(ownerId, runId);
    if (!run) return null;
    const [nodes, dependencies, attempts, gates] = await Promise.all([
      this.database
        .select({ node: schema.workflowRunNodes })
        .from(schema.workflowRunNodes)
        .innerJoin(
          schema.workflowRevisionNodes,
          eq(
            schema.workflowRevisionNodes.id,
            schema.workflowRunNodes.revisionNodeId,
          ),
        )
        .where(eq(schema.workflowRunNodes.runId, runId))
        .orderBy(asc(schema.workflowRevisionNodes.position)),
      this.database
        .select()
        .from(schema.workflowRunNodeDependencies)
        .where(eq(schema.workflowRunNodeDependencies.runId, runId))
        .orderBy(asc(schema.workflowRunNodeDependencies.createdAt)),
      this.database
        .select({ attempt: schema.workflowNodeAttempts })
        .from(schema.workflowNodeAttempts)
        .innerJoin(
          schema.workflowRunNodes,
          and(
            eq(
              schema.workflowRunNodes.id,
              schema.workflowNodeAttempts.runNodeId,
            ),
            eq(schema.workflowRunNodes.runId, runId),
          ),
        )
        .orderBy(asc(schema.workflowNodeAttempts.createdAt)),
      this.database
        .select()
        .from(schema.workflowApprovalGates)
        .where(eq(schema.workflowApprovalGates.runId, runId))
        .orderBy(asc(schema.workflowApprovalGates.createdAt)),
    ]);
    return workflowRunDetailSchema.parse({
      run: toRun(run),
      nodes: nodes.map(({ node }) =>
        workflowRunNodeSchema.parse({
          id: node.id,
          runId: node.runId,
          revisionNodeId: node.revisionNodeId,
          nodeKey: node.nodeKey,
          nodeType: node.nodeType,
          status: node.status,
          dependencyState: node.dependencyState,
          structuredInput: node.structuredInput,
          structuredResult: node.structuredResult,
          budget: node.budget,
          measuredUsage: node.measuredUsage,
          permissionManifest: node.permissionManifest,
          workerId: node.workerId,
          worktreeId: node.worktreeId,
          modelRouteId: node.modelRouteId,
          permissionProfileId: node.permissionProfileId,
          codexThreadId: node.codexThreadId,
          codexTurnId: node.codexTurnId,
          writeCapable: node.writeCapable,
          executionLeaseKey: node.executionLeaseKey,
          attemptCount: node.attemptCount,
          notBefore: nullableISOString(node.notBefore),
          timeoutAt: nullableISOString(node.timeoutAt),
          readyAt: nullableISOString(node.readyAt),
          startedAt: nullableISOString(node.startedAt),
          waitingAt: nullableISOString(node.waitingAt),
          completedAt: nullableISOString(node.completedAt),
          createdAt: toISOString(node.createdAt),
          updatedAt: toISOString(node.updatedAt),
        }),
      ),
      dependencies: dependencies.map((dependency) =>
        workflowRunNodeDependencySchema.parse({
          ...dependency,
          satisfiedAt: nullableISOString(dependency.satisfiedAt),
          createdAt: toISOString(dependency.createdAt),
        }),
      ),
      attempts: attempts.map(({ attempt }) =>
        workflowNodeAttemptSchema.parse({
          ...attempt,
          startedAt: nullableISOString(attempt.startedAt),
          heartbeatAt: nullableISOString(attempt.heartbeatAt),
          completedAt: nullableISOString(attempt.completedAt),
          createdAt: toISOString(attempt.createdAt),
          updatedAt: toISOString(attempt.updatedAt),
        }),
      ),
      gates: gates.map((gate) =>
        workflowApprovalGateSchema.parse({
          ...gate,
          expiresAt: nullableISOString(gate.expiresAt),
          decidedAt: nullableISOString(gate.decidedAt),
          createdAt: toISOString(gate.createdAt),
          updatedAt: toISOString(gate.updatedAt),
        }),
      ),
    });
  }

  async listEvents(
    ownerId: string,
    runId: string,
    query: WorkflowRunEventQuery,
  ): Promise<WorkflowRunEventPage | null> {
    if (!(await this.runRow(ownerId, runId))) return null;
    const rows = await this.database
      .select()
      .from(schema.workflowRunEvents)
      .where(
        and(
          eq(schema.workflowRunEvents.runId, runId),
          gt(schema.workflowRunEvents.sequence, query.afterSequence),
        ),
      )
      .orderBy(asc(schema.workflowRunEvents.sequence))
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const pageRows = rows.slice(0, query.limit);
    return workflowRunEventPageSchema.parse({
      events: pageRows.map((event) =>
        workflowRunEventSchema.parse({
          ...event,
          createdAt: toISOString(event.createdAt),
        }),
      ),
      nextSequence: hasMore
        ? (pageRows[pageRows.length - 1]?.sequence ?? null)
        : null,
    });
  }

  private async effectiveProjectId(
    ownerId: string,
    definition: typeof schema.workflowDefinitions.$inferSelect,
    requestedProjectId: string | null,
  ): Promise<string | null | undefined> {
    if (definition.scope === "project") {
      if (
        !definition.projectId ||
        (requestedProjectId !== null &&
          requestedProjectId !== definition.projectId)
      ) {
        return undefined;
      }
      return definition.projectId;
    }
    if (requestedProjectId === null) return null;
    const projects = await this.database
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, requestedProjectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    return projects[0] ? requestedProjectId : undefined;
  }

  private async modelRoutesAreAvailable(
    ownerId: string,
    routeIds: string[],
  ): Promise<boolean> {
    if (routeIds.length === 0) return true;
    const routes = await this.database
      .select({ id: schema.modelRoutes.id })
      .from(schema.modelRoutes)
      .innerJoin(
        schema.modelProfiles,
        and(
          eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
          eq(schema.modelProfiles.ownerId, ownerId),
        ),
      )
      .where(
        and(
          inArray(schema.modelRoutes.id, routeIds),
          eq(schema.modelRoutes.enabled, true),
        ),
      );
    return new Set(routes.map(({ id }) => id)).size === routeIds.length;
  }

  private async runByIdempotencyKey(
    ownerId: string,
    idempotencyKey: string,
  ): Promise<WorkflowRunRow | null> {
    const rows = await this.database
      .select()
      .from(schema.workflowRuns)
      .where(
        and(
          eq(schema.workflowRuns.ownerId, ownerId),
          eq(schema.workflowRuns.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async runRow(
    ownerId: string,
    runId: string,
  ): Promise<WorkflowRunRow | null> {
    const rows = await this.database
      .select()
      .from(schema.workflowRuns)
      .where(
        and(
          eq(schema.workflowRuns.id, runId),
          eq(schema.workflowRuns.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private assertIdempotentInput(
    existing: WorkflowRunRow,
    effectiveProjectId: string | null,
    input: WorkflowRunCreate,
  ): void {
    const existingInput = {
      workflowRevisionId: existing.workflowRevisionId,
      projectId: existing.projectId,
      structuredInput: existing.structuredInput,
      budget: existing.budget,
      permissionManifest: existing.permissionManifest,
      selectedModelRouteId: existing.selectedModelRouteId,
      selectedPermissionProfileId: existing.selectedPermissionProfileId,
      trigger: {
        ...existing.triggerProvenance,
        type: existing.triggerType,
        sourceId: existing.triggerId,
      },
      idempotencyKey: existing.idempotencyKey,
    };
    const requestedInput = { ...input, projectId: effectiveProjectId };
    if (canonicalJson(existingInput) !== canonicalJson(requestedInput)) {
      throw new WorkflowRunConflictError(
        "This run idempotency key was already used with different input.",
      );
    }
  }
}
