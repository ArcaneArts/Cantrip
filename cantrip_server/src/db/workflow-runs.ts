import { createHash, randomUUID } from "node:crypto";

import type { WorkerEvent } from "@cantrip/protocol";
import {
  workflowApprovalGateSchema,
  workflowAgentNodeConfigurationSchema,
  workflowJsonObjectSchema,
  workflowJsonValueSchema,
  workflowMeasuredUsageSchema,
  workflowNodeAttemptSchema,
  workflowPermissionRequirementsSchema,
  workflowReduceNodeConfigurationSchema,
  workflowRunDetailSchema,
  workflowRunEventPageSchema,
  workflowRunEventSchema,
  workflowRunNodeDependencySchema,
  workflowRunNodeSchema,
  workflowRunSchema,
  workflowVerifyNodeConfigurationSchema,
  type WorkflowPermissionRequirements,
  type WorkflowAgentNodeConfiguration,
  type WorkflowBudget,
  type WorkflowJsonValue,
  type WorkflowJsonObject,
  type WorkflowMeasuredUsage,
  type WorkflowNodeRetry,
  type WorkflowRun,
  type WorkflowRunCancel,
  type WorkflowRunCreate,
  type WorkflowRunDetail,
  type WorkflowRunEventPage,
  type WorkflowRunEventQuery,
  type WorkflowRunQuery,
  type WorkflowRunNode,
  type WorkflowVerifyNodeConfiguration,
} from "@cantrip/protocol/workflows";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";
import { workflowValueAtPointer } from "../workflows/values.js";

type WorkflowRunDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type WorkflowRunRow = typeof schema.workflowRuns.$inferSelect;

export class WorkflowRunConflictError extends Error {}
export class WorkflowControlConflictError extends Error {}
class WorkflowAttemptClaimConflictError extends Error {}

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

export interface WorkflowAgentCandidate {
  configuration: WorkflowAgentNodeConfiguration | null;
  node: WorkflowRunNode;
  outputSchema: WorkflowJsonObject;
  projectId: string | null;
  run: WorkflowRun;
  structuredInput: WorkflowJsonValue;
  unsupportedReason: string | null;
  verification: WorkflowVerifyNodeConfiguration | null;
}

export interface WorkflowAttemptAssignment {
  cwd: string;
  modelRouteId: string;
  permissionProfileId: string | null;
  workerId: string;
  worktreeId: string;
}

export interface WorkflowAttemptLease {
  assignment: WorkflowAttemptAssignment;
  attempt: number;
  attemptId: string;
  budget: WorkflowBudget;
  candidate: WorkflowAgentCandidate;
  idempotencyKey: string;
}

export interface WorkflowInteractionExecutionContext {
  attemptId: string;
  modelRouteId: string;
  runId: string;
  runNodeId: string;
  workerId: string;
}

export interface WorkflowAttemptFailureResult {
  retryScheduled: boolean;
}

export interface WorkflowCancellationExecutionContext {
  attemptId: string;
  modelRouteId: string;
  runId: string;
  runNodeId: string;
  threadId: string;
  workerId: string;
}

export interface WorkflowCancellationRequestResult {
  executions: WorkflowCancellationExecutionContext[];
  replayed: boolean;
  run: WorkflowRunDetail;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return workflowJsonObjectSchema.parse(
    JSON.parse(JSON.stringify(value)) as unknown,
  );
}

function mappedWorkflowValue(
  result: unknown,
  selector: string | null,
): WorkflowJsonValue {
  const value = workflowJsonValueSchema.parse(result);
  if (selector === null) return value;
  const pointer = selector.startsWith("/")
    ? selector
    : `/${selector.replaceAll("~", "~0").replaceAll("/", "~1")}`;
  const selected = workflowValueAtPointer(value, pointer);
  if (!selected.found) {
    throw new Error(`Workflow result selector ${selector} did not match.`);
  }
  return selected.value!;
}

function aggregateWorkflowUsage(values: unknown[]): WorkflowMeasuredUsage {
  const usages = values.map((value) =>
    workflowMeasuredUsageSchema.parse(value),
  );
  const costAvailable =
    usages.length > 0 &&
    usages.every(
      ({ costAvailable: available, estimatedCostUsd }) =>
        available && estimatedCostUsd !== null,
    );
  return workflowMeasuredUsageSchema.parse({
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    cachedInputTokens: usages.reduce(
      (sum, usage) => sum + usage.cachedInputTokens,
      0,
    ),
    totalTokens: usages.reduce((sum, usage) => sum + usage.totalTokens, 0),
    durationMs: usages.reduce((sum, usage) => sum + usage.durationMs, 0),
    estimatedCostUsd: costAvailable
      ? usages.reduce((sum, usage) => sum + (usage.estimatedCostUsd ?? 0), 0)
      : null,
    costAvailable,
  });
}

function workerEventIdentity(event: WorkerEvent): string {
  const digest = createHash("sha256")
    .update(canonicalJson(event))
    .digest("hex")
    .slice(0, 24);
  return `${event.type}:${digest}`;
}

function workerEventPayload(event: WorkerEvent): Record<string, unknown> {
  try {
    return jsonObject({ event });
  } catch {
    return {
      eventType: event.type,
      attemptId: "attemptId" in event ? event.attemptId : null,
      truncated: true,
    };
  }
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

  async listDispatchableRunIds(
    ownerId: string,
    limit = 100,
  ): Promise<string[]> {
    const rows = await this.database
      .select({ id: schema.workflowRuns.id })
      .from(schema.workflowRuns)
      .where(
        and(
          eq(schema.workflowRuns.ownerId, ownerId),
          eq(schema.workflowRuns.status, "queued"),
          eq(schema.workflowRuns.recoveryState, "stable"),
        ),
      )
      .orderBy(asc(schema.workflowRuns.queuedAt))
      .limit(Math.max(1, Math.min(limit, 500)));
    return rows.map(({ id }) => id);
  }

  async getReadyAgentCandidates(
    ownerId: string,
    runId: string,
  ): Promise<WorkflowAgentCandidate[] | null> {
    const detail = await this.getRun(ownerId, runId);
    if (
      !detail ||
      !["queued", "running", "waiting"].includes(detail.run.status) ||
      detail.run.recoveryState !== "stable"
    ) {
      return null;
    }
    const activeCount = detail.nodes.filter(({ status }) =>
      ["running", "waiting-for-approval"].includes(status),
    ).length;
    const capacity = Math.max(
      0,
      detail.run.budget.maxParallelism - activeCount,
    );
    const readyNodes = detail.nodes
      .filter(({ status }) => status === "ready")
      .slice(0, capacity);
    if (readyNodes.length === 0) return [];
    const revisionRows = await this.database
      .select()
      .from(schema.workflowRevisionNodes)
      .where(
        inArray(
          schema.workflowRevisionNodes.id,
          readyNodes.map(({ revisionNodeId }) => revisionNodeId),
        ),
      )
      .orderBy(asc(schema.workflowRevisionNodes.position));
    const revisionById = new Map(revisionRows.map((row) => [row.id, row]));
    return readyNodes.map((node) => {
      const revisionNode = revisionById.get(node.revisionNodeId);
      const nodeInput = workflowJsonValueSchema.parse(node.structuredInput);
      let configuration: WorkflowAgentNodeConfiguration | null = null;
      let structuredInput = nodeInput;
      let verification: WorkflowVerifyNodeConfiguration | null = null;
      let unsupportedReason: string | null = null;
      if (!revisionNode) {
        unsupportedReason = "The workflow revision node is unavailable.";
      } else if (node.nodeType === "agent") {
        const parsed = workflowAgentNodeConfigurationSchema.safeParse(
          revisionNode.configuration,
        );
        configuration = parsed.success ? parsed.data : null;
      } else if (node.nodeType === "reduce") {
        const parsed = workflowReduceNodeConfigurationSchema.safeParse(
          revisionNode.configuration,
        );
        configuration = parsed.success ? parsed.data : null;
        if (parsed.success) {
          const selected = workflowValueAtPointer(
            nodeInput,
            parsed.data.collectionPath,
          );
          if (!selected.found) {
            unsupportedReason = `The reduce collection path ${parsed.data.collectionPath || "<root>"} did not match its structured input.`;
          } else if (
            selected.value === null ||
            typeof selected.value !== "object"
          ) {
            unsupportedReason =
              "A reduce collection must be a JSON array or object.";
          } else {
            structuredInput = selected.value;
            const empty = Array.isArray(selected.value)
              ? selected.value.length === 0
              : Object.keys(selected.value).length === 0;
            if (empty && parsed.data.emptyCollection === "fail") {
              unsupportedReason =
                "The reduce collection is empty and its empty-collection policy is fail.";
            }
          }
        }
      } else if (node.nodeType === "verify") {
        const parsed = workflowVerifyNodeConfigurationSchema.safeParse(
          revisionNode.configuration,
        );
        configuration = parsed.success ? parsed.data : null;
        verification = parsed.success ? parsed.data : null;
      } else {
        unsupportedReason = `The ${node.nodeType} workflow primitive is not available in the static DAG runtime.`;
      }
      if (!configuration && !unsupportedReason) {
        unsupportedReason = `The ${node.nodeType} node configuration is invalid.`;
      }
      if (!unsupportedReason && node.writeCapable) {
        unsupportedReason =
          "Write-capable workflow nodes require an isolated workflow worktree.";
      }
      if (!unsupportedReason && !detail.run.projectId) {
        unsupportedReason =
          "Executable workflows must select a project working directory.";
      }
      return {
        configuration,
        node,
        outputSchema: workflowJsonObjectSchema.parse(
          revisionNode?.outputSchema ?? {},
        ),
        projectId: detail.run.projectId,
        run: detail.run,
        structuredInput,
        unsupportedReason,
        verification,
      };
    });
  }

  async failUnsupportedRun(
    ownerId: string,
    runId: string,
    reason: string,
  ): Promise<boolean> {
    const now = new Date();
    const updated = await this.database.transaction(async (transaction) => {
      const updatedRuns = await transaction
        .update(schema.workflowRuns)
        .set({
          status: "failed",
          errorCode: "unsupported-workflow-shape",
          errorMessage: reason.slice(0, 5_000),
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workflowRuns.id, runId),
            eq(schema.workflowRuns.ownerId, ownerId),
            inArray(schema.workflowRuns.status, [
              "queued",
              "running",
              "waiting",
            ]),
          ),
        )
        .returning({ id: schema.workflowRuns.id });
      if (!updatedRuns.length) return false;
      await transaction
        .update(schema.workflowRunNodes)
        .set({ status: "failed", completedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.workflowRunNodes.runId, runId),
            inArray(schema.workflowRunNodes.status, ["blocked", "ready"]),
          ),
        );
      return true;
    });
    if (updated) {
      await this.appendEvent({
        runId,
        runNodeId: null,
        attemptId: null,
        eventKey: `run-unsupported:${runId}`,
        type: "run.failed",
        payload: { code: "unsupported-workflow-shape", reason },
        actorType: "server",
        actorId: null,
      });
    }
    return updated;
  }

  async claimAgentAttempt(
    ownerId: string,
    candidate: WorkflowAgentCandidate,
    assignment: WorkflowAttemptAssignment,
  ): Promise<WorkflowAttemptLease | null> {
    if (candidate.unsupportedReason || !candidate.configuration) return null;
    const now = new Date();
    const attemptId = randomUUID();
    const attemptNumber = candidate.node.attemptCount + 1;
    if (attemptNumber > candidate.node.budget.maxAttemptsPerNode) return null;
    const idempotencyKey = `${candidate.node.id}:attempt:${attemptNumber}`;
    const timeoutAt = new Date(
      now.getTime() + candidate.node.budget.maxNodeDurationMs,
    );

    let claimed: boolean;
    try {
      claimed = await this.database.transaction(async (transaction) => {
        const runs = await transaction
          .select({ id: schema.workflowRuns.id })
          .from(schema.workflowRuns)
          .where(
            and(
              eq(schema.workflowRuns.id, candidate.run.id),
              eq(schema.workflowRuns.ownerId, ownerId),
              inArray(schema.workflowRuns.status, [
                "queued",
                "running",
                "waiting",
              ]),
              eq(schema.workflowRuns.recoveryState, "stable"),
            ),
          )
          .limit(1);
        if (!runs[0]) return false;
        const nodes = await transaction
          .update(schema.workflowRunNodes)
          .set({
            status: "running",
            workerId: assignment.workerId,
            worktreeId: assignment.worktreeId,
            modelRouteId: assignment.modelRouteId,
            permissionProfileId: assignment.permissionProfileId,
            executionLeaseKey: idempotencyKey,
            attemptCount: attemptNumber,
            timeoutAt,
            startedAt: candidate.node.startedAt
              ? new Date(candidate.node.startedAt)
              : now,
            waitingAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.workflowRunNodes.id, candidate.node.id),
              eq(schema.workflowRunNodes.runId, candidate.run.id),
              eq(schema.workflowRunNodes.status, "ready"),
              eq(
                schema.workflowRunNodes.attemptCount,
                candidate.node.attemptCount,
              ),
            ),
          )
          .returning({ id: schema.workflowRunNodes.id });
        if (!nodes[0]) return false;
        await transaction.insert(schema.workflowNodeAttempts).values({
          id: attemptId,
          runNodeId: candidate.node.id,
          attempt: attemptNumber,
          status: "running",
          idempotencyKey,
          structuredInput: candidate.structuredInput,
          measuredUsage: workflowMeasuredUsageSchema.parse({}),
          workerId: assignment.workerId,
          worktreeId: assignment.worktreeId,
          modelRouteId: assignment.modelRouteId,
          permissionProfileId: assignment.permissionProfileId,
          codexThreadId: candidate.node.codexThreadId,
          startedAt: now,
          heartbeatAt: now,
          createdAt: now,
          updatedAt: now,
        });
        const updatedRuns = await transaction
          .update(schema.workflowRuns)
          .set({
            status: "running",
            workerId: assignment.workerId,
            worktreeId: assignment.worktreeId,
            selectedModelRouteId: assignment.modelRouteId,
            selectedPermissionProfileId: assignment.permissionProfileId,
            startedAt: candidate.run.startedAt
              ? new Date(candidate.run.startedAt)
              : now,
            errorCode: null,
            errorMessage: null,
            recoveryState: "stable",
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.workflowRuns.id, candidate.run.id),
              eq(schema.workflowRuns.ownerId, ownerId),
              inArray(schema.workflowRuns.status, [
                "queued",
                "running",
                "waiting",
              ]),
              eq(schema.workflowRuns.recoveryState, "stable"),
            ),
          )
          .returning({ id: schema.workflowRuns.id });
        if (!updatedRuns[0]) {
          throw new WorkflowAttemptClaimConflictError(
            "The workflow run changed state while claiming its node.",
          );
        }
        return true;
      });
    } catch (error) {
      if (error instanceof WorkflowAttemptClaimConflictError) return null;
      throw error;
    }
    if (!claimed) return null;
    await this.appendEvent({
      runId: candidate.run.id,
      runNodeId: candidate.node.id,
      attemptId,
      eventKey: `attempt-started:${attemptId}`,
      type: "node.attempt.started",
      payload: {
        attempt: attemptNumber,
        idempotencyKey,
        timeoutAt: timeoutAt.toISOString(),
        workerId: assignment.workerId,
        worktreeId: assignment.worktreeId,
        modelRouteId: assignment.modelRouteId,
      },
      actorType: "server",
      actorId: null,
    });
    return {
      assignment,
      attempt: attemptNumber,
      attemptId,
      budget: candidate.node.budget,
      candidate,
      idempotencyKey,
    };
  }

  async recordAttemptWorkerEvent(
    ownerId: string,
    lease: WorkflowAttemptLease,
    event: WorkerEvent,
  ): Promise<void> {
    if (
      !("attemptId" in event) ||
      event.attemptId !== lease.attemptId ||
      !event.type.startsWith("workflow.node.")
    ) {
      throw new Error("Worker event does not belong to this workflow attempt.");
    }
    const attribution = this.workerEventAttribution(event);
    const now = new Date();
    const attemptStatus =
      event.type === "workflow.node.interaction.requested"
        ? "waiting-for-approval"
        : event.type === "workflow.node.interaction.cleared" ||
            event.type === "workflow.node.interaction.expired"
          ? "running"
          : undefined;
    const measuredUsage =
      event.type === "workflow.node.activity" && event.activity.type === "usage"
        ? workflowMeasuredUsageSchema.parse({
            inputTokens: event.activity.last.inputTokens,
            outputTokens: event.activity.last.outputTokens,
            cachedInputTokens: event.activity.last.cachedInputTokens,
            totalTokens: event.activity.last.totalTokens,
          })
        : null;
    await this.database.transaction(async (transaction) => {
      const attempts = await transaction
        .update(schema.workflowNodeAttempts)
        .set({
          ...(attemptStatus ? { status: attemptStatus } : {}),
          ...(attribution.threadId
            ? { codexThreadId: attribution.threadId }
            : {}),
          ...(attribution.turnId ? { codexTurnId: attribution.turnId } : {}),
          ...(measuredUsage ? { measuredUsage } : {}),
          heartbeatAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workflowNodeAttempts.id, lease.attemptId),
            eq(schema.workflowNodeAttempts.runNodeId, lease.candidate.node.id),
            inArray(schema.workflowNodeAttempts.status, [
              "running",
              "waiting-for-approval",
            ]),
          ),
        )
        .returning({ id: schema.workflowNodeAttempts.id });
      if (!attempts[0]) {
        throw new Error("Workflow attempt is no longer active.");
      }
      await transaction
        .update(schema.workflowRunNodes)
        .set({
          ...(attemptStatus
            ? {
                status:
                  attemptStatus === "waiting-for-approval"
                    ? "waiting-for-approval"
                    : "running",
                waitingAt:
                  attemptStatus === "waiting-for-approval" ? now : null,
              }
            : {}),
          ...(attribution.threadId
            ? { codexThreadId: attribution.threadId }
            : {}),
          ...(attribution.turnId ? { codexTurnId: attribution.turnId } : {}),
          ...(measuredUsage ? { measuredUsage } : {}),
          updatedAt: now,
        })
        .where(eq(schema.workflowRunNodes.id, lease.candidate.node.id));
      const runMeasuredUsage = measuredUsage
        ? aggregateWorkflowUsage(
            (
              await transaction
                .select({
                  measuredUsage: schema.workflowRunNodes.measuredUsage,
                })
                .from(schema.workflowRunNodes)
                .where(
                  eq(schema.workflowRunNodes.runId, lease.candidate.run.id),
                )
            ).map(({ measuredUsage: usage }) => usage),
          )
        : null;
      await transaction
        .update(schema.workflowRuns)
        .set({
          ...(attemptStatus
            ? {
                status:
                  attemptStatus === "waiting-for-approval"
                    ? "waiting"
                    : "running",
              }
            : {}),
          ...(attribution.threadId
            ? { codexThreadId: attribution.threadId }
            : {}),
          ...(runMeasuredUsage ? { measuredUsage: runMeasuredUsage } : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workflowRuns.id, lease.candidate.run.id),
            eq(schema.workflowRuns.ownerId, ownerId),
            inArray(schema.workflowRuns.status, [
              "queued",
              "running",
              "waiting",
            ]),
          ),
        );
    });
    await this.appendEvent({
      runId: lease.candidate.run.id,
      runNodeId: lease.candidate.node.id,
      attemptId: lease.attemptId,
      eventKey: `worker:${lease.attemptId}:${workerEventIdentity(event)}`,
      type: event.type,
      payload: workerEventPayload(event),
      actorType: "worker",
      actorId: lease.assignment.workerId,
    });
  }

  async completeAgentAttempt(
    ownerId: string,
    lease: WorkflowAttemptLease,
    result: {
      measuredUsage: WorkflowMeasuredUsage;
      structuredResult: unknown;
      text: string;
      threadId: string;
      turnId: string;
    },
  ): Promise<boolean> {
    const now = new Date();
    const measuredUsage = workflowMeasuredUsageSchema.parse(
      result.measuredUsage,
    );
    const outcome = await this.database.transaction(async (transaction) => {
      const attempts = await transaction
        .update(schema.workflowNodeAttempts)
        .set({
          status: "completed",
          structuredResult: result.structuredResult,
          measuredUsage,
          errorCode: null,
          errorMessage: null,
          codexThreadId: result.threadId,
          codexTurnId: result.turnId,
          heartbeatAt: now,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workflowNodeAttempts.id, lease.attemptId),
            inArray(schema.workflowNodeAttempts.status, [
              "running",
              "waiting-for-approval",
            ]),
          ),
        )
        .returning({ id: schema.workflowNodeAttempts.id });
      if (!attempts[0]) {
        return {
          completed: false,
          readyNodeIds: [] as string[],
          runStateUpdated: false,
          runStatus: null,
        };
      }
      await transaction
        .update(schema.workflowRunNodes)
        .set({
          status: "completed",
          structuredResult: result.structuredResult,
          measuredUsage,
          codexThreadId: result.threadId,
          codexTurnId: result.turnId,
          executionLeaseKey: null,
          timeoutAt: null,
          waitingAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.workflowRunNodes.id, lease.candidate.node.id));

      await transaction
        .select({ id: schema.workflowRuns.id })
        .from(schema.workflowRuns)
        .where(
          and(
            eq(schema.workflowRuns.id, lease.candidate.run.id),
            eq(schema.workflowRuns.ownerId, ownerId),
          ),
        )
        .for("update");

      const satisfied = await transaction
        .update(schema.workflowRunNodeDependencies)
        .set({ status: "satisfied", satisfiedAt: now })
        .where(
          and(
            eq(
              schema.workflowRunNodeDependencies.fromNodeId,
              lease.candidate.node.id,
            ),
            eq(schema.workflowRunNodeDependencies.status, "blocked"),
          ),
        )
        .returning({
          targetNodeId: schema.workflowRunNodeDependencies.toNodeId,
        });
      const readyNodeIds: string[] = [];
      const targetNodeIds = [
        ...new Set(satisfied.map(({ targetNodeId }) => targetNodeId)),
      ].sort();
      for (const targetNodeId of targetNodeIds) {
        const targetRows = await transaction
          .select({ status: schema.workflowRunNodes.status })
          .from(schema.workflowRunNodes)
          .where(
            and(
              eq(schema.workflowRunNodes.id, targetNodeId),
              eq(schema.workflowRunNodes.runId, lease.candidate.run.id),
            ),
          )
          .for("update");
        if (targetRows[0]?.status !== "blocked") continue;
        const incoming = await transaction
          .select({
            dependency: schema.workflowRunNodeDependencies,
            source: schema.workflowRunNodes,
          })
          .from(schema.workflowRunNodeDependencies)
          .innerJoin(
            schema.workflowRunNodes,
            eq(
              schema.workflowRunNodes.id,
              schema.workflowRunNodeDependencies.fromNodeId,
            ),
          )
          .where(eq(schema.workflowRunNodeDependencies.toNodeId, targetNodeId))
          .orderBy(asc(schema.workflowRunNodeDependencies.createdAt));
        if (
          incoming.length === 0 ||
          incoming.some(({ dependency }) => dependency.status !== "satisfied")
        ) {
          continue;
        }
        const mapped = incoming.map(({ dependency, source }) => {
          const mapping = workflowJsonObjectSchema.parse(
            dependency.resultMapping,
          );
          const sourceOutput =
            typeof mapping.sourceOutput === "string"
              ? mapping.sourceOutput
              : null;
          const targetInput =
            typeof mapping.targetInput === "string"
              ? mapping.targetInput
              : null;
          return {
            sourceNodeKey: source.nodeKey,
            targetInput,
            value: mappedWorkflowValue(source.structuredResult, sourceOutput),
          };
        });
        let structuredInput: WorkflowJsonValue;
        if (mapped.length === 1 && mapped[0]!.targetInput === null) {
          structuredInput = mapped[0]!.value;
        } else {
          const aggregate: Record<string, WorkflowJsonValue> = {};
          for (const item of mapped) {
            const key = item.targetInput ?? item.sourceNodeKey;
            if (Object.hasOwn(aggregate, key)) {
              throw new Error(
                `Workflow dependency mappings collide at target input ${key}.`,
              );
            }
            aggregate[key] = item.value;
          }
          structuredInput = aggregate;
        }
        const targets = await transaction
          .update(schema.workflowRunNodes)
          .set({
            status: "ready",
            dependencyState: {
              remaining: 0,
              satisfied: incoming.length,
            },
            structuredInput,
            readyAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.workflowRunNodes.id, targetNodeId),
              eq(schema.workflowRunNodes.status, "blocked"),
            ),
          )
          .returning({ id: schema.workflowRunNodes.id });
        if (targets[0]) readyNodeIds.push(targets[0].id);
      }

      const [nodes, dependencies] = await Promise.all([
        transaction
          .select()
          .from(schema.workflowRunNodes)
          .where(eq(schema.workflowRunNodes.runId, lease.candidate.run.id)),
        transaction
          .select()
          .from(schema.workflowRunNodeDependencies)
          .where(
            eq(
              schema.workflowRunNodeDependencies.runId,
              lease.candidate.run.id,
            ),
          ),
      ]);
      const allCompleted = nodes.every(({ status }) =>
        ["completed", "skipped"].includes(status),
      );
      const runStatus = allCompleted
        ? "completed"
        : nodes.some(({ status }) => status === "waiting-for-approval")
          ? "waiting"
          : nodes.some(({ status }) => status === "running")
            ? "running"
            : nodes.some(({ status }) => status === "ready")
              ? "queued"
              : "failed";
      const usage = aggregateWorkflowUsage(
        nodes.map(({ measuredUsage }) => measuredUsage),
      );
      const sourceNodeIds = new Set(
        dependencies.map(({ fromNodeId }) => fromNodeId),
      );
      const sinkNodes = nodes.filter(({ id }) => !sourceNodeIds.has(id));
      const structuredResult = allCompleted
        ? sinkNodes.length === 1
          ? workflowJsonValueSchema.parse(sinkNodes[0]!.structuredResult)
          : workflowJsonObjectSchema.parse(
              Object.fromEntries(
                sinkNodes.map(({ nodeKey, structuredResult: value }) => [
                  nodeKey,
                  value,
                ]),
              ),
            )
        : null;
      const runs = await transaction
        .update(schema.workflowRuns)
        .set({
          status: runStatus,
          structuredResult,
          measuredUsage: usage,
          codexThreadId: nodes.length === 1 ? result.threadId : null,
          errorCode: runStatus === "failed" ? "workflow-deadlock" : null,
          errorMessage:
            runStatus === "failed"
              ? "No workflow node can make durable progress."
              : null,
          recoveryState: "stable",
          completedAt: allCompleted ? now : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workflowRuns.id, lease.candidate.run.id),
            eq(schema.workflowRuns.ownerId, ownerId),
            inArray(schema.workflowRuns.status, [
              "queued",
              "running",
              "waiting",
            ]),
          ),
        )
        .returning({ id: schema.workflowRuns.id });
      return {
        completed: true,
        readyNodeIds,
        runStateUpdated: Boolean(runs[0]),
        runStatus,
      };
    });
    if (outcome.completed) {
      await this.appendEvent({
        runId: lease.candidate.run.id,
        runNodeId: lease.candidate.node.id,
        attemptId: lease.attemptId,
        eventKey: `attempt-completed:${lease.attemptId}`,
        type: "node.attempt.completed",
        payload: {
          textPreview: result.text.slice(0, 4_000),
          textTruncated: result.text.length > 4_000,
          structuredResultAvailable: true,
          measuredUsage,
          threadId: result.threadId,
          turnId: result.turnId,
          readyNodeIds: outcome.readyNodeIds,
          runStatus: outcome.runStateUpdated ? outcome.runStatus : null,
        },
        actorType: "server",
        actorId: null,
      });
    }
    return outcome.completed;
  }

  async failAgentAttempt(
    ownerId: string,
    lease: WorkflowAttemptLease,
    input: {
      code: string;
      message: string;
      status: "failed" | "interrupted" | "orphaned" | "timed-out";
    },
  ): Promise<WorkflowAttemptFailureResult> {
    const now = new Date();
    const message = input.message.trim().slice(0, 5_000) || input.code;
    const automaticAttemptLimit =
      lease.candidate.configuration?.automaticRetries === null ||
      lease.candidate.configuration?.automaticRetries === undefined
        ? lease.budget.maxAttemptsPerNode
        : Math.min(
            lease.budget.maxAttemptsPerNode,
            lease.candidate.configuration.automaticRetries + 1,
          );
    const retryEligible =
      input.status !== "orphaned" &&
      input.status !== "interrupted" &&
      lease.attempt < automaticAttemptLimit;
    const outcome = await this.database.transaction(async (transaction) => {
      const attempts = await transaction
        .update(schema.workflowNodeAttempts)
        .set({
          status: input.status,
          errorCode: input.code.slice(0, 200),
          errorMessage: message,
          heartbeatAt: now,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workflowNodeAttempts.id, lease.attemptId),
            inArray(schema.workflowNodeAttempts.status, [
              "queued",
              "running",
              "waiting-for-approval",
            ]),
          ),
        )
        .returning({ id: schema.workflowNodeAttempts.id });
      if (!attempts[0]) return { retryScheduled: false, updated: false };
      const runs = await transaction
        .select({ status: schema.workflowRuns.status })
        .from(schema.workflowRuns)
        .where(
          and(
            eq(schema.workflowRuns.id, lease.candidate.run.id),
            eq(schema.workflowRuns.ownerId, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      const runIsActive =
        runs[0] !== undefined &&
        ["queued", "running", "waiting"].includes(runs[0].status);
      const retryScheduled = retryEligible && runIsActive;
      await transaction
        .update(schema.workflowRunNodes)
        .set({
          status:
            input.status === "orphaned"
              ? "recovering"
              : retryScheduled
                ? "ready"
                : input.status === "interrupted"
                  ? "cancelled"
                  : "failed",
          executionLeaseKey: null,
          timeoutAt: null,
          waitingAt: null,
          readyAt: retryScheduled
            ? now
            : lease.candidate.node.readyAt
              ? new Date(lease.candidate.node.readyAt)
              : null,
          completedAt:
            retryScheduled || input.status === "orphaned" ? null : now,
          updatedAt: now,
        })
        .where(eq(schema.workflowRunNodes.id, lease.candidate.node.id));
      if (runIsActive && !retryScheduled && input.status !== "orphaned") {
        await transaction
          .update(schema.workflowRunNodes)
          .set({ status: "skipped", completedAt: now, updatedAt: now })
          .where(
            and(
              eq(schema.workflowRunNodes.runId, lease.candidate.run.id),
              inArray(schema.workflowRunNodes.status, ["blocked", "ready"]),
            ),
          );
        await transaction
          .update(schema.workflowRunNodeDependencies)
          .set({ status: "failed" })
          .where(
            and(
              eq(
                schema.workflowRunNodeDependencies.runId,
                lease.candidate.run.id,
              ),
              eq(schema.workflowRunNodeDependencies.status, "blocked"),
            ),
          );
      }
      const nodes = await transaction
        .select({
          measuredUsage: schema.workflowRunNodes.measuredUsage,
          status: schema.workflowRunNodes.status,
        })
        .from(schema.workflowRunNodes)
        .where(eq(schema.workflowRunNodes.runId, lease.candidate.run.id));
      const retryRunStatus = nodes.some(
        ({ status }) => status === "waiting-for-approval",
      )
        ? "waiting"
        : nodes.some(({ status }) => status === "running")
          ? "running"
          : "queued";
      const runStatus =
        input.status === "orphaned"
          ? "recovering"
          : retryScheduled
            ? retryRunStatus
            : input.status === "interrupted"
              ? "cancelled"
              : "failed";
      await transaction
        .update(schema.workflowRuns)
        .set({
          status: runStatus,
          measuredUsage: aggregateWorkflowUsage(
            nodes.map(({ measuredUsage }) => measuredUsage),
          ),
          errorCode: input.code.slice(0, 200),
          errorMessage: message,
          recoveryState: input.status === "orphaned" ? "blocked" : "stable",
          completedAt:
            retryScheduled || input.status === "orphaned" ? null : now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workflowRuns.id, lease.candidate.run.id),
            eq(schema.workflowRuns.ownerId, ownerId),
            inArray(schema.workflowRuns.status, [
              "queued",
              "running",
              "waiting",
            ]),
          ),
        );
      return { retryScheduled, updated: true };
    });
    if (outcome.updated) {
      await this.terminalizeWorkflowInteractions(
        lease.candidate.run.id,
        lease.candidate.node.id,
        "interrupted",
      );
      await this.appendEvent({
        runId: lease.candidate.run.id,
        runNodeId: lease.candidate.node.id,
        attemptId: lease.attemptId,
        eventKey: `attempt-${input.status}:${lease.attemptId}`,
        type: `node.attempt.${input.status}`,
        payload: {
          code: input.code,
          message,
          retryScheduled: outcome.retryScheduled,
          nextAttempt: outcome.retryScheduled ? lease.attempt + 1 : null,
        },
        actorType: "server",
        actorId: null,
      });
    }
    return { retryScheduled: outcome.updated && outcome.retryScheduled };
  }

  async recoverInterruptedAttempts(ownerId: string): Promise<number> {
    const rows = await this.database
      .select({
        attempt: schema.workflowNodeAttempts,
        node: schema.workflowRunNodes,
        run: schema.workflowRuns,
      })
      .from(schema.workflowNodeAttempts)
      .innerJoin(
        schema.workflowRunNodes,
        eq(schema.workflowRunNodes.id, schema.workflowNodeAttempts.runNodeId),
      )
      .innerJoin(
        schema.workflowRuns,
        and(
          eq(schema.workflowRuns.id, schema.workflowRunNodes.runId),
          eq(schema.workflowRuns.ownerId, ownerId),
        ),
      )
      .where(
        inArray(schema.workflowNodeAttempts.status, [
          "queued",
          "running",
          "waiting-for-approval",
        ]),
      );
    for (const row of rows) {
      const detail = await this.getRun(ownerId, row.run.id);
      const node = detail?.nodes.find(({ id }) => id === row.node.id);
      if (!detail || !node) continue;
      const candidate: WorkflowAgentCandidate = {
        configuration: null,
        node,
        outputSchema: {},
        projectId: detail.run.projectId,
        run: detail.run,
        structuredInput: node.structuredInput,
        unsupportedReason: null,
        verification: null,
      };
      await this.failAgentAttempt(
        ownerId,
        {
          assignment: {
            cwd: "",
            modelRouteId: row.attempt.modelRouteId ?? "unavailable",
            permissionProfileId: row.attempt.permissionProfileId,
            workerId: row.attempt.workerId ?? "unavailable",
            worktreeId: row.attempt.worktreeId ?? "unavailable",
          },
          attempt: row.attempt.attempt,
          attemptId: row.attempt.id,
          budget: node.budget,
          candidate,
          idempotencyKey: row.attempt.idempotencyKey,
        },
        {
          code: "server-restarted",
          message:
            "The server restarted before the workflow attempt reached a durable node boundary.",
          status: "orphaned",
        },
      );
    }
    return rows.length;
  }

  async requestCancellation(
    ownerId: string,
    runId: string,
    input: WorkflowRunCancel,
  ): Promise<WorkflowCancellationRequestResult | null> {
    const eventKey = `run-cancel:${input.idempotencyKey}`;
    const existingEvent = await this.database
      .select({ payload: schema.workflowRunEvents.payload })
      .from(schema.workflowRunEvents)
      .innerJoin(
        schema.workflowRuns,
        and(
          eq(schema.workflowRuns.id, schema.workflowRunEvents.runId),
          eq(schema.workflowRuns.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.workflowRunEvents.runId, runId),
          eq(schema.workflowRunEvents.eventKey, eventKey),
        ),
      )
      .limit(1);
    const controlPayload = {
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    };
    if (existingEvent[0]) {
      if (
        canonicalJson(existingEvent[0].payload) !==
        canonicalJson(controlPayload)
      ) {
        throw new WorkflowControlConflictError(
          "This cancellation idempotency key was already used with different input.",
        );
      }
      const run = await this.getRun(ownerId, runId);
      return run
        ? {
            executions: this.cancellationContexts(run),
            replayed: true,
            run,
          }
        : null;
    }

    const detail = await this.getRun(ownerId, runId);
    if (!detail) return null;
    if (["completed", "failed", "cancelled"].includes(detail.run.status)) {
      throw new WorkflowControlConflictError(
        `A ${detail.run.status} workflow run cannot be cancelled.`,
      );
    }
    const now = new Date();
    const activeAttempts = detail.attempts.filter(({ status }) =>
      ["queued", "running", "waiting-for-approval"].includes(status),
    );
    const executions = this.cancellationContexts(detail);
    await this.database.transaction(async (transaction) => {
      if (activeAttempts.length > 0) {
        const attempts = await transaction
          .update(schema.workflowNodeAttempts)
          .set({
            status: "interrupted",
            structuredResult: null,
            errorCode: "cancelled-by-user",
            errorMessage: input.reason,
            heartbeatAt: now,
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              inArray(
                schema.workflowNodeAttempts.id,
                activeAttempts.map(({ id }) => id),
              ),
              inArray(schema.workflowNodeAttempts.status, [
                "queued",
                "running",
                "waiting-for-approval",
              ]),
            ),
          )
          .returning({ id: schema.workflowNodeAttempts.id });
        if (attempts.length !== activeAttempts.length) {
          throw new WorkflowControlConflictError(
            "The workflow attempt reached a terminal state before cancellation could be persisted.",
          );
        }
      }
      await transaction
        .update(schema.workflowRunNodes)
        .set({
          status: "cancelled",
          structuredResult: null,
          executionLeaseKey: null,
          timeoutAt: null,
          waitingAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workflowRunNodes.runId, runId),
            inArray(schema.workflowRunNodes.status, [
              "blocked",
              "ready",
              "queued",
              "running",
              "waiting-for-approval",
              "paused",
              "cancelling",
              "retrying",
              "recovering",
            ]),
          ),
        );
      if (detail.nodes.length > 0) {
        await transaction
          .update(schema.workflowNodeAttempts)
          .set({
            status: "interrupted",
            structuredResult: null,
            errorCode: "cancelled-by-user",
            errorMessage: input.reason,
            heartbeatAt: now,
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              inArray(
                schema.workflowNodeAttempts.runNodeId,
                detail.nodes.map(({ id }) => id),
              ),
              inArray(schema.workflowNodeAttempts.status, [
                "queued",
                "running",
                "waiting-for-approval",
              ]),
            ),
          );
      }
      const runs = await transaction
        .update(schema.workflowRuns)
        .set({
          status: "cancelled",
          structuredResult: null,
          errorCode: "cancelled-by-user",
          errorMessage: input.reason,
          cancelReason: input.reason,
          cancelRequestedAt: now,
          recoveryState: "stable",
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workflowRuns.id, runId),
            eq(schema.workflowRuns.ownerId, ownerId),
            inArray(schema.workflowRuns.status, [
              "queued",
              "running",
              "waiting",
              "paused",
              "cancelling",
              "recovering",
            ]),
          ),
        )
        .returning({ id: schema.workflowRuns.id });
      if (!runs[0]) {
        throw new WorkflowControlConflictError(
          "The workflow run reached a terminal state before cancellation could be persisted.",
        );
      }
    });
    for (const node of detail.nodes) {
      await this.terminalizeWorkflowInteractions(runId, node.id, "interrupted");
    }
    await this.appendEvent({
      runId,
      runNodeId: null,
      attemptId: null,
      eventKey,
      type: "run.cancelled",
      payload: controlPayload,
      actorType: "user",
      actorId: ownerId,
    });
    for (const activeAttempt of activeAttempts) {
      await this.appendEvent({
        runId,
        runNodeId: activeAttempt.runNodeId,
        attemptId: activeAttempt.id,
        eventKey: `attempt-interrupted:${activeAttempt.id}`,
        type: "node.attempt.interrupted",
        payload: {
          code: "cancelled-by-user",
          message: input.reason,
          retryScheduled: false,
          nextAttempt: null,
        },
        actorType: "user",
        actorId: ownerId,
      });
    }
    const run = (await this.getRun(ownerId, runId))!;
    return {
      executions,
      replayed: false,
      run,
    };
  }

  async retryNode(
    ownerId: string,
    runId: string,
    runNodeId: string,
    input: WorkflowNodeRetry,
  ): Promise<WorkflowRunDetail | null> {
    const eventKey = `node-retry:${runNodeId}:${input.idempotencyKey}`;
    const existingEvent = await this.database
      .select({ payload: schema.workflowRunEvents.payload })
      .from(schema.workflowRunEvents)
      .innerJoin(
        schema.workflowRuns,
        and(
          eq(schema.workflowRuns.id, schema.workflowRunEvents.runId),
          eq(schema.workflowRuns.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.workflowRunEvents.runId, runId),
          eq(schema.workflowRunEvents.eventKey, eventKey),
        ),
      )
      .limit(1);
    const controlPayload = {
      runNodeId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    };
    if (existingEvent[0]) {
      if (
        canonicalJson(existingEvent[0].payload) !==
        canonicalJson(controlPayload)
      ) {
        throw new WorkflowControlConflictError(
          "This retry idempotency key was already used with different input.",
        );
      }
      return this.getRun(ownerId, runId);
    }

    const detail = await this.getRun(ownerId, runId);
    if (!detail) return null;
    const node = detail.nodes.find(({ id }) => id === runNodeId);
    if (!node) return null;
    if (!["failed", "cancelled", "recovering"].includes(node.status)) {
      throw new WorkflowControlConflictError(
        `A ${node.status} workflow node cannot be retried.`,
      );
    }
    if (node.attemptCount >= node.budget.maxAttemptsPerNode) {
      throw new WorkflowControlConflictError(
        "The workflow node exhausted its attempt budget.",
      );
    }
    const now = new Date();
    await this.database.transaction(async (transaction) => {
      const nodes = await transaction
        .update(schema.workflowRunNodes)
        .set({
          status: "ready",
          executionLeaseKey: null,
          notBefore: null,
          timeoutAt: null,
          readyAt: now,
          waitingAt: null,
          completedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workflowRunNodes.id, runNodeId),
            eq(schema.workflowRunNodes.runId, runId),
            inArray(schema.workflowRunNodes.status, [
              "failed",
              "cancelled",
              "recovering",
            ]),
          ),
        )
        .returning({ id: schema.workflowRunNodes.id });
      if (!nodes[0]) {
        throw new WorkflowControlConflictError(
          "The workflow node changed state before the retry could be persisted.",
        );
      }
      await transaction
        .update(schema.workflowRunNodeDependencies)
        .set({ status: "blocked", satisfiedAt: null })
        .where(
          and(
            eq(schema.workflowRunNodeDependencies.runId, runId),
            eq(schema.workflowRunNodeDependencies.status, "failed"),
          ),
        );
      await transaction
        .update(schema.workflowRunNodes)
        .set({
          status: "blocked",
          completedAt: null,
          readyAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workflowRunNodes.runId, runId),
            eq(schema.workflowRunNodes.status, "skipped"),
          ),
        );
      const blockedNodes = await transaction
        .select({ id: schema.workflowRunNodes.id })
        .from(schema.workflowRunNodes)
        .where(
          and(
            eq(schema.workflowRunNodes.runId, runId),
            eq(schema.workflowRunNodes.status, "blocked"),
          ),
        );
      for (const blockedNode of blockedNodes) {
        const dependencies = await transaction
          .select({ status: schema.workflowRunNodeDependencies.status })
          .from(schema.workflowRunNodeDependencies)
          .where(
            eq(schema.workflowRunNodeDependencies.toNodeId, blockedNode.id),
          );
        const remaining = dependencies.filter(
          ({ status }) => status !== "satisfied",
        ).length;
        await transaction
          .update(schema.workflowRunNodes)
          .set({
            status: remaining === 0 ? "ready" : "blocked",
            dependencyState: {
              remaining,
              satisfied: dependencies.length - remaining,
            },
            readyAt: remaining === 0 ? now : null,
            updatedAt: now,
          })
          .where(eq(schema.workflowRunNodes.id, blockedNode.id));
      }
      const runs = await transaction
        .update(schema.workflowRuns)
        .set({
          status: "queued",
          errorCode: null,
          errorMessage: null,
          cancelReason: null,
          cancelRequestedAt: null,
          recoveryState: "stable",
          completedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workflowRuns.id, runId),
            eq(schema.workflowRuns.ownerId, ownerId),
            inArray(schema.workflowRuns.status, [
              "cancelled",
              "failed",
              "recovering",
            ]),
          ),
        )
        .returning({ id: schema.workflowRuns.id });
      if (!runs[0]) {
        throw new WorkflowControlConflictError(
          "The workflow run changed state before the retry could be persisted.",
        );
      }
    });
    await this.appendEvent({
      runId,
      runNodeId,
      attemptId: null,
      eventKey,
      type: "node.retry.requested",
      payload: controlPayload,
      actorType: "user",
      actorId: ownerId,
    });
    return this.getRun(ownerId, runId);
  }

  async getInteractionExecutionContext(
    ownerId: string,
    runId: string,
    runNodeId: string,
  ): Promise<WorkflowInteractionExecutionContext | null> {
    const rows = await this.database
      .select({
        attemptId: schema.workflowNodeAttempts.id,
        modelRouteId: schema.workflowNodeAttempts.modelRouteId,
        workerId: schema.workflowNodeAttempts.workerId,
      })
      .from(schema.workflowNodeAttempts)
      .innerJoin(
        schema.workflowRunNodes,
        and(
          eq(schema.workflowRunNodes.id, schema.workflowNodeAttempts.runNodeId),
          eq(schema.workflowRunNodes.id, runNodeId),
          eq(schema.workflowRunNodes.runId, runId),
        ),
      )
      .innerJoin(
        schema.workflowRuns,
        and(
          eq(schema.workflowRuns.id, runId),
          eq(schema.workflowRuns.ownerId, ownerId),
        ),
      )
      .where(
        inArray(schema.workflowNodeAttempts.status, [
          "running",
          "waiting-for-approval",
        ]),
      )
      .orderBy(desc(schema.workflowNodeAttempts.attempt))
      .limit(1);
    const row = rows[0];
    return row?.workerId && row.modelRouteId
      ? {
          attemptId: row.attemptId,
          modelRouteId: row.modelRouteId,
          runId,
          runNodeId,
          workerId: row.workerId,
        }
      : null;
  }

  async terminalizeWorkflowInteractions(
    runId: string,
    runNodeId: string,
    status: "expired" | "interrupted",
  ): Promise<number> {
    const rows = await this.database
      .update(schema.agentInteractionRequests)
      .set({ status, resolvedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.agentInteractionRequests.workflowRunId, runId),
          eq(schema.agentInteractionRequests.workflowNodeId, runNodeId),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      )
      .returning({ id: schema.agentInteractionRequests.id });
    return rows.length;
  }

  private cancellationContexts(
    detail: WorkflowRunDetail,
  ): WorkflowCancellationExecutionContext[] {
    const nodeById = new Map(detail.nodes.map((node) => [node.id, node]));
    return detail.attempts.flatMap((attempt) => {
      const node = nodeById.get(attempt.runNodeId);
      return ["queued", "running", "waiting-for-approval"].includes(
        attempt.status,
      ) &&
        attempt.workerId &&
        attempt.modelRouteId &&
        attempt.codexThreadId &&
        node
        ? [
            {
              attemptId: attempt.id,
              modelRouteId: attempt.modelRouteId,
              runId: detail.run.id,
              runNodeId: node.id,
              threadId: attempt.codexThreadId,
              workerId: attempt.workerId,
            },
          ]
        : [];
    });
  }

  private workerEventAttribution(event: WorkerEvent): {
    threadId: string | null;
    turnId: string | null;
  } {
    if (event.type === "workflow.node.activity") {
      return {
        threadId: event.activity.correlation?.threadId ?? null,
        turnId: event.activity.correlation?.turnId ?? null,
      };
    }
    if (event.type === "workflow.node.message") {
      return {
        threadId: event.message.correlation?.threadId ?? null,
        turnId: event.message.correlation?.turnId ?? null,
      };
    }
    if (event.type === "workflow.node.plan.updated") {
      return { threadId: null, turnId: event.turnId };
    }
    if (event.type === "workflow.node.interaction.requested") {
      return {
        threadId: event.request.threadId,
        turnId: event.request.turnId,
      };
    }
    return { threadId: null, turnId: null };
  }

  private async appendEvent(input: {
    actorId: string | null;
    actorType: string;
    attemptId: string | null;
    eventKey: string;
    payload: unknown;
    runId: string;
    runNodeId: string | null;
    type: string;
  }): Promise<void> {
    for (let retry = 0; retry < 20; retry += 1) {
      const existing = await this.database
        .select({ id: schema.workflowRunEvents.id })
        .from(schema.workflowRunEvents)
        .where(
          and(
            eq(schema.workflowRunEvents.runId, input.runId),
            eq(schema.workflowRunEvents.eventKey, input.eventKey),
          ),
        )
        .limit(1);
      if (existing[0]) return;
      const latest = await this.database
        .select({ sequence: schema.workflowRunEvents.sequence })
        .from(schema.workflowRunEvents)
        .where(eq(schema.workflowRunEvents.runId, input.runId))
        .orderBy(desc(schema.workflowRunEvents.sequence))
        .limit(1);
      try {
        await this.database.insert(schema.workflowRunEvents).values({
          runId: input.runId,
          runNodeId: input.runNodeId,
          attemptId: input.attemptId,
          sequence: (latest[0]?.sequence ?? -1) + 1,
          eventKey: input.eventKey.slice(0, 500),
          type: input.type.slice(0, 200),
          payload: jsonObject(input.payload),
          actorType: input.actorType.slice(0, 100),
          actorId: input.actorId?.slice(0, 500) ?? null,
        });
        return;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error("Workflow event sequence contention exceeded its limit.");
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
