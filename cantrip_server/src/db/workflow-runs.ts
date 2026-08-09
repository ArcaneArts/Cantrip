import { createHash, randomUUID } from "node:crypto";

import type { WorkerEvent } from "@cantrip/protocol";
import {
  workflowApprovalGateSchema,
  workflowAgentNodeConfigurationSchema,
  workflowConditionNodeConfigurationSchema,
  workflowGateNodeConfigurationSchema,
  workflowJsonObjectSchema,
  workflowJsonValueSchema,
  workflowMapNodeConfigurationSchema,
  workflowMeasuredUsageSchema,
  workflowNodeAttemptSchema,
  workflowPermissionRequirementsSchema,
  workflowPipelineNodeConfigurationSchema,
  workflowPredicateSchema,
  workflowReduceNodeConfigurationSchema,
  workflowRepeatUntilExecutionStateSchema,
  workflowRepeatUntilNodeConfigurationSchema,
  workflowRunDetailSchema,
  workflowRunEventPageSchema,
  workflowRunEventSchema,
  workflowRunNodeDependencySchema,
  workflowRunNodeItemExecutionStateSchema,
  workflowRunNodeItemSchema,
  workflowRunNodeSchema,
  workflowRunSchema,
  workflowVerifyNodeConfigurationSchema,
  type WorkflowPermissionRequirements,
  type WorkflowAgentNodeConfiguration,
  type WorkflowBudget,
  type WorkflowGateDecision,
  type WorkflowGateNodeConfiguration,
  type WorkflowJsonValue,
  type WorkflowJsonObject,
  type WorkflowMeasuredUsage,
  type WorkflowMapNodeConfiguration,
  type WorkflowNodeRetry,
  type WorkflowPipelineNodeConfiguration,
  type WorkflowPipelineStep,
  type WorkflowRepeatUntilExecutionState,
  type WorkflowRepeatUntilNodeConfiguration,
  type WorkflowRun,
  type WorkflowRunCancel,
  type WorkflowRunCreate,
  type WorkflowRunDetail,
  type WorkflowRunEventPage,
  type WorkflowRunEventQuery,
  type WorkflowRunQuery,
  type WorkflowRunPause,
  type WorkflowRunResume,
  type WorkflowRunNode,
  type WorkflowRunNodeItem,
  type WorkflowRunNodeItemExecutionState,
  type WorkflowVerifyNodeConfiguration,
} from "@cantrip/protocol/workflows";
import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";
import {
  aggregateWorkflowUsage,
  cancelPendingWorkflowGates,
  insertWorkflowRunEvent,
  lockWorkflowRun,
  recomputeWorkflowRun,
  settleWorkflowDependencies,
} from "./workflow-run-transitions.js";
import { evaluateWorkflowPredicate } from "../workflows/values.js";
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
  item: WorkflowRunNodeItem | null;
  node: WorkflowRunNode;
  outputSchema: WorkflowJsonObject;
  pipeline: {
    configuration: WorkflowPipelineNodeConfiguration;
    step: WorkflowPipelineStep;
    stepPosition: number;
  } | null;
  repeatUntil: {
    configuration: WorkflowRepeatUntilNodeConfiguration;
    state: WorkflowRepeatUntilExecutionState;
  } | null;
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
  timeoutMs: number;
  unitAttempt: number;
}

export interface WorkflowInteractionExecutionContext {
  attemptId: string;
  modelRouteId: string;
  runId: string;
  runNodeId: string;
  workerId: string;
}

export interface WorkflowAttemptFailureResult {
  interruptions: WorkflowCancellationExecutionContext[];
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

export interface WorkflowGateDecisionResult {
  replayed: boolean;
  run: WorkflowRunDetail;
}

export interface WorkflowRunBudgetViolation {
  code:
    | "workflow-cost-budget-exceeded"
    | "workflow-cost-budget-unavailable"
    | "workflow-duration-budget-exceeded"
    | "workflow-token-budget-exceeded";
  kind: "durationMs" | "estimatedCostUsd" | "tokens";
  limit: number;
  message: string;
  observed: number | null;
}

export interface WorkflowRunBudgetEnforcementResult {
  interruptions: WorkflowCancellationExecutionContext[];
  violation: WorkflowRunBudgetViolation | null;
}

function workflowRunBudgetViolation(
  run: WorkflowRun,
  measuredUsage: WorkflowMeasuredUsage,
  terminalCostUsage: WorkflowMeasuredUsage,
  now: Date,
): WorkflowRunBudgetViolation | null {
  if (["cancelled", "failed"].includes(run.status)) return null;
  const completed = run.status === "completed";
  const reachesLimit = (observed: number, limit: number) =>
    completed ? observed > limit : observed >= limit;
  if (
    run.budget.maxTokens !== null &&
    reachesLimit(measuredUsage.totalTokens, run.budget.maxTokens)
  ) {
    return {
      code: "workflow-token-budget-exceeded",
      kind: "tokens",
      limit: run.budget.maxTokens,
      message: "The workflow run exhausted its token budget.",
      observed: measuredUsage.totalTokens,
    };
  }
  const elapsedMs = run.startedAt
    ? Math.max(0, now.getTime() - new Date(run.startedAt).getTime())
    : 0;
  if (reachesLimit(elapsedMs, run.budget.maxDurationMs)) {
    return {
      code: "workflow-duration-budget-exceeded",
      kind: "durationMs",
      limit: run.budget.maxDurationMs,
      message: "The workflow run exhausted its elapsed-time budget.",
      observed: elapsedMs,
    };
  }
  if (
    run.budget.maxEstimatedCostUsd !== null &&
    (terminalCostUsage.inputTokens > 0 ||
      terminalCostUsage.outputTokens > 0 ||
      terminalCostUsage.cachedInputTokens > 0 ||
      terminalCostUsage.totalTokens > 0 ||
      terminalCostUsage.durationMs > 0) &&
    (!terminalCostUsage.costAvailable ||
      terminalCostUsage.estimatedCostUsd === null)
  ) {
    return {
      code: "workflow-cost-budget-unavailable",
      kind: "estimatedCostUsd",
      limit: run.budget.maxEstimatedCostUsd,
      message:
        "The workflow run cannot enforce its estimated-cost budget because measured cost is unavailable.",
      observed: null,
    };
  }
  if (
    run.budget.maxEstimatedCostUsd !== null &&
    terminalCostUsage.estimatedCostUsd !== null &&
    reachesLimit(
      terminalCostUsage.estimatedCostUsd,
      run.budget.maxEstimatedCostUsd,
    )
  ) {
    return {
      code: "workflow-cost-budget-exceeded",
      kind: "estimatedCostUsd",
      limit: run.budget.maxEstimatedCostUsd,
      message: "The workflow run exhausted its estimated-cost budget.",
      observed: terminalCostUsage.estimatedCostUsd,
    };
  }
  return null;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return workflowJsonObjectSchema.parse(
    JSON.parse(JSON.stringify(value)) as unknown,
  );
}

function collectionState(value: unknown): {
  failurePolicy: "continue" | "fail-fast";
  kind: "array" | "object";
} {
  const collection = workflowJsonObjectSchema.parse(value).collection;
  if (
    collection === null ||
    typeof collection !== "object" ||
    Array.isArray(collection) ||
    (collection.kind !== "array" && collection.kind !== "object") ||
    (collection.failurePolicy !== "continue" &&
      collection.failurePolicy !== "fail-fast")
  ) {
    throw new Error("The collection node state is invalid.");
  }
  return {
    failurePolicy: collection.failurePolicy,
    kind: collection.kind,
  };
}

function pipelineExecutionState(
  value: unknown,
): Extract<WorkflowRunNodeItemExecutionState, { kind: "pipeline" }> {
  const state = workflowRunNodeItemExecutionStateSchema.parse(value);
  if (state.kind !== "pipeline") {
    throw new Error("The pipeline item execution state is invalid.");
  }
  return state;
}

function repeatUntilExecutionState(
  value: unknown,
): WorkflowRepeatUntilExecutionState {
  return workflowRepeatUntilExecutionStateSchema.parse(value);
}

function aggregateCollectionItems(
  items: WorkflowRunNodeItem[],
  state: ReturnType<typeof collectionState>,
): WorkflowJsonValue {
  const values = items.map((item) => {
    if (state.failurePolicy === "continue") {
      return workflowJsonObjectSchema.parse(
        item.status === "completed"
          ? { status: "completed", result: item.structuredResult }
          : {
              status: "failed",
              error: {
                code: item.errorCode ?? "collection-item-failed",
                message: item.errorMessage ?? "The collection item failed.",
              },
            },
      );
    }
    return workflowJsonValueSchema.parse(item.structuredResult);
  });
  return state.kind === "array"
    ? values
    : workflowJsonObjectSchema.parse(
        Object.fromEntries(
          items.map((item, index) => [item.itemKey, values[index]!]),
        ),
      );
}

function expandedWorkflowNodeCountFromRecords(
  nodes: Array<{ dependencyState: unknown; id: string }>,
  items: Array<{ runNodeId: string }>,
): number {
  const itemCountByNode = new Map<string, number>();
  for (const item of items) {
    itemCountByNode.set(
      item.runNodeId,
      (itemCountByNode.get(item.runNodeId) ?? 0) + 1,
    );
  }
  return nodes.reduce((total, node) => {
    const state = workflowJsonObjectSchema.parse(node.dependencyState);
    const collection = state.collection;
    if (
      collection !== null &&
      typeof collection === "object" &&
      !Array.isArray(collection) &&
      typeof collection.logicalNodeCount === "number" &&
      Number.isSafeInteger(collection.logicalNodeCount) &&
      collection.logicalNodeCount >= 0
    ) {
      return total + collection.logicalNodeCount;
    }
    const repeatUntil = state.repeatUntil;
    if (
      repeatUntil !== null &&
      typeof repeatUntil === "object" &&
      !Array.isArray(repeatUntil) &&
      typeof repeatUntil.logicalNodeCount === "number" &&
      Number.isSafeInteger(repeatUntil.logicalNodeCount) &&
      repeatUntil.logicalNodeCount >= 0
    ) {
      return total + repeatUntil.logicalNodeCount;
    }
    return total + (itemCountByNode.get(node.id) ?? 0);
  }, nodes.length);
}

function expandedWorkflowNodeCount(detail: WorkflowRunDetail): number {
  return expandedWorkflowNodeCountFromRecords(detail.nodes, detail.items);
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
    const [nodes, items, dependencies, attempts, gates] = await Promise.all([
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
        .select({ item: schema.workflowRunNodeItems })
        .from(schema.workflowRunNodeItems)
        .innerJoin(
          schema.workflowRunNodes,
          and(
            eq(
              schema.workflowRunNodes.id,
              schema.workflowRunNodeItems.runNodeId,
            ),
            eq(schema.workflowRunNodes.runId, runId),
          ),
        )
        .innerJoin(
          schema.workflowRevisionNodes,
          eq(
            schema.workflowRevisionNodes.id,
            schema.workflowRunNodes.revisionNodeId,
          ),
        )
        .orderBy(
          asc(schema.workflowRevisionNodes.position),
          asc(schema.workflowRunNodeItems.position),
        ),
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
      items: items.map(({ item }) =>
        workflowRunNodeItemSchema.parse({
          ...item,
          notBefore: nullableISOString(item.notBefore),
          timeoutAt: nullableISOString(item.timeoutAt),
          readyAt: nullableISOString(item.readyAt),
          startedAt: nullableISOString(item.startedAt),
          waitingAt: nullableISOString(item.waitingAt),
          completedAt: nullableISOString(item.completedAt),
          createdAt: toISOString(item.createdAt),
          updatedAt: toISOString(item.updatedAt),
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

  async enforceRunBudget(
    ownerId: string,
    runId: string,
    now = new Date(),
  ): Promise<WorkflowRunBudgetEnforcementResult | null> {
    for (let retry = 0; retry < 20; retry += 1) {
      try {
        const outcome = await this.database.transaction(async (transaction) => {
          const availableRuns = await transaction
            .select({ id: schema.workflowRuns.id })
            .from(schema.workflowRuns)
            .where(
              and(
                eq(schema.workflowRuns.id, runId),
                eq(schema.workflowRuns.ownerId, ownerId),
              ),
            )
            .limit(1);
          if (!availableRuns[0]) return null;
          const nodeIdRows = await transaction
            .select({ id: schema.workflowRunNodes.id })
            .from(schema.workflowRunNodes)
            .where(eq(schema.workflowRunNodes.runId, runId))
            .orderBy(asc(schema.workflowRunNodes.id));
          const nodeIds = nodeIdRows.map(({ id }) => id);
          const attempts =
            nodeIds.length === 0
              ? []
              : await transaction
                  .select()
                  .from(schema.workflowNodeAttempts)
                  .where(
                    inArray(schema.workflowNodeAttempts.runNodeId, nodeIds),
                  )
                  .orderBy(asc(schema.workflowNodeAttempts.id))
                  .for("update");
          const nodes = await transaction
            .select()
            .from(schema.workflowRunNodes)
            .where(eq(schema.workflowRunNodes.runId, runId))
            .orderBy(asc(schema.workflowRunNodes.id))
            .for("update");
          if (nodeIds.length > 0) {
            await transaction
              .select({ id: schema.workflowRunNodeItems.id })
              .from(schema.workflowRunNodeItems)
              .where(inArray(schema.workflowRunNodeItems.runNodeId, nodeIds))
              .orderBy(asc(schema.workflowRunNodeItems.id))
              .for("update");
          }
          const lockedRun = await lockWorkflowRun(transaction, ownerId, runId);
          if (!lockedRun) return null;
          const measuredUsage = aggregateWorkflowUsage(
            nodes.map(({ measuredUsage: usage }) => usage),
          );
          const activeAttempts = attempts.filter(({ status }) =>
            ["queued", "running", "waiting-for-approval"].includes(status),
          );
          const terminalCostUsage = aggregateWorkflowUsage(
            attempts
              .filter(
                ({ status }) =>
                  !["queued", "running", "waiting-for-approval"].includes(
                    status,
                  ),
              )
              .map(({ measuredUsage: usage }) => usage),
          );
          const violation = workflowRunBudgetViolation(
            toRun(lockedRun),
            measuredUsage,
            terminalCostUsage,
            now,
          );
          if (!violation) {
            return {
              interruptions: [] as WorkflowCancellationExecutionContext[],
              nodeIds: [] as string[],
              violation: null,
            };
          }
          const interruptions = activeAttempts.flatMap((attempt) =>
            attempt.workerId && attempt.modelRouteId && attempt.codexThreadId
              ? [
                  {
                    attemptId: attempt.id,
                    modelRouteId: attempt.modelRouteId,
                    runId,
                    runNodeId: attempt.runNodeId,
                    threadId: attempt.codexThreadId,
                    workerId: attempt.workerId,
                  },
                ]
              : [],
          );
          if (activeAttempts.length > 0) {
            await transaction
              .update(schema.workflowNodeAttempts)
              .set({
                status: "interrupted",
                structuredResult: null,
                errorCode: violation.code,
                errorMessage: violation.message,
                heartbeatAt: now,
                completedAt: now,
                updatedAt: now,
              })
              .where(
                inArray(
                  schema.workflowNodeAttempts.id,
                  activeAttempts.map(({ id }) => id),
                ),
              );
          }
          if (nodeIds.length > 0) {
            await transaction
              .update(schema.workflowRunNodeItems)
              .set({
                status: "cancelled",
                structuredResult: null,
                errorCode: violation.code,
                errorMessage: violation.message,
                executionLeaseKey: null,
                timeoutAt: null,
                waitingAt: null,
                completedAt: now,
                updatedAt: now,
              })
              .where(
                and(
                  inArray(schema.workflowRunNodeItems.runNodeId, nodeIds),
                  inArray(schema.workflowRunNodeItems.status, [
                    "ready",
                    "running",
                    "waiting-for-approval",
                    "recovering",
                  ]),
                ),
              );
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
          await transaction
            .update(schema.workflowRunNodeDependencies)
            .set({ status: "failed" })
            .where(
              and(
                eq(schema.workflowRunNodeDependencies.runId, runId),
                eq(schema.workflowRunNodeDependencies.status, "blocked"),
              ),
            );
          await transaction
            .update(schema.workflowApprovalGates)
            .set({ status: "cancelled", updatedAt: now })
            .where(
              and(
                eq(schema.workflowApprovalGates.runId, runId),
                eq(schema.workflowApprovalGates.status, "pending"),
              ),
            );
          await transaction
            .update(schema.workflowRuns)
            .set({
              status: "failed",
              structuredResult: null,
              measuredUsage,
              errorCode: violation.code,
              errorMessage: violation.message,
              pauseReason: null,
              pausedAt: null,
              recoveryState: "stable",
              completedAt: now,
              updatedAt: now,
            })
            .where(eq(schema.workflowRuns.id, runId));
          await insertWorkflowRunEvent(transaction, {
            runId,
            runNodeId: null,
            attemptId: null,
            eventKey: `run-budget-exceeded:${violation.code}`,
            type: "run.budget.exceeded",
            payload: {
              ...violation,
              measuredUsage,
            },
            actorType: "server",
            actorId: null,
          });
          return { interruptions, nodeIds, violation };
        });
        if (!outcome) return null;
        if (outcome.violation) {
          for (const nodeId of outcome.nodeIds) {
            await this.terminalizeWorkflowInteractions(
              runId,
              nodeId,
              "interrupted",
            );
          }
        }
        return {
          interruptions: outcome.interruptions,
          violation: outcome.violation,
        };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error("Workflow budget event contention exceeded its limit.");
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
    const activeCount =
      detail.nodes.filter(
        ({ nodeType, status }) =>
          nodeType !== "map" &&
          nodeType !== "pipeline" &&
          (status === "running" ||
            (status === "waiting-for-approval" && nodeType !== "gate")),
      ).length +
      detail.items.filter(({ status }) =>
        ["running", "waiting-for-approval"].includes(status),
      ).length;
    const capacity = Math.max(
      0,
      detail.run.budget.maxParallelism - activeCount,
    );
    if (capacity === 0) return [];
    const revisionRows = await this.database
      .select()
      .from(schema.workflowRevisionNodes)
      .where(
        inArray(
          schema.workflowRevisionNodes.id,
          detail.nodes.map(({ revisionNodeId }) => revisionNodeId),
        ),
      )
      .orderBy(asc(schema.workflowRevisionNodes.position));
    const revisionById = new Map(revisionRows.map((row) => [row.id, row]));
    const positionByRevisionId = new Map(
      revisionRows.map((row) => [row.id, row.position]),
    );
    const candidates: Array<{
      item: WorkflowRunNodeItem | null;
      node: WorkflowRunNode;
    }> = detail.nodes
      .filter(
        ({ nodeType, status }) =>
          status === "ready" &&
          nodeType !== "condition" &&
          nodeType !== "gate" &&
          nodeType !== "map" &&
          nodeType !== "pipeline",
      )
      .map((node) => ({ item: null, node }));
    for (const node of detail.nodes.filter(
      ({ nodeType, status }) =>
        (nodeType === "map" || nodeType === "pipeline") &&
        (status === "running" || status === "waiting-for-approval"),
    )) {
      const rawConfiguration = revisionById.get(
        node.revisionNodeId,
      )?.configuration;
      const configuration =
        node.nodeType === "map"
          ? workflowMapNodeConfigurationSchema.safeParse(rawConfiguration)
          : workflowPipelineNodeConfigurationSchema.safeParse(rawConfiguration);
      const nodeItems = detail.items.filter(
        ({ runNodeId }) => runNodeId === node.id,
      );
      const activeItems = nodeItems.filter(({ status }) =>
        ["running", "waiting-for-approval"].includes(status),
      ).length;
      const itemCapacity = configuration.success
        ? Math.max(0, configuration.data.maxConcurrency - activeItems)
        : 1;
      candidates.push(
        ...nodeItems
          .filter(({ status }) => status === "ready")
          .slice(0, itemCapacity)
          .map((item) => ({ item, node })),
      );
    }
    candidates.sort((left, right) => {
      const nodeOrder =
        (positionByRevisionId.get(left.node.revisionNodeId) ?? 0) -
        (positionByRevisionId.get(right.node.revisionNodeId) ?? 0);
      if (nodeOrder !== 0) return nodeOrder;
      return (left.item?.position ?? -1) - (right.item?.position ?? -1);
    });
    return candidates.slice(0, capacity).map(({ item, node }) => {
      const revisionNode = revisionById.get(node.revisionNodeId);
      const nodeInput = workflowJsonValueSchema.parse(
        item?.structuredInput ?? node.structuredInput,
      );
      let configuration: WorkflowAgentNodeConfiguration | null = null;
      let outputSchema = workflowJsonObjectSchema.parse(
        revisionNode?.outputSchema ?? {},
      );
      let pipeline: WorkflowAgentCandidate["pipeline"] = null;
      let repeatUntil: WorkflowAgentCandidate["repeatUntil"] = null;
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
      } else if (node.nodeType === "map" && item) {
        const parsed = workflowMapNodeConfigurationSchema.safeParse(
          revisionNode.configuration,
        );
        configuration = parsed.success ? parsed.data : null;
      } else if (node.nodeType === "pipeline" && item) {
        const parsed = workflowPipelineNodeConfigurationSchema.safeParse(
          revisionNode.configuration,
        );
        const state = workflowRunNodeItemExecutionStateSchema.safeParse(
          item.executionState,
        );
        if (
          !parsed.success ||
          !state.success ||
          state.data.kind !== "pipeline"
        ) {
          unsupportedReason = "The pipeline item state is invalid.";
        } else {
          const step = parsed.data.steps[state.data.currentStepPosition];
          if (!step) {
            unsupportedReason = "The pipeline item has no executable step.";
          } else {
            configuration = step;
            outputSchema = step.outputSchema;
            pipeline = {
              configuration: parsed.data,
              step,
              stepPosition: state.data.currentStepPosition,
            };
          }
        }
      } else if (node.nodeType === "repeatUntil") {
        const parsed = workflowRepeatUntilNodeConfigurationSchema.safeParse(
          revisionNode.configuration,
        );
        const dependencyState = workflowJsonObjectSchema.parse(
          node.dependencyState,
        );
        const state = workflowRepeatUntilExecutionStateSchema.safeParse(
          dependencyState.repeatUntil,
        );
        if (!parsed.success || !state.success) {
          unsupportedReason = "The repeat-until execution state is invalid.";
        } else {
          configuration = parsed.data;
          repeatUntil = {
            configuration: parsed.data,
            state: state.data,
          };
        }
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
        item,
        node,
        outputSchema,
        pipeline,
        projectId: detail.run.projectId,
        repeatUntil,
        run: detail.run,
        structuredInput,
        unsupportedReason,
        verification,
      };
    });
  }

  async advanceReadyCollectionNode(
    ownerId: string,
    runId: string,
  ): Promise<boolean | null> {
    const detail = await this.getRun(ownerId, runId);
    if (
      !detail ||
      !["queued", "running", "waiting"].includes(detail.run.status) ||
      detail.run.recoveryState !== "stable"
    ) {
      return null;
    }
    const readyCollections = detail.nodes.filter(
      ({ nodeType, status }) =>
        (nodeType === "map" || nodeType === "pipeline") && status === "ready",
    );
    if (readyCollections.length === 0) return false;
    const revisionRows = await this.database
      .select()
      .from(schema.workflowRevisionNodes)
      .where(
        inArray(
          schema.workflowRevisionNodes.id,
          readyCollections.map(({ revisionNodeId }) => revisionNodeId),
        ),
      )
      .orderBy(asc(schema.workflowRevisionNodes.position))
      .limit(1);
    const revisionNode = revisionRows[0];
    const node = revisionNode
      ? readyCollections.find(
          ({ revisionNodeId }) => revisionNodeId === revisionNode.id,
        )
      : null;
    if (!revisionNode || !node) {
      await this.failUnsupportedRun(
        ownerId,
        runId,
        "The ready collection node is unavailable.",
      );
      return true;
    }
    if (node.writeCapable) {
      await this.failUnsupportedRun(
        ownerId,
        runId,
        "Write-capable collection nodes require isolated workflow worktrees.",
      );
      return true;
    }
    if (node.nodeType === "map") {
      const configuration = workflowMapNodeConfigurationSchema.safeParse(
        revisionNode.configuration,
      );
      if (!configuration.success) {
        await this.failUnsupportedRun(
          ownerId,
          runId,
          "The map node configuration is invalid.",
        );
        return true;
      }
      return this.initializeMapNode(ownerId, detail, node, configuration.data);
    }
    const configuration = workflowPipelineNodeConfigurationSchema.safeParse(
      revisionNode.configuration,
    );
    if (!configuration.success) {
      await this.failUnsupportedRun(
        ownerId,
        runId,
        "The pipeline node configuration is invalid.",
      );
      return true;
    }
    return this.initializePipelineNode(
      ownerId,
      detail,
      node,
      configuration.data,
    );
  }

  async advanceReadyRepeatUntilNode(
    ownerId: string,
    runId: string,
  ): Promise<boolean | null> {
    const detail = await this.getRun(ownerId, runId);
    if (
      !detail ||
      !["queued", "running", "waiting"].includes(detail.run.status) ||
      detail.run.recoveryState !== "stable"
    ) {
      return null;
    }
    const readyNodes = detail.nodes.filter(
      ({ nodeType, status }) =>
        nodeType === "repeatUntil" && status === "ready",
    );
    if (readyNodes.length === 0) return false;
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
    if (revisionRows.length !== readyNodes.length) {
      await this.failUnsupportedRun(
        ownerId,
        runId,
        "The ready repeat-until node is unavailable.",
      );
      return true;
    }
    for (const revisionNode of revisionRows) {
      const node = readyNodes.find(
        ({ revisionNodeId }) => revisionNodeId === revisionNode.id,
      )!;
      if (node.writeCapable) {
        await this.failUnsupportedRun(
          ownerId,
          runId,
          "Write-capable repeat-until nodes require an isolated workflow worktree.",
        );
        return true;
      }
      const configuration =
        workflowRepeatUntilNodeConfigurationSchema.safeParse(
          revisionNode.configuration,
        );
      if (!configuration.success) {
        await this.failUnsupportedRun(
          ownerId,
          runId,
          "The repeat-until node configuration is invalid.",
        );
        return true;
      }
      const dependencyState = workflowJsonObjectSchema.parse(
        node.dependencyState,
      );
      if (dependencyState.repeatUntil === undefined) {
        if (
          expandedWorkflowNodeCount(detail) + 1 >
          detail.run.budget.maxNodes
        ) {
          await this.failReadyRepeatUntilNode(
            ownerId,
            detail,
            node,
            "workflow-node-budget-exceeded",
            "Starting the repeat-until loop would exceed the workflow node budget.",
          );
          return true;
        }
        return this.initializeRepeatUntilNode(ownerId, detail, node);
      }
      const state = workflowRepeatUntilExecutionStateSchema.safeParse(
        dependencyState.repeatUntil,
      );
      if (!state.success) {
        await this.failUnsupportedRun(
          ownerId,
          runId,
          "The repeat-until execution state is invalid.",
        );
        return true;
      }
      const elapsedMs = Date.now() - new Date(state.data.startedAt).getTime();
      const hardFailure =
        elapsedMs >= configuration.data.maxDurationMs
          ? {
              code: "repeat-duration-limit",
              message: "The repeat-until node exceeded its duration limit.",
            }
          : state.data.currentIteration > configuration.data.maxIterations
            ? {
                code: "repeat-iteration-limit",
                message: "The repeat-until node exhausted its iteration limit.",
              }
            : state.data.completedIterations.length > 0 &&
                state.data.unchangedIterations >=
                  configuration.data.maxUnchangedIterations
              ? {
                  code: "repeat-no-progress",
                  message:
                    "The repeat-until node exhausted its unchanged-progress limit.",
                }
              : expandedWorkflowNodeCount(detail) > detail.run.budget.maxNodes
                ? {
                    code: "workflow-node-budget-exceeded",
                    message:
                      "The repeat-until node exceeded the workflow node budget.",
                  }
                : null;
      if (hardFailure) {
        await this.failReadyRepeatUntilNode(
          ownerId,
          detail,
          node,
          hardFailure.code,
          hardFailure.message,
        );
        return true;
      }
    }
    return false;
  }

  async advanceReadyControlNode(
    ownerId: string,
    runId: string,
  ): Promise<boolean | null> {
    const detail = await this.getRun(ownerId, runId);
    if (
      !detail ||
      !["queued", "running", "waiting"].includes(detail.run.status) ||
      detail.run.recoveryState !== "stable"
    ) {
      return null;
    }
    const readyControls = detail.nodes.filter(
      ({ nodeType, status }) =>
        status === "ready" && (nodeType === "condition" || nodeType === "gate"),
    );
    if (readyControls.length === 0) return false;
    const revisionRows = await this.database
      .select()
      .from(schema.workflowRevisionNodes)
      .where(
        inArray(
          schema.workflowRevisionNodes.id,
          readyControls.map(({ revisionNodeId }) => revisionNodeId),
        ),
      )
      .orderBy(asc(schema.workflowRevisionNodes.position))
      .limit(1);
    const revisionNode = revisionRows[0];
    const node = revisionNode
      ? readyControls.find(
          ({ revisionNodeId }) => revisionNodeId === revisionNode.id,
        )
      : null;
    if (!revisionNode || !node) {
      await this.failUnsupportedRun(
        ownerId,
        runId,
        "The ready workflow control node is unavailable.",
      );
      return true;
    }
    if (node.nodeType === "condition") {
      const configuration = workflowConditionNodeConfigurationSchema.safeParse(
        revisionNode.configuration,
      );
      if (!configuration.success) {
        await this.failUnsupportedRun(
          ownerId,
          runId,
          "The condition node configuration is invalid.",
        );
        return true;
      }
      return this.completeConditionNode(
        ownerId,
        detail,
        node,
        configuration.data.requireMatch,
      );
    }
    const configuration = workflowGateNodeConfigurationSchema.safeParse(
      revisionNode.configuration,
    );
    if (!configuration.success) {
      await this.failUnsupportedRun(
        ownerId,
        runId,
        "The gate node configuration is invalid.",
      );
      return true;
    }
    return this.openGateNode(ownerId, detail, node, configuration.data);
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
    const attemptNumber =
      (candidate.item?.attemptCount ?? candidate.node.attemptCount) + 1;
    const currentPipelineState = candidate.pipeline
      ? pipelineExecutionState(candidate.item?.executionState)
      : null;
    const currentRepeatUntilState = candidate.repeatUntil?.state ?? null;
    const unitAttempt = currentPipelineState
      ? currentPipelineState.currentStepAttemptCount + 1
      : currentRepeatUntilState
        ? currentRepeatUntilState.currentIterationAttemptCount + 1
        : attemptNumber;
    if (unitAttempt > candidate.node.budget.maxAttemptsPerNode) return null;
    const idempotencyKey = candidate.item
      ? candidate.pipeline
        ? `${candidate.node.id}:item:${candidate.item.id}:step:${candidate.pipeline.step.key}:attempt:${unitAttempt}`
        : `${candidate.node.id}:item:${candidate.item.id}:attempt:${attemptNumber}`
      : currentRepeatUntilState
        ? `${candidate.node.id}:iteration:${currentRepeatUntilState.currentIteration}:attempt:${unitAttempt}`
        : `${candidate.node.id}:attempt:${attemptNumber}`;
    const repeatUntilRemainingMs = currentRepeatUntilState
      ? Math.max(
          1,
          candidate.repeatUntil!.configuration.maxDurationMs -
            (now.getTime() -
              new Date(currentRepeatUntilState.startedAt).getTime()),
        )
      : candidate.node.budget.maxNodeDurationMs;
    const runRemainingMs = candidate.run.startedAt
      ? Math.max(
          1,
          candidate.run.budget.maxDurationMs -
            (now.getTime() - new Date(candidate.run.startedAt).getTime()),
        )
      : candidate.run.budget.maxDurationMs;
    const timeoutMs = Math.min(
      candidate.node.budget.maxNodeDurationMs,
      repeatUntilRemainingMs,
      runRemainingMs,
    );
    const timeoutAt = new Date(now.getTime() + timeoutMs);

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
        if (candidate.item) {
          const items = await transaction
            .update(schema.workflowRunNodeItems)
            .set({
              status: "running",
              workerId: assignment.workerId,
              worktreeId: assignment.worktreeId,
              modelRouteId: assignment.modelRouteId,
              permissionProfileId: assignment.permissionProfileId,
              executionLeaseKey: idempotencyKey,
              attemptCount: attemptNumber,
              ...(currentPipelineState
                ? {
                    executionState: {
                      ...currentPipelineState,
                      currentStepAttemptCount: unitAttempt,
                    },
                  }
                : {}),
              timeoutAt,
              startedAt: candidate.item.startedAt
                ? new Date(candidate.item.startedAt)
                : now,
              waitingAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.workflowRunNodeItems.id, candidate.item.id),
                eq(schema.workflowRunNodeItems.runNodeId, candidate.node.id),
                eq(schema.workflowRunNodeItems.status, "ready"),
                eq(
                  schema.workflowRunNodeItems.attemptCount,
                  candidate.item.attemptCount,
                ),
              ),
            )
            .returning({ id: schema.workflowRunNodeItems.id });
          if (!items[0]) return false;
          const nodes = await transaction
            .update(schema.workflowRunNodes)
            .set({
              status: "running",
              workerId: assignment.workerId,
              worktreeId: assignment.worktreeId,
              modelRouteId: assignment.modelRouteId,
              permissionProfileId: assignment.permissionProfileId,
              attemptCount: sql`${schema.workflowRunNodes.attemptCount} + 1`,
              startedAt: candidate.node.startedAt
                ? new Date(candidate.node.startedAt)
                : now,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.workflowRunNodes.id, candidate.node.id),
                eq(schema.workflowRunNodes.runId, candidate.run.id),
                eq(schema.workflowRunNodes.status, "running"),
              ),
            )
            .returning({ id: schema.workflowRunNodes.id });
          if (!nodes[0]) {
            throw new WorkflowAttemptClaimConflictError(
              "The map node changed state while claiming its item.",
            );
          }
        } else {
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
              ...(currentRepeatUntilState
                ? {
                    dependencyState: {
                      ...workflowJsonObjectSchema.parse(
                        candidate.node.dependencyState,
                      ),
                      repeatUntil: {
                        ...currentRepeatUntilState,
                        currentIterationAttemptCount: unitAttempt,
                      },
                    },
                  }
                : {}),
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
        }
        await transaction.insert(schema.workflowNodeAttempts).values({
          id: attemptId,
          runNodeId: candidate.node.id,
          runNodeItemId: candidate.item?.id ?? null,
          executionUnitKey:
            candidate.pipeline?.step.key ??
            (currentRepeatUntilState
              ? `iteration-${currentRepeatUntilState.currentIteration}`
              : null),
          attempt: attemptNumber,
          status: "running",
          idempotencyKey,
          structuredInput: candidate.structuredInput,
          measuredUsage: workflowMeasuredUsageSchema.parse({}),
          workerId: assignment.workerId,
          worktreeId: assignment.worktreeId,
          modelRouteId: assignment.modelRouteId,
          permissionProfileId: assignment.permissionProfileId,
          codexThreadId:
            candidate.item?.codexThreadId ?? candidate.node.codexThreadId,
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
        mapItemId: candidate.item?.id ?? null,
        mapItemKey: candidate.item?.itemKey ?? null,
        mapItemPosition: candidate.item?.position ?? null,
        pipelineStepKey: candidate.pipeline?.step.key ?? null,
        pipelineStepPosition: candidate.pipeline?.stepPosition ?? null,
        repeatUntilIteration: currentRepeatUntilState?.currentIteration ?? null,
        unitAttempt,
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
      timeoutMs,
      unitAttempt,
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
      if (lease.candidate.item) {
        const itemMeasuredUsage = measuredUsage
          ? lease.candidate.pipeline
            ? aggregateWorkflowUsage(
                (
                  await transaction
                    .select({
                      measuredUsage: schema.workflowNodeAttempts.measuredUsage,
                    })
                    .from(schema.workflowNodeAttempts)
                    .where(
                      eq(
                        schema.workflowNodeAttempts.runNodeItemId,
                        lease.candidate.item.id,
                      ),
                    )
                ).map(({ measuredUsage: usage }) => usage),
              )
            : measuredUsage
          : null;
        await transaction
          .update(schema.workflowRunNodeItems)
          .set({
            ...(attemptStatus ? { status: attemptStatus } : {}),
            ...(attemptStatus
              ? {
                  waitingAt:
                    attemptStatus === "waiting-for-approval" ? now : null,
                }
              : {}),
            ...(attribution.threadId
              ? { codexThreadId: attribution.threadId }
              : {}),
            ...(attribution.turnId ? { codexTurnId: attribution.turnId } : {}),
            ...(itemMeasuredUsage ? { measuredUsage: itemMeasuredUsage } : {}),
            updatedAt: now,
          })
          .where(eq(schema.workflowRunNodeItems.id, lease.candidate.item.id));
        const itemRows = await transaction
          .select({
            measuredUsage: schema.workflowRunNodeItems.measuredUsage,
            status: schema.workflowRunNodeItems.status,
          })
          .from(schema.workflowRunNodeItems)
          .where(
            eq(schema.workflowRunNodeItems.runNodeId, lease.candidate.node.id),
          );
        const mapWaiting =
          itemRows.some(({ status }) => status === "waiting-for-approval") &&
          !itemRows.some(({ status }) => ["ready", "running"].includes(status));
        await transaction
          .update(schema.workflowRunNodes)
          .set({
            status: mapWaiting ? "waiting-for-approval" : "running",
            measuredUsage: aggregateWorkflowUsage(
              itemRows.map(({ measuredUsage: usage }) => usage),
            ),
            waitingAt: mapWaiting ? now : null,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.workflowRunNodes.id, lease.candidate.node.id),
              inArray(schema.workflowRunNodes.status, [
                "running",
                "waiting-for-approval",
              ]),
            ),
          );
      } else {
        const nodeMeasuredUsage = measuredUsage
          ? lease.candidate.repeatUntil
            ? aggregateWorkflowUsage(
                (
                  await transaction
                    .select({
                      measuredUsage: schema.workflowNodeAttempts.measuredUsage,
                    })
                    .from(schema.workflowNodeAttempts)
                    .where(
                      eq(
                        schema.workflowNodeAttempts.runNodeId,
                        lease.candidate.node.id,
                      ),
                    )
                ).map(({ measuredUsage: usage }) => usage),
              )
            : measuredUsage
          : null;
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
            ...(nodeMeasuredUsage ? { measuredUsage: nodeMeasuredUsage } : {}),
            updatedAt: now,
          })
          .where(eq(schema.workflowRunNodes.id, lease.candidate.node.id));
      }
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
      const nodeStatuses = attemptStatus
        ? await transaction
            .select({ status: schema.workflowRunNodes.status })
            .from(schema.workflowRunNodes)
            .where(eq(schema.workflowRunNodes.runId, lease.candidate.run.id))
        : [];
      const runStatus = nodeStatuses.some(({ status }) =>
        ["ready", "running"].includes(status),
      )
        ? "running"
        : nodeStatuses.some(({ status }) => status === "waiting-for-approval")
          ? "waiting"
          : null;
      await transaction
        .update(schema.workflowRuns)
        .set({
          ...(runStatus ? { status: runStatus } : {}),
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
    if (lease.candidate.pipeline) {
      return this.completePipelineStepAttempt(ownerId, lease, result);
    }
    if (lease.candidate.repeatUntil) {
      return this.completeRepeatUntilAttempt(ownerId, lease, result);
    }
    if (lease.candidate.item) {
      return this.completeMapItemAttempt(ownerId, lease, result);
    }
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

      const lockedRun = await lockWorkflowRun(
        transaction,
        ownerId,
        lease.candidate.run.id,
      );
      if (!lockedRun) throw new Error("Workflow run is unavailable.");
      const dependencyTransition = await settleWorkflowDependencies(
        transaction,
        {
          now,
          runId: lease.candidate.run.id,
          selectedDependencyIds: null,
          sourceNodeId: lease.candidate.node.id,
        },
      );
      const runTransition = await recomputeWorkflowRun(transaction, {
        codexThreadId: result.threadId,
        lockedRun,
        now,
      });
      return {
        completed: true,
        readyNodeIds: dependencyTransition.readyNodeIds,
        runStateUpdated: runTransition.updated,
        runStatus: runTransition.status,
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

  private async completeRepeatUntilAttempt(
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
    const repeatUntil = lease.candidate.repeatUntil!;
    const iteration = repeatUntil.state.currentIteration;
    const executionUnitKey = `iteration-${iteration}`;
    const now = new Date();
    const measuredUsage = workflowMeasuredUsageSchema.parse(
      result.measuredUsage,
    );
    const structuredResult = workflowJsonValueSchema.parse(
      result.structuredResult,
    );
    const progress = workflowValueAtPointer(
      structuredResult,
      repeatUntil.configuration.progressPath,
    );
    const success = evaluateWorkflowPredicate(
      structuredResult,
      repeatUntil.configuration.successCondition,
    );
    const outcome = await this.database.transaction(async (transaction) => {
      const attempts = await transaction
        .update(schema.workflowNodeAttempts)
        .set({
          status: "completed",
          structuredResult,
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
            eq(schema.workflowNodeAttempts.runNodeId, lease.candidate.node.id),
            eq(schema.workflowNodeAttempts.executionUnitKey, executionUnitKey),
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
          failed: null as { code: string; message: string } | null,
          nextIteration: null as number | null,
          progressChanged: null as boolean | null,
          readyNodeIds: [] as string[],
          runStateUpdated: false,
          runStatus: null as string | null,
          satisfied: false,
          unchangedIterations: null as number | null,
        };
      }
      const nodeRows = await transaction
        .select()
        .from(schema.workflowRunNodes)
        .where(eq(schema.workflowRunNodes.id, lease.candidate.node.id))
        .for("update")
        .limit(1);
      const lockedNode = nodeRows[0];
      if (!lockedNode) {
        throw new Error("The repeat-until node is unavailable.");
      }
      const lockedRun = await lockWorkflowRun(
        transaction,
        ownerId,
        lease.candidate.run.id,
      );
      if (!lockedRun) throw new Error("Workflow run is unavailable.");
      const dependencyState = workflowJsonObjectSchema.parse(
        lockedNode.dependencyState,
      );
      const state = repeatUntilExecutionState(dependencyState.repeatUntil);
      if (
        state.currentIteration !== iteration ||
        state.currentIterationAttemptCount !== lease.unitAttempt
      ) {
        throw new Error(
          "The repeat-until node changed iteration during completion.",
        );
      }
      const attemptUsageRows = await transaction
        .select({ measuredUsage: schema.workflowNodeAttempts.measuredUsage })
        .from(schema.workflowNodeAttempts)
        .where(
          eq(schema.workflowNodeAttempts.runNodeId, lease.candidate.node.id),
        );
      const nodeUsage = aggregateWorkflowUsage(
        attemptUsageRows.map(({ measuredUsage: usage }) => usage),
      );
      const runIsActive = ["queued", "running", "waiting", "paused"].includes(
        lockedRun.status,
      );
      const nodeIsActive = ["running", "waiting-for-approval"].includes(
        lockedNode.status,
      );
      if (!runIsActive || !nodeIsActive) {
        await transaction
          .update(schema.workflowRunNodes)
          .set({
            ...(nodeIsActive
              ? {
                  status: "cancelled",
                  codexThreadId: result.threadId,
                  codexTurnId: result.turnId,
                  executionLeaseKey: null,
                  timeoutAt: null,
                  waitingAt: null,
                  completedAt: now,
                }
              : {}),
            measuredUsage: nodeUsage,
            updatedAt: now,
          })
          .where(eq(schema.workflowRunNodes.id, lockedNode.id));
        const runNodeUsageRows = await transaction
          .select({ measuredUsage: schema.workflowRunNodes.measuredUsage })
          .from(schema.workflowRunNodes)
          .where(eq(schema.workflowRunNodes.runId, lockedRun.id));
        await transaction
          .update(schema.workflowRuns)
          .set({
            measuredUsage: aggregateWorkflowUsage(
              runNodeUsageRows.map(({ measuredUsage: usage }) => usage),
            ),
            updatedAt: now,
          })
          .where(eq(schema.workflowRuns.id, lockedRun.id));
        return {
          completed: true,
          failed: null,
          nextIteration: null,
          progressChanged: null,
          readyNodeIds: [] as string[],
          runStateUpdated: false,
          runStatus: null,
          satisfied: false,
          unchangedIterations: null,
        };
      }

      let progressChanged: boolean | null = null;
      let unchangedIterations = state.unchangedIterations;
      let nextState = state;
      if (progress.found) {
        progressChanged =
          !state.lastProgress.available ||
          canonicalJson(state.lastProgress.value) !==
            canonicalJson(progress.value);
        unchangedIterations = progressChanged
          ? 0
          : state.unchangedIterations + 1;
        nextState = workflowRepeatUntilExecutionStateSchema.parse({
          ...state,
          currentIteration: iteration + 1,
          currentIterationAttemptCount: 0,
          unchangedIterations,
          lastProgress: { available: true, value: progress.value },
          completedIterations: [
            ...state.completedIterations,
            {
              iteration,
              structuredResult,
              progressValue: progress.value,
              measuredUsage,
              codexThreadId: result.threadId,
              codexTurnId: result.turnId,
              completedAt: now.toISOString(),
            },
          ],
        });
      }
      const elapsedMs = now.getTime() - new Date(state.startedAt).getTime();
      let failed: { code: string; message: string } | null = !progress.found
        ? {
            code: "repeat-progress-missing",
            message: `The repeat-until progress path ${repeatUntil.configuration.progressPath || "<root>"} did not match the iteration result.`,
          }
        : elapsedMs >= repeatUntil.configuration.maxDurationMs
          ? {
              code: "repeat-duration-limit",
              message: "The repeat-until node exceeded its duration limit.",
            }
          : !success &&
              unchangedIterations >=
                repeatUntil.configuration.maxUnchangedIterations
            ? {
                code: "repeat-no-progress",
                message:
                  "The repeat-until node exhausted its unchanged-progress limit.",
              }
            : !success && iteration >= repeatUntil.configuration.maxIterations
              ? {
                  code: "repeat-iteration-limit",
                  message:
                    "The repeat-until node exhausted its iteration limit.",
                }
              : null;
      if (!failed && !success) {
        const runNodeRows = await transaction
          .select({
            dependencyState: schema.workflowRunNodes.dependencyState,
            id: schema.workflowRunNodes.id,
          })
          .from(schema.workflowRunNodes)
          .where(eq(schema.workflowRunNodes.runId, lockedRun.id));
        const runItemRows = await transaction
          .select({ runNodeId: schema.workflowRunNodeItems.runNodeId })
          .from(schema.workflowRunNodeItems)
          .where(
            inArray(
              schema.workflowRunNodeItems.runNodeId,
              runNodeRows.map(({ id }) => id),
            ),
          );
        if (
          expandedWorkflowNodeCountFromRecords(runNodeRows, runItemRows) + 1 >
          lease.candidate.run.budget.maxNodes
        ) {
          failed = {
            code: "workflow-node-budget-exceeded",
            message:
              "Continuing the repeat-until loop would exceed the workflow node budget.",
          };
        } else {
          nextState = workflowRepeatUntilExecutionStateSchema.parse({
            ...nextState,
            logicalNodeCount: state.logicalNodeCount + 1,
          });
        }
      }

      await transaction
        .update(schema.workflowRunNodes)
        .set({
          status: failed ? "failed" : success ? "completed" : "ready",
          dependencyState: {
            ...dependencyState,
            repeatUntil: nextState,
          },
          structuredInput:
            !failed && !success ? structuredResult : lockedNode.structuredInput,
          structuredResult,
          measuredUsage: nodeUsage,
          codexThreadId: result.threadId,
          codexTurnId: result.turnId,
          executionLeaseKey: null,
          timeoutAt: null,
          readyAt: !failed && !success ? now : null,
          waitingAt: null,
          completedAt: failed || success ? now : null,
          updatedAt: now,
        })
        .where(eq(schema.workflowRunNodes.id, lockedNode.id));

      let readyNodeIds: string[] = [];
      let runStateUpdated = false;
      let runStatus: string | null = null;
      if (failed) {
        await transaction
          .update(schema.workflowRunNodes)
          .set({ status: "skipped", completedAt: now, updatedAt: now })
          .where(
            and(
              eq(schema.workflowRunNodes.runId, lockedRun.id),
              inArray(schema.workflowRunNodes.status, ["blocked", "ready"]),
            ),
          );
        await transaction
          .update(schema.workflowRunNodeDependencies)
          .set({ status: "failed" })
          .where(
            and(
              eq(schema.workflowRunNodeDependencies.runId, lockedRun.id),
              eq(schema.workflowRunNodeDependencies.status, "blocked"),
            ),
          );
        const runNodeUsageRows = await transaction
          .select({ measuredUsage: schema.workflowRunNodes.measuredUsage })
          .from(schema.workflowRunNodes)
          .where(eq(schema.workflowRunNodes.runId, lockedRun.id));
        await transaction
          .update(schema.workflowRuns)
          .set({
            status: "failed",
            measuredUsage: aggregateWorkflowUsage(
              runNodeUsageRows.map(({ measuredUsage: usage }) => usage),
            ),
            errorCode: failed.code.slice(0, 200),
            errorMessage: failed.message.slice(0, 5_000),
            pauseReason: null,
            pausedAt: null,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.workflowRuns.id, lockedRun.id));
        runStateUpdated = true;
        runStatus = "failed";
      } else {
        if (success) {
          readyNodeIds = (
            await settleWorkflowDependencies(transaction, {
              now,
              runId: lockedRun.id,
              selectedDependencyIds: null,
              sourceNodeId: lockedNode.id,
            })
          ).readyNodeIds;
        }
        const runTransition = await recomputeWorkflowRun(transaction, {
          codexThreadId: result.threadId,
          lockedRun,
          now,
        });
        runStateUpdated = runTransition.updated;
        runStatus = runTransition.status;
      }
      return {
        completed: true,
        failed,
        nextIteration: !failed && !success ? iteration + 1 : null,
        progressChanged,
        readyNodeIds,
        runStateUpdated,
        runStatus,
        satisfied: !failed && success,
        unchangedIterations: progress.found ? unchangedIterations : null,
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
          repeatUntilIteration: iteration,
          repeatUntilSatisfied: outcome.satisfied,
          progressChanged: outcome.progressChanged,
          unchangedIterations: outcome.unchangedIterations,
          nextIteration: outcome.nextIteration,
          readyNodeIds: outcome.readyNodeIds,
          runStatus: outcome.runStateUpdated ? outcome.runStatus : null,
        },
        actorType: "server",
        actorId: null,
      });
      if (outcome.failed) {
        await this.appendEvent({
          runId: lease.candidate.run.id,
          runNodeId: lease.candidate.node.id,
          attemptId: lease.attemptId,
          eventKey: `repeat-until-failed:${lease.attemptId}`,
          type: "node.repeat-until.failed",
          payload: {
            code: outcome.failed.code,
            message: outcome.failed.message,
            iteration,
          },
          actorType: "server",
          actorId: null,
        });
        await this.database.transaction((transaction) =>
          cancelPendingWorkflowGates(transaction, {
            now,
            runId: lease.candidate.run.id,
          }),
        );
      }
    }
    return outcome.completed;
  }

  private async completePipelineStepAttempt(
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
    const item = lease.candidate.item!;
    const pipeline = lease.candidate.pipeline!;
    const now = new Date();
    const measuredUsage = workflowMeasuredUsageSchema.parse(
      result.measuredUsage,
    );
    const structuredResult = workflowJsonValueSchema.parse(
      result.structuredResult,
    );
    const outcome = await this.database.transaction(async (transaction) => {
      const attempts = await transaction
        .update(schema.workflowNodeAttempts)
        .set({
          status: "completed",
          structuredResult,
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
            eq(schema.workflowNodeAttempts.runNodeItemId, item.id),
            eq(schema.workflowNodeAttempts.executionUnitKey, pipeline.step.key),
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
      const itemRows = await transaction
        .select()
        .from(schema.workflowRunNodeItems)
        .where(eq(schema.workflowRunNodeItems.id, item.id))
        .for("update")
        .limit(1);
      const lockedItem = itemRows[0];
      if (!lockedItem) throw new Error("The pipeline item is unavailable.");
      const state = pipelineExecutionState(lockedItem.executionState);
      if (
        state.currentStepPosition !== pipeline.stepPosition ||
        !["running", "waiting-for-approval"].includes(lockedItem.status)
      ) {
        throw new Error("The pipeline item changed step during completion.");
      }
      const nodeRows = await transaction
        .select()
        .from(schema.workflowRunNodes)
        .where(eq(schema.workflowRunNodes.id, lease.candidate.node.id))
        .for("update")
        .limit(1);
      const lockedNode = nodeRows[0];
      if (!lockedNode) throw new Error("The pipeline node is unavailable.");
      const completedSteps = [
        ...state.completedSteps,
        {
          key: pipeline.step.key,
          name: pipeline.step.name,
          position: pipeline.stepPosition,
          structuredResult,
          measuredUsage,
          codexThreadId: result.threadId,
          codexTurnId: result.turnId,
          completedAt: now.toISOString(),
        },
      ];
      const attemptUsageRows = await transaction
        .select({ measuredUsage: schema.workflowNodeAttempts.measuredUsage })
        .from(schema.workflowNodeAttempts)
        .where(eq(schema.workflowNodeAttempts.runNodeItemId, item.id));
      const itemUsage = aggregateWorkflowUsage(
        attemptUsageRows.map(({ measuredUsage: usage }) => usage),
      );
      const nextStep =
        pipeline.configuration.steps[pipeline.stepPosition + 1] ?? null;
      const nextState = {
        kind: "pipeline" as const,
        currentStepPosition: pipeline.stepPosition + 1,
        currentStepAttemptCount: 0,
        completedSteps,
      };
      if (!["running", "waiting-for-approval"].includes(lockedNode.status)) {
        await transaction
          .update(schema.workflowRunNodeItems)
          .set({
            status: nextStep ? "cancelled" : "completed",
            executionState: nextState,
            structuredInput: nextStep
              ? structuredResult
              : lockedItem.structuredInput,
            structuredResult,
            measuredUsage: itemUsage,
            codexThreadId: nextStep ? null : result.threadId,
            codexTurnId: nextStep ? null : result.turnId,
            executionLeaseKey: null,
            timeoutAt: null,
            waitingAt: null,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.workflowRunNodeItems.id, item.id));
        const terminalItemUsageRows = await transaction
          .select({ measuredUsage: schema.workflowRunNodeItems.measuredUsage })
          .from(schema.workflowRunNodeItems)
          .where(eq(schema.workflowRunNodeItems.runNodeId, lockedNode.id));
        await transaction
          .update(schema.workflowRunNodes)
          .set({
            measuredUsage: aggregateWorkflowUsage(
              terminalItemUsageRows.map(({ measuredUsage: usage }) => usage),
            ),
            updatedAt: now,
          })
          .where(eq(schema.workflowRunNodes.id, lockedNode.id));
        const terminalNodeUsageRows = await transaction
          .select({ measuredUsage: schema.workflowRunNodes.measuredUsage })
          .from(schema.workflowRunNodes)
          .where(eq(schema.workflowRunNodes.runId, lease.candidate.run.id));
        await transaction
          .update(schema.workflowRuns)
          .set({
            measuredUsage: aggregateWorkflowUsage(
              terminalNodeUsageRows.map(({ measuredUsage: usage }) => usage),
            ),
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.workflowRuns.id, lease.candidate.run.id),
              eq(schema.workflowRuns.ownerId, ownerId),
            ),
          );
        return {
          completed: true,
          readyNodeIds: [] as string[],
          runStateUpdated: false,
          runStatus: null,
        };
      }
      await transaction
        .update(schema.workflowRunNodeItems)
        .set({
          status: nextStep ? "ready" : "completed",
          executionState: nextState,
          structuredInput: nextStep
            ? structuredResult
            : lockedItem.structuredInput,
          structuredResult,
          measuredUsage: itemUsage,
          errorCode: null,
          errorMessage: null,
          codexThreadId: nextStep ? null : result.threadId,
          codexTurnId: nextStep ? null : result.turnId,
          executionLeaseKey: null,
          timeoutAt: null,
          readyAt: nextStep ? now : null,
          waitingAt: null,
          completedAt: nextStep ? null : now,
          updatedAt: now,
        })
        .where(eq(schema.workflowRunNodeItems.id, item.id));
      const collectionItems = await transaction
        .select()
        .from(schema.workflowRunNodeItems)
        .where(eq(schema.workflowRunNodeItems.runNodeId, lockedNode.id))
        .orderBy(asc(schema.workflowRunNodeItems.position));
      const nodeUsage = aggregateWorkflowUsage(
        collectionItems.map(({ measuredUsage: usage }) => usage),
      );
      const collection = collectionState(lockedNode.dependencyState);
      const terminal = collectionItems.every(
        ({ status }) =>
          status === "completed" ||
          (collection.failurePolicy === "continue" && status === "failed"),
      );
      const parentStatus = terminal
        ? "completed"
        : collectionItems.some(({ status }) =>
              ["ready", "running"].includes(status),
            )
          ? "running"
          : collectionItems.some(
                ({ status }) => status === "waiting-for-approval",
              )
            ? "waiting-for-approval"
            : collectionItems.some(({ status }) => status === "recovering")
              ? "recovering"
              : "running";
      const collectionResult = terminal
        ? aggregateCollectionItems(
            collectionItems.map((row) =>
              workflowRunNodeItemSchema.parse({
                ...row,
                notBefore: nullableISOString(row.notBefore),
                timeoutAt: nullableISOString(row.timeoutAt),
                readyAt: nullableISOString(row.readyAt),
                startedAt: nullableISOString(row.startedAt),
                waitingAt: nullableISOString(row.waitingAt),
                completedAt: nullableISOString(row.completedAt),
                createdAt: toISOString(row.createdAt),
                updatedAt: toISOString(row.updatedAt),
              }),
            ),
            collection,
          )
        : null;
      await transaction
        .update(schema.workflowRunNodes)
        .set({
          status: parentStatus,
          structuredResult: collectionResult,
          measuredUsage: nodeUsage,
          waitingAt: parentStatus === "waiting-for-approval" ? now : null,
          completedAt: terminal ? now : null,
          updatedAt: now,
        })
        .where(eq(schema.workflowRunNodes.id, lockedNode.id));
      const lockedRun = await lockWorkflowRun(
        transaction,
        ownerId,
        lease.candidate.run.id,
      );
      if (!lockedRun) throw new Error("Workflow run is unavailable.");
      let readyNodeIds: string[] = [];
      if (terminal) {
        readyNodeIds = (
          await settleWorkflowDependencies(transaction, {
            now,
            runId: lease.candidate.run.id,
            selectedDependencyIds: null,
            sourceNodeId: lockedNode.id,
          })
        ).readyNodeIds;
      }
      const runTransition = await recomputeWorkflowRun(transaction, {
        codexThreadId: null,
        lockedRun,
        now,
      });
      return {
        completed: true,
        readyNodeIds,
        runStateUpdated: runTransition.updated,
        runStatus: runTransition.status,
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
          collectionItemId: item.id,
          collectionItemKey: item.itemKey,
          collectionItemPosition: item.position,
          pipelineStepKey: pipeline.step.key,
          pipelineStepPosition: pipeline.stepPosition,
          readyNodeIds: outcome.readyNodeIds,
          runStatus: outcome.runStateUpdated ? outcome.runStatus : null,
        },
        actorType: "server",
        actorId: null,
      });
    }
    return outcome.completed;
  }

  private async completeMapItemAttempt(
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
    const item = lease.candidate.item!;
    const now = new Date();
    const measuredUsage = workflowMeasuredUsageSchema.parse(
      result.measuredUsage,
    );
    const structuredResult = workflowJsonValueSchema.parse(
      result.structuredResult,
    );
    const outcome = await this.database.transaction(async (transaction) => {
      const attempts = await transaction
        .update(schema.workflowNodeAttempts)
        .set({
          status: "completed",
          structuredResult,
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
            eq(schema.workflowNodeAttempts.runNodeItemId, item.id),
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
        .update(schema.workflowRunNodeItems)
        .set({
          status: "completed",
          structuredResult,
          measuredUsage,
          errorCode: null,
          errorMessage: null,
          codexThreadId: result.threadId,
          codexTurnId: result.turnId,
          executionLeaseKey: null,
          timeoutAt: null,
          waitingAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.workflowRunNodeItems.id, item.id));
      const nodeRows = await transaction
        .select()
        .from(schema.workflowRunNodes)
        .where(eq(schema.workflowRunNodes.id, lease.candidate.node.id))
        .for("update")
        .limit(1);
      const lockedNode = nodeRows[0];
      if (!lockedNode) throw new Error("The map node is unavailable.");
      if (!["running", "waiting-for-approval"].includes(lockedNode.status)) {
        return {
          completed: true,
          readyNodeIds: [] as string[],
          runStateUpdated: false,
          runStatus: null,
        };
      }
      const itemRows = await transaction
        .select()
        .from(schema.workflowRunNodeItems)
        .where(
          eq(schema.workflowRunNodeItems.runNodeId, lease.candidate.node.id),
        )
        .orderBy(asc(schema.workflowRunNodeItems.position));
      const itemUsage = aggregateWorkflowUsage(
        itemRows.map(({ measuredUsage: usage }) => usage),
      );
      const state = collectionState(lockedNode.dependencyState);
      const terminal = itemRows.every(
        ({ status }) =>
          status === "completed" ||
          (state.failurePolicy === "continue" && status === "failed"),
      );
      const parentStatus = terminal
        ? "completed"
        : itemRows.some(({ status }) => ["ready", "running"].includes(status))
          ? "running"
          : itemRows.some(({ status }) => status === "waiting-for-approval")
            ? "waiting-for-approval"
            : itemRows.some(({ status }) => status === "recovering")
              ? "recovering"
              : "running";
      const mapResult = terminal
        ? aggregateCollectionItems(
            itemRows.map((row) =>
              workflowRunNodeItemSchema.parse({
                ...row,
                notBefore: nullableISOString(row.notBefore),
                timeoutAt: nullableISOString(row.timeoutAt),
                readyAt: nullableISOString(row.readyAt),
                startedAt: nullableISOString(row.startedAt),
                waitingAt: nullableISOString(row.waitingAt),
                completedAt: nullableISOString(row.completedAt),
                createdAt: toISOString(row.createdAt),
                updatedAt: toISOString(row.updatedAt),
              }),
            ),
            state,
          )
        : null;
      await transaction
        .update(schema.workflowRunNodes)
        .set({
          status: parentStatus,
          structuredResult: mapResult,
          measuredUsage: itemUsage,
          waitingAt: parentStatus === "waiting-for-approval" ? now : null,
          completedAt: terminal ? now : null,
          updatedAt: now,
        })
        .where(eq(schema.workflowRunNodes.id, lease.candidate.node.id));
      const lockedRun = await lockWorkflowRun(
        transaction,
        ownerId,
        lease.candidate.run.id,
      );
      if (!lockedRun) throw new Error("Workflow run is unavailable.");
      let readyNodeIds: string[] = [];
      if (terminal) {
        readyNodeIds = (
          await settleWorkflowDependencies(transaction, {
            now,
            runId: lease.candidate.run.id,
            selectedDependencyIds: null,
            sourceNodeId: lease.candidate.node.id,
          })
        ).readyNodeIds;
      }
      const runTransition = await recomputeWorkflowRun(transaction, {
        codexThreadId: null,
        lockedRun,
        now,
      });
      return {
        completed: true,
        readyNodeIds,
        runStateUpdated: runTransition.updated,
        runStatus: runTransition.status,
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
          mapItemId: item.id,
          mapItemKey: item.itemKey,
          mapItemPosition: item.position,
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
    if (lease.candidate.pipeline) {
      return this.failPipelineStepAttempt(ownerId, lease, input);
    }
    if (lease.candidate.item) {
      return this.failMapItemAttempt(ownerId, lease, input);
    }
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
      lease.unitAttempt < automaticAttemptLimit;
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
      if (!attempts[0]) {
        return {
          retryScheduled: false,
          updated: false,
        };
      }
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
      const runIsPaused = runs[0]?.status === "paused";
      const runCanSettle = runIsActive || runIsPaused;
      const retryScheduled = retryEligible && runCanSettle;
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
      if (runCanSettle && !retryScheduled && input.status !== "orphaned") {
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
            ? runIsPaused
              ? "paused"
              : retryRunStatus
            : input.status === "interrupted"
              ? "cancelled"
              : "failed";
      await transaction
        .update(schema.workflowRuns)
        .set({
          status: runStatus,
          ...(runStatus === "paused"
            ? {}
            : { pauseReason: null, pausedAt: null }),
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
              "paused",
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
          nextUnitAttempt: outcome.retryScheduled
            ? lease.unitAttempt + 1
            : null,
          repeatUntilIteration:
            lease.candidate.repeatUntil?.state.currentIteration ?? null,
        },
        actorType: "server",
        actorId: null,
      });
    }
    return {
      interruptions: [],
      retryScheduled: outcome.updated && outcome.retryScheduled,
    };
  }

  private async failPipelineStepAttempt(
    ownerId: string,
    lease: WorkflowAttemptLease,
    input: {
      code: string;
      message: string;
      status: "failed" | "interrupted" | "orphaned" | "timed-out";
    },
  ): Promise<WorkflowAttemptFailureResult> {
    const item = lease.candidate.item!;
    const pipeline = lease.candidate.pipeline!;
    const now = new Date();
    const message = input.message.trim().slice(0, 5_000) || input.code;
    const automaticAttemptLimit =
      pipeline.step.automaticRetries === null
        ? lease.budget.maxAttemptsPerNode
        : Math.min(
            lease.budget.maxAttemptsPerNode,
            pipeline.step.automaticRetries + 1,
          );
    const retryEligible =
      input.status !== "orphaned" &&
      input.status !== "interrupted" &&
      lease.unitAttempt < automaticAttemptLimit;
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
            eq(schema.workflowNodeAttempts.runNodeItemId, item.id),
            eq(schema.workflowNodeAttempts.executionUnitKey, pipeline.step.key),
            inArray(schema.workflowNodeAttempts.status, [
              "queued",
              "running",
              "waiting-for-approval",
            ]),
          ),
        )
        .returning({ id: schema.workflowNodeAttempts.id });
      if (!attempts[0]) {
        return {
          retryScheduled: false,
          terminalizedPipeline: false,
          updated: false,
        };
      }
      const runRows = await transaction
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
        runRows[0] !== undefined &&
        ["queued", "running", "waiting"].includes(runRows[0].status);
      const runIsPaused = runRows[0]?.status === "paused";
      const runCanSettle = runIsActive || runIsPaused;
      const retryScheduled = retryEligible && runCanSettle;
      const itemRows = await transaction
        .select()
        .from(schema.workflowRunNodeItems)
        .where(eq(schema.workflowRunNodeItems.id, item.id))
        .for("update")
        .limit(1);
      const lockedItem = itemRows[0];
      if (!lockedItem) throw new Error("The pipeline item is unavailable.");
      const state = pipelineExecutionState(lockedItem.executionState);
      if (state.currentStepPosition !== pipeline.stepPosition) {
        throw new Error("The pipeline item changed step during failure.");
      }
      const attemptUsageRows = await transaction
        .select({ measuredUsage: schema.workflowNodeAttempts.measuredUsage })
        .from(schema.workflowNodeAttempts)
        .where(eq(schema.workflowNodeAttempts.runNodeItemId, item.id));
      const itemUsage = aggregateWorkflowUsage(
        attemptUsageRows.map(({ measuredUsage: usage }) => usage),
      );
      await transaction
        .update(schema.workflowRunNodeItems)
        .set({
          status:
            !runCanSettle && runRows[0]?.status !== "recovering"
              ? "cancelled"
              : input.status === "orphaned"
                ? "recovering"
                : retryScheduled
                  ? "ready"
                  : input.status === "interrupted"
                    ? "cancelled"
                    : "failed",
          measuredUsage: itemUsage,
          errorCode: input.code.slice(0, 200),
          errorMessage: message,
          executionLeaseKey: null,
          timeoutAt: null,
          waitingAt: null,
          readyAt: retryScheduled ? now : null,
          completedAt:
            retryScheduled ||
            (input.status === "orphaned" &&
              (runCanSettle || runRows[0]?.status === "recovering"))
              ? null
              : now,
          updatedAt: now,
        })
        .where(eq(schema.workflowRunNodeItems.id, item.id));
      const nodeRows = await transaction
        .select()
        .from(schema.workflowRunNodes)
        .where(eq(schema.workflowRunNodes.id, lease.candidate.node.id))
        .for("update")
        .limit(1);
      const lockedNode = nodeRows[0];
      if (!lockedNode) throw new Error("The pipeline node is unavailable.");
      const collectionItems = await transaction
        .select()
        .from(schema.workflowRunNodeItems)
        .where(eq(schema.workflowRunNodeItems.runNodeId, lockedNode.id))
        .orderBy(asc(schema.workflowRunNodeItems.position));
      const nodeUsage = aggregateWorkflowUsage(
        collectionItems.map(({ measuredUsage: usage }) => usage),
      );
      if (!runCanSettle) {
        await transaction
          .update(schema.workflowRunNodes)
          .set({ measuredUsage: nodeUsage, updatedAt: now })
          .where(eq(schema.workflowRunNodes.id, lockedNode.id));
        const runNodeUsageRows = await transaction
          .select({ measuredUsage: schema.workflowRunNodes.measuredUsage })
          .from(schema.workflowRunNodes)
          .where(eq(schema.workflowRunNodes.runId, lease.candidate.run.id));
        await transaction
          .update(schema.workflowRuns)
          .set({
            measuredUsage: aggregateWorkflowUsage(
              runNodeUsageRows.map(({ measuredUsage: usage }) => usage),
            ),
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.workflowRuns.id, lease.candidate.run.id),
              eq(schema.workflowRuns.ownerId, ownerId),
            ),
          );
        return {
          retryScheduled: false,
          terminalizedPipeline: false,
          updated: true,
        };
      }
      if (input.status === "orphaned") {
        await transaction
          .update(schema.workflowRunNodes)
          .set({
            status: "recovering",
            measuredUsage: nodeUsage,
            updatedAt: now,
          })
          .where(eq(schema.workflowRunNodes.id, lockedNode.id));
        await transaction
          .update(schema.workflowRuns)
          .set({
            status: "recovering",
            errorCode: input.code.slice(0, 200),
            errorMessage: message,
            pauseReason: null,
            pausedAt: null,
            recoveryState: "blocked",
            updatedAt: now,
          })
          .where(eq(schema.workflowRuns.id, lease.candidate.run.id));
        return {
          retryScheduled: false,
          terminalizedPipeline: false,
          updated: true,
        };
      }
      if (retryScheduled) {
        await transaction
          .update(schema.workflowRunNodes)
          .set({ status: "running", measuredUsage: nodeUsage, updatedAt: now })
          .where(eq(schema.workflowRunNodes.id, lockedNode.id));
        await transaction
          .update(schema.workflowRuns)
          .set({
            status: runIsPaused ? "paused" : "running",
            errorCode: null,
            errorMessage: null,
            recoveryState: "stable",
            updatedAt: now,
          })
          .where(eq(schema.workflowRuns.id, lease.candidate.run.id));
        return {
          retryScheduled: true,
          terminalizedPipeline: false,
          updated: true,
        };
      }
      if (
        pipeline.configuration.failurePolicy === "continue" &&
        input.status !== "interrupted"
      ) {
        const terminal = collectionItems.every(({ status }) =>
          ["completed", "failed"].includes(status),
        );
        const parentStatus = terminal
          ? "completed"
          : collectionItems.some(({ status }) =>
                ["ready", "running"].includes(status),
              )
            ? "running"
            : collectionItems.some(
                  ({ status }) => status === "waiting-for-approval",
                )
              ? "waiting-for-approval"
              : "running";
        const collectionResult = terminal
          ? aggregateCollectionItems(
              collectionItems.map((row) =>
                workflowRunNodeItemSchema.parse({
                  ...row,
                  notBefore: nullableISOString(row.notBefore),
                  timeoutAt: nullableISOString(row.timeoutAt),
                  readyAt: nullableISOString(row.readyAt),
                  startedAt: nullableISOString(row.startedAt),
                  waitingAt: nullableISOString(row.waitingAt),
                  completedAt: nullableISOString(row.completedAt),
                  createdAt: toISOString(row.createdAt),
                  updatedAt: toISOString(row.updatedAt),
                }),
              ),
              collectionState(lockedNode.dependencyState),
            )
          : null;
        await transaction
          .update(schema.workflowRunNodes)
          .set({
            status: parentStatus,
            structuredResult: collectionResult,
            measuredUsage: nodeUsage,
            waitingAt: parentStatus === "waiting-for-approval" ? now : null,
            completedAt: terminal ? now : null,
            updatedAt: now,
          })
          .where(eq(schema.workflowRunNodes.id, lockedNode.id));
        const lockedRun = await lockWorkflowRun(
          transaction,
          ownerId,
          lease.candidate.run.id,
        );
        if (!lockedRun) throw new Error("Workflow run is unavailable.");
        if (terminal) {
          await settleWorkflowDependencies(transaction, {
            now,
            runId: lease.candidate.run.id,
            selectedDependencyIds: null,
            sourceNodeId: lockedNode.id,
          });
        }
        await recomputeWorkflowRun(transaction, {
          codexThreadId: null,
          lockedRun,
          now,
        });
        return {
          retryScheduled: false,
          terminalizedPipeline: false,
          updated: true,
        };
      }
      await transaction
        .update(schema.workflowRunNodeItems)
        .set({ status: "skipped", completedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.workflowRunNodeItems.runNodeId, lockedNode.id),
            eq(schema.workflowRunNodeItems.status, "ready"),
          ),
        );
      await transaction
        .update(schema.workflowRunNodes)
        .set({
          status: input.status === "interrupted" ? "cancelled" : "failed",
          measuredUsage: nodeUsage,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.workflowRunNodes.id, lockedNode.id));
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
      await transaction
        .update(schema.workflowRuns)
        .set({
          status: input.status === "interrupted" ? "cancelled" : "failed",
          errorCode: input.code.slice(0, 200),
          errorMessage: message,
          pauseReason: null,
          pausedAt: null,
          recoveryState: "stable",
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.workflowRuns.id, lease.candidate.run.id));
      return {
        retryScheduled: false,
        terminalizedPipeline: true,
        updated: true,
      };
    });
    let interruptions: WorkflowCancellationExecutionContext[] = [];
    if (outcome.updated) {
      if (outcome.terminalizedPipeline) {
        const detail = await this.getRun(ownerId, lease.candidate.run.id);
        interruptions = detail
          ? this.cancellationContexts(detail).filter(
              ({ attemptId, runNodeId }) =>
                runNodeId === lease.candidate.node.id &&
                attemptId !== lease.attemptId,
            )
          : [];
        await this.terminalizeWorkflowInteractions(
          lease.candidate.run.id,
          lease.candidate.node.id,
          "interrupted",
        );
      } else {
        const attemptRows = await this.database
          .select({ threadId: schema.workflowNodeAttempts.codexThreadId })
          .from(schema.workflowNodeAttempts)
          .where(eq(schema.workflowNodeAttempts.id, lease.attemptId))
          .limit(1);
        if (attemptRows[0]?.threadId) {
          await this.terminalizeWorkflowInteractions(
            lease.candidate.run.id,
            lease.candidate.node.id,
            "interrupted",
            attemptRows[0].threadId,
          );
        }
      }
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
          collectionItemId: item.id,
          collectionItemKey: item.itemKey,
          collectionItemPosition: item.position,
          pipelineStepKey: pipeline.step.key,
          pipelineStepPosition: pipeline.stepPosition,
          unitAttempt: lease.unitAttempt,
        },
        actorType: "server",
        actorId: null,
      });
    }
    return {
      interruptions,
      retryScheduled: outcome.updated && outcome.retryScheduled,
    };
  }

  private async failMapItemAttempt(
    ownerId: string,
    lease: WorkflowAttemptLease,
    input: {
      code: string;
      message: string;
      status: "failed" | "interrupted" | "orphaned" | "timed-out";
    },
  ): Promise<WorkflowAttemptFailureResult> {
    const item = lease.candidate.item!;
    const configuration = workflowMapNodeConfigurationSchema.parse(
      lease.candidate.configuration,
    );
    const now = new Date();
    const message = input.message.trim().slice(0, 5_000) || input.code;
    const automaticAttemptLimit =
      configuration.automaticRetries === null
        ? lease.budget.maxAttemptsPerNode
        : Math.min(
            lease.budget.maxAttemptsPerNode,
            configuration.automaticRetries + 1,
          );
    const retryEligible =
      input.status !== "orphaned" &&
      input.status !== "interrupted" &&
      lease.unitAttempt < automaticAttemptLimit;
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
            eq(schema.workflowNodeAttempts.runNodeItemId, item.id),
            inArray(schema.workflowNodeAttempts.status, [
              "queued",
              "running",
              "waiting-for-approval",
            ]),
          ),
        )
        .returning({
          id: schema.workflowNodeAttempts.id,
          measuredUsage: schema.workflowNodeAttempts.measuredUsage,
        });
      if (!attempts[0]) {
        return {
          retryScheduled: false,
          terminalizedMap: false,
          updated: false,
        };
      }
      const runRows = await transaction
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
        runRows[0] !== undefined &&
        ["queued", "running", "waiting"].includes(runRows[0].status);
      const runIsPaused = runRows[0]?.status === "paused";
      const runCanSettle = runIsActive || runIsPaused;
      const retryScheduled = retryEligible && runCanSettle;
      await transaction
        .update(schema.workflowRunNodeItems)
        .set({
          status:
            input.status === "orphaned"
              ? "recovering"
              : retryScheduled
                ? "ready"
                : input.status === "interrupted"
                  ? "cancelled"
                  : "failed",
          measuredUsage: attempts[0].measuredUsage,
          errorCode: input.code.slice(0, 200),
          errorMessage: message,
          executionLeaseKey: null,
          timeoutAt: null,
          waitingAt: null,
          readyAt: retryScheduled ? now : null,
          completedAt:
            retryScheduled || input.status === "orphaned" ? null : now,
          updatedAt: now,
        })
        .where(eq(schema.workflowRunNodeItems.id, item.id));
      const nodeRows = await transaction
        .select()
        .from(schema.workflowRunNodes)
        .where(eq(schema.workflowRunNodes.id, lease.candidate.node.id))
        .for("update")
        .limit(1);
      const lockedNode = nodeRows[0];
      if (!lockedNode) throw new Error("The map node is unavailable.");
      const itemRows = await transaction
        .select()
        .from(schema.workflowRunNodeItems)
        .where(
          eq(schema.workflowRunNodeItems.runNodeId, lease.candidate.node.id),
        )
        .orderBy(asc(schema.workflowRunNodeItems.position));
      const itemUsage = aggregateWorkflowUsage(
        itemRows.map(({ measuredUsage: usage }) => usage),
      );
      if (!runCanSettle) {
        return {
          retryScheduled: false,
          terminalizedMap: false,
          updated: true,
        };
      }
      if (input.status === "orphaned") {
        await transaction
          .update(schema.workflowRunNodes)
          .set({
            status: "recovering",
            measuredUsage: itemUsage,
            updatedAt: now,
          })
          .where(eq(schema.workflowRunNodes.id, lease.candidate.node.id));
        await transaction
          .update(schema.workflowRuns)
          .set({
            status: "recovering",
            errorCode: input.code.slice(0, 200),
            errorMessage: message,
            pauseReason: null,
            pausedAt: null,
            recoveryState: "blocked",
            updatedAt: now,
          })
          .where(eq(schema.workflowRuns.id, lease.candidate.run.id));
        return {
          retryScheduled: false,
          terminalizedMap: false,
          updated: true,
        };
      }
      if (retryScheduled) {
        await transaction
          .update(schema.workflowRunNodes)
          .set({
            status: "running",
            measuredUsage: itemUsage,
            updatedAt: now,
          })
          .where(eq(schema.workflowRunNodes.id, lease.candidate.node.id));
        await transaction
          .update(schema.workflowRuns)
          .set({
            status: runIsPaused ? "paused" : "running",
            errorCode: null,
            errorMessage: null,
            recoveryState: "stable",
            updatedAt: now,
          })
          .where(eq(schema.workflowRuns.id, lease.candidate.run.id));
        return {
          retryScheduled: true,
          terminalizedMap: false,
          updated: true,
        };
      }
      if (
        configuration.failurePolicy === "continue" &&
        input.status !== "interrupted"
      ) {
        const terminal = itemRows.every(({ status }) =>
          ["completed", "failed"].includes(status),
        );
        const parentStatus = terminal
          ? "completed"
          : itemRows.some(({ status }) => ["ready", "running"].includes(status))
            ? "running"
            : itemRows.some(({ status }) => status === "waiting-for-approval")
              ? "waiting-for-approval"
              : "running";
        const mapResult = terminal
          ? aggregateCollectionItems(
              itemRows.map((row) =>
                workflowRunNodeItemSchema.parse({
                  ...row,
                  notBefore: nullableISOString(row.notBefore),
                  timeoutAt: nullableISOString(row.timeoutAt),
                  readyAt: nullableISOString(row.readyAt),
                  startedAt: nullableISOString(row.startedAt),
                  waitingAt: nullableISOString(row.waitingAt),
                  completedAt: nullableISOString(row.completedAt),
                  createdAt: toISOString(row.createdAt),
                  updatedAt: toISOString(row.updatedAt),
                }),
              ),
              collectionState(lockedNode.dependencyState),
            )
          : null;
        await transaction
          .update(schema.workflowRunNodes)
          .set({
            status: parentStatus,
            structuredResult: mapResult,
            measuredUsage: itemUsage,
            waitingAt: parentStatus === "waiting-for-approval" ? now : null,
            completedAt: terminal ? now : null,
            updatedAt: now,
          })
          .where(eq(schema.workflowRunNodes.id, lease.candidate.node.id));
        const lockedRun = await lockWorkflowRun(
          transaction,
          ownerId,
          lease.candidate.run.id,
        );
        if (!lockedRun) throw new Error("Workflow run is unavailable.");
        if (terminal) {
          await settleWorkflowDependencies(transaction, {
            now,
            runId: lease.candidate.run.id,
            selectedDependencyIds: null,
            sourceNodeId: lease.candidate.node.id,
          });
        }
        await recomputeWorkflowRun(transaction, {
          codexThreadId: null,
          lockedRun,
          now,
        });
        return {
          retryScheduled: false,
          terminalizedMap: false,
          updated: true,
        };
      }
      await transaction
        .update(schema.workflowRunNodeItems)
        .set({ status: "skipped", completedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.workflowRunNodeItems.runNodeId, lease.candidate.node.id),
            eq(schema.workflowRunNodeItems.status, "ready"),
          ),
        );
      await transaction
        .update(schema.workflowRunNodes)
        .set({
          status: input.status === "interrupted" ? "cancelled" : "failed",
          measuredUsage: itemUsage,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.workflowRunNodes.id, lease.candidate.node.id));
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
      await transaction
        .update(schema.workflowRuns)
        .set({
          status: input.status === "interrupted" ? "cancelled" : "failed",
          errorCode: input.code.slice(0, 200),
          errorMessage: message,
          pauseReason: null,
          pausedAt: null,
          recoveryState: "stable",
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.workflowRuns.id, lease.candidate.run.id));
      return {
        retryScheduled: false,
        terminalizedMap: true,
        updated: true,
      };
    });
    let interruptions: WorkflowCancellationExecutionContext[] = [];
    if (outcome.updated) {
      const terminalizesMap = outcome.terminalizedMap;
      if (terminalizesMap) {
        const detail = await this.getRun(ownerId, lease.candidate.run.id);
        interruptions = detail
          ? this.cancellationContexts(detail).filter(
              ({ attemptId, runNodeId }) =>
                runNodeId === lease.candidate.node.id &&
                attemptId !== lease.attemptId,
            )
          : [];
        await this.terminalizeWorkflowInteractions(
          lease.candidate.run.id,
          lease.candidate.node.id,
          "interrupted",
        );
      }
      const attemptRows = await this.database
        .select({ threadId: schema.workflowNodeAttempts.codexThreadId })
        .from(schema.workflowNodeAttempts)
        .where(eq(schema.workflowNodeAttempts.id, lease.attemptId))
        .limit(1);
      if (!terminalizesMap && attemptRows[0]?.threadId) {
        await this.terminalizeWorkflowInteractions(
          lease.candidate.run.id,
          lease.candidate.node.id,
          "interrupted",
          attemptRows[0].threadId,
        );
      }
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
          mapItemId: item.id,
          mapItemKey: item.itemKey,
          mapItemPosition: item.position,
        },
        actorType: "server",
        actorId: null,
      });
    }
    return {
      interruptions,
      retryScheduled: outcome.updated && outcome.retryScheduled,
    };
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
      const item = row.attempt.runNodeItemId
        ? (detail.items.find(({ id }) => id === row.attempt.runNodeItemId) ??
          null)
        : null;
      const revisionRows = await this.database
        .select({
          configuration: schema.workflowRevisionNodes.configuration,
          outputSchema: schema.workflowRevisionNodes.outputSchema,
        })
        .from(schema.workflowRevisionNodes)
        .where(eq(schema.workflowRevisionNodes.id, node.revisionNodeId))
        .limit(1);
      const pipelineConfiguration =
        node.nodeType === "pipeline"
          ? workflowPipelineNodeConfigurationSchema.parse(
              revisionRows[0]?.configuration,
            )
          : null;
      const repeatUntilConfiguration =
        node.nodeType === "repeatUntil"
          ? workflowRepeatUntilNodeConfigurationSchema.parse(
              revisionRows[0]?.configuration,
            )
          : null;
      const nodeDependencyState = workflowJsonObjectSchema.parse(
        node.dependencyState,
      );
      const repeatUntilState = repeatUntilConfiguration
        ? repeatUntilExecutionState(nodeDependencyState.repeatUntil)
        : null;
      const itemState = item?.executionState
        ? workflowRunNodeItemExecutionStateSchema.parse(item.executionState)
        : null;
      const pipelineStep =
        pipelineConfiguration && itemState?.kind === "pipeline"
          ? pipelineConfiguration.steps[itemState.currentStepPosition]
          : null;
      const configuration =
        node.nodeType === "map"
          ? workflowMapNodeConfigurationSchema.parse(
              revisionRows[0]?.configuration,
            )
          : (repeatUntilConfiguration ?? pipelineStep ?? null);
      const pipeline =
        pipelineConfiguration && pipelineStep && itemState?.kind === "pipeline"
          ? {
              configuration: pipelineConfiguration,
              step: pipelineStep,
              stepPosition: itemState.currentStepPosition,
            }
          : null;
      const candidate: WorkflowAgentCandidate = {
        configuration,
        item,
        node,
        outputSchema:
          pipelineStep?.outputSchema ??
          workflowJsonObjectSchema.parse(revisionRows[0]?.outputSchema ?? {}),
        pipeline,
        projectId: detail.run.projectId,
        repeatUntil:
          repeatUntilConfiguration && repeatUntilState
            ? {
                configuration: repeatUntilConfiguration,
                state: repeatUntilState,
              }
            : null,
        run: detail.run,
        structuredInput: item?.structuredInput ?? node.structuredInput,
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
          timeoutMs: node.budget.maxNodeDurationMs,
          unitAttempt:
            itemState?.kind === "pipeline"
              ? itemState.currentStepAttemptCount
              : repeatUntilState
                ? repeatUntilState.currentIterationAttemptCount
                : row.attempt.attempt,
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

  async pauseRun(
    ownerId: string,
    runId: string,
    input: WorkflowRunPause,
  ): Promise<WorkflowRunDetail | null> {
    const eventKey = `run-pause:${input.idempotencyKey}`;
    const controlPayload = {
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    };
    const now = new Date();
    for (let retry = 0; retry < 20; retry += 1) {
      try {
        const found = await this.database.transaction(async (transaction) => {
          const lockedRun = await lockWorkflowRun(transaction, ownerId, runId);
          if (!lockedRun) return false;
          const existingEvents = await transaction
            .select({ payload: schema.workflowRunEvents.payload })
            .from(schema.workflowRunEvents)
            .where(
              and(
                eq(schema.workflowRunEvents.runId, runId),
                eq(schema.workflowRunEvents.eventKey, eventKey),
              ),
            )
            .limit(1);
          if (existingEvents[0]) {
            const payload = workflowJsonObjectSchema.parse(
              existingEvents[0].payload,
            );
            if (
              canonicalJson({
                reason: payload.reason ?? null,
                idempotencyKey: payload.idempotencyKey,
              }) !== canonicalJson(controlPayload)
            ) {
              throw new WorkflowControlConflictError(
                "This pause idempotency key was already used with different input.",
              );
            }
            return true;
          }
          if (!["queued", "running", "waiting"].includes(lockedRun.status)) {
            throw new WorkflowControlConflictError(
              `A ${lockedRun.status} workflow run cannot be paused.`,
            );
          }
          await transaction
            .update(schema.workflowRuns)
            .set({
              status: "paused",
              pauseReason: input.reason,
              pausedAt: now,
              updatedAt: now,
            })
            .where(eq(schema.workflowRuns.id, runId));
          await insertWorkflowRunEvent(transaction, {
            runId,
            runNodeId: null,
            attemptId: null,
            eventKey,
            type: "run.paused",
            payload: controlPayload,
            actorType: "user",
            actorId: ownerId,
          });
          return true;
        });
        if (!found) return null;
        return this.getRun(ownerId, runId);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error("Workflow pause event contention exceeded its limit.");
  }

  async resumeRun(
    ownerId: string,
    runId: string,
    input: WorkflowRunResume,
  ): Promise<WorkflowRunDetail | null> {
    const eventKey = `run-resume:${input.idempotencyKey}`;
    const controlPayload = {
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    };
    const now = new Date();
    for (let retry = 0; retry < 20; retry += 1) {
      try {
        const found = await this.database.transaction(async (transaction) => {
          const lockedRun = await lockWorkflowRun(transaction, ownerId, runId);
          if (!lockedRun) return false;
          const existingEvents = await transaction
            .select({ payload: schema.workflowRunEvents.payload })
            .from(schema.workflowRunEvents)
            .where(
              and(
                eq(schema.workflowRunEvents.runId, runId),
                eq(schema.workflowRunEvents.eventKey, eventKey),
              ),
            )
            .limit(1);
          if (existingEvents[0]) {
            const payload = workflowJsonObjectSchema.parse(
              existingEvents[0].payload,
            );
            if (
              canonicalJson({
                reason: payload.reason ?? null,
                idempotencyKey: payload.idempotencyKey,
              }) !== canonicalJson(controlPayload)
            ) {
              throw new WorkflowControlConflictError(
                "This resume idempotency key was already used with different input.",
              );
            }
            return true;
          }
          if (lockedRun.status !== "paused") {
            throw new WorkflowControlConflictError(
              `A ${lockedRun.status} workflow run cannot be resumed.`,
            );
          }
          await transaction
            .update(schema.workflowRuns)
            .set({
              status: "queued",
              pauseReason: null,
              pausedAt: null,
              updatedAt: now,
            })
            .where(eq(schema.workflowRuns.id, runId));
          const transition = await recomputeWorkflowRun(transaction, {
            codexThreadId: null,
            lockedRun: {
              ...lockedRun,
              status: "queued",
              pauseReason: null,
              pausedAt: null,
            },
            now,
          });
          await insertWorkflowRunEvent(transaction, {
            runId,
            runNodeId: null,
            attemptId: null,
            eventKey,
            type: "run.resumed",
            payload: { ...controlPayload, runStatus: transition.status },
            actorType: "user",
            actorId: ownerId,
          });
          return true;
        });
        if (!found) return null;
        return this.getRun(ownerId, runId);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error("Workflow resume event contention exceeded its limit.");
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
      await transaction
        .update(schema.workflowRunNodeItems)
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
            inArray(
              schema.workflowRunNodeItems.runNodeId,
              detail.nodes.map(({ id }) => id),
            ),
            inArray(schema.workflowRunNodeItems.status, [
              "ready",
              "running",
              "waiting-for-approval",
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
      await transaction
        .update(schema.workflowApprovalGates)
        .set({ status: "cancelled", updatedAt: now })
        .where(
          and(
            eq(schema.workflowApprovalGates.runId, runId),
            eq(schema.workflowApprovalGates.status, "pending"),
          ),
        );
      const runs = await transaction
        .update(schema.workflowRuns)
        .set({
          status: "cancelled",
          structuredResult: null,
          errorCode: "cancelled-by-user",
          errorMessage: input.reason,
          cancelReason: input.reason,
          cancelRequestedAt: now,
          pauseReason: null,
          pausedAt: null,
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
    if (
      detail.run.errorCode !== null &&
      [
        "workflow-cost-budget-exceeded",
        "workflow-cost-budget-unavailable",
        "workflow-duration-budget-exceeded",
        "workflow-token-budget-exceeded",
      ].includes(detail.run.errorCode)
    ) {
      throw new WorkflowControlConflictError(
        "A run-wide hard limit cannot be bypassed by retrying a node; start a new run with a revised budget.",
      );
    }
    if (node.nodeType === "condition" || node.nodeType === "gate") {
      throw new WorkflowControlConflictError(
        `${node.nodeType} decisions are deterministic and final; start a new run instead of retrying this node.`,
      );
    }
    if (
      node.nodeType === "repeatUntil" &&
      detail.run.errorCode !== null &&
      [
        "repeat-duration-limit",
        "repeat-iteration-limit",
        "repeat-no-progress",
        "workflow-node-budget-exceeded",
      ].includes(detail.run.errorCode)
    ) {
      throw new WorkflowControlConflictError(
        "A repeat-until hard limit cannot be bypassed by retrying the node; start a new run with a revised limit.",
      );
    }
    if (!["failed", "cancelled", "recovering"].includes(node.status)) {
      throw new WorkflowControlConflictError(
        `A ${node.status} workflow node cannot be retried.`,
      );
    }
    const collectionItems = detail.items.filter(
      ({ runNodeId: itemNodeId }) => itemNodeId === runNodeId,
    );
    const itemAttemptCount = (item: WorkflowRunNodeItem) =>
      node.nodeType === "pipeline"
        ? pipelineExecutionState(item.executionState).currentStepAttemptCount
        : item.attemptCount;
    const retryableCollectionItems = collectionItems.filter(
      (item) =>
        item.status === "skipped" ||
        (["failed", "cancelled", "recovering"].includes(item.status) &&
          itemAttemptCount(item) < node.budget.maxAttemptsPerNode),
    );
    const exhaustedCollectionItems = collectionItems.filter(
      (item) =>
        ["failed", "cancelled", "recovering"].includes(item.status) &&
        itemAttemptCount(item) >= node.budget.maxAttemptsPerNode,
    );
    const collectionNode =
      node.nodeType === "map" || node.nodeType === "pipeline";
    const repeatUntilAttemptCount =
      node.nodeType === "repeatUntil"
        ? repeatUntilExecutionState(
            workflowJsonObjectSchema.parse(node.dependencyState).repeatUntil,
          ).currentIterationAttemptCount
        : null;
    if (collectionNode && exhaustedCollectionItems.length > 0) {
      throw new WorkflowControlConflictError(
        "At least one collection item exhausted its current execution-unit attempt budget.",
      );
    }
    if (collectionNode && retryableCollectionItems.length === 0) {
      throw new WorkflowControlConflictError(
        "The collection node has no retryable items within its attempt budget.",
      );
    }
    if (
      !collectionNode &&
      (repeatUntilAttemptCount ?? node.attemptCount) >=
        node.budget.maxAttemptsPerNode
    ) {
      throw new WorkflowControlConflictError(
        "The workflow node exhausted its attempt budget.",
      );
    }
    const now = new Date();
    await this.database.transaction(async (transaction) => {
      const nodes = await transaction
        .update(schema.workflowRunNodes)
        .set({
          status: collectionNode ? "running" : "ready",
          structuredResult:
            node.nodeType === "repeatUntil" ? node.structuredResult : null,
          executionLeaseKey: null,
          notBefore: null,
          timeoutAt: null,
          readyAt: collectionNode ? null : now,
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
      if (collectionNode) {
        await transaction
          .update(schema.workflowRunNodeItems)
          .set({
            status: "ready",
            ...(node.nodeType === "map" ? { structuredResult: null } : {}),
            errorCode: null,
            errorMessage: null,
            executionLeaseKey: null,
            notBefore: null,
            timeoutAt: null,
            readyAt: now,
            waitingAt: null,
            completedAt: null,
            updatedAt: now,
          })
          .where(
            inArray(
              schema.workflowRunNodeItems.id,
              retryableCollectionItems.map(({ id }) => id),
            ),
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

  async decideGate(
    ownerId: string,
    runId: string,
    gateId: string,
    input: WorkflowGateDecision,
  ): Promise<WorkflowGateDecisionResult | null> {
    await this.expirePendingGates(ownerId);
    return this.resolveGate(ownerId, runId, gateId, {
      actorId: ownerId,
      actorType: "user",
      eventKey: `gate-decision:${gateId}:${input.idempotencyKey}`,
      idempotencyPayload: {
        gateId,
        decision: input.decision,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      },
      outcome: input.decision,
      reason: input.reason,
    });
  }

  async expirePendingGates(
    ownerId: string,
    now = new Date(),
  ): Promise<string[]> {
    const terminalGateRows = await this.database
      .select({ runId: schema.workflowApprovalGates.runId })
      .from(schema.workflowApprovalGates)
      .innerJoin(
        schema.workflowRuns,
        and(
          eq(schema.workflowRuns.id, schema.workflowApprovalGates.runId),
          eq(schema.workflowRuns.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.workflowApprovalGates.status, "pending"),
          inArray(schema.workflowRuns.status, [
            "completed",
            "failed",
            "cancelled",
          ]),
        ),
      )
      .limit(100);
    for (const terminalRunId of new Set(
      terminalGateRows.map(({ runId }) => runId),
    )) {
      await this.database.transaction((transaction) =>
        cancelPendingWorkflowGates(transaction, {
          now,
          runId: terminalRunId,
        }),
      );
    }
    const rows = await this.database
      .select({
        gateId: schema.workflowApprovalGates.id,
        runId: schema.workflowApprovalGates.runId,
      })
      .from(schema.workflowApprovalGates)
      .innerJoin(
        schema.workflowRuns,
        and(
          eq(schema.workflowRuns.id, schema.workflowApprovalGates.runId),
          eq(schema.workflowRuns.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.workflowApprovalGates.status, "pending"),
          lte(schema.workflowApprovalGates.expiresAt, now),
        ),
      )
      .orderBy(asc(schema.workflowApprovalGates.expiresAt))
      .limit(100);
    const runIds = new Set<string>();
    for (const row of rows) {
      const result = await this.resolveGate(ownerId, row.runId, row.gateId, {
        actorId: null,
        actorType: "server",
        eventKey: `gate-expired:${row.gateId}`,
        idempotencyPayload: null,
        outcome: "expired",
        reason: "The workflow approval gate expired before a decision.",
        now,
      });
      if (result) runIds.add(row.runId);
    }
    return [...runIds];
  }

  async getInteractionExecutionContext(
    ownerId: string,
    runId: string,
    runNodeId: string,
    threadId: string,
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
        and(
          eq(schema.workflowNodeAttempts.codexThreadId, threadId),
          inArray(schema.workflowNodeAttempts.status, [
            "running",
            "waiting-for-approval",
          ]),
        ),
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
    threadId?: string,
  ): Promise<number> {
    const rows = await this.database
      .update(schema.agentInteractionRequests)
      .set({ status, resolvedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.agentInteractionRequests.workflowRunId, runId),
          eq(schema.agentInteractionRequests.workflowNodeId, runNodeId),
          ...(threadId
            ? [eq(schema.agentInteractionRequests.threadId, threadId)]
            : []),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      )
      .returning({ id: schema.agentInteractionRequests.id });
    return rows.length;
  }

  async terminalizeWorkflowInteraction(
    runId: string,
    runNodeId: string,
    attemptId: string,
    requestKey: string,
    status: "expired" | "interrupted",
  ): Promise<boolean> {
    const attemptRows = await this.database
      .select({ threadId: schema.workflowNodeAttempts.codexThreadId })
      .from(schema.workflowNodeAttempts)
      .where(
        and(
          eq(schema.workflowNodeAttempts.id, attemptId),
          eq(schema.workflowNodeAttempts.runNodeId, runNodeId),
        ),
      )
      .limit(1);
    const threadId = attemptRows[0]?.threadId;
    if (!threadId) return false;
    const now = new Date();
    const rows = await this.database
      .update(schema.agentInteractionRequests)
      .set({ status, resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.agentInteractionRequests.requestKey, requestKey),
          eq(schema.agentInteractionRequests.workflowRunId, runId),
          eq(schema.agentInteractionRequests.workflowNodeId, runNodeId),
          eq(schema.agentInteractionRequests.threadId, threadId),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      )
      .returning({ id: schema.agentInteractionRequests.id });
    return Boolean(rows[0]);
  }

  private async initializeRepeatUntilNode(
    ownerId: string,
    detail: WorkflowRunDetail,
    node: WorkflowRunNode,
  ): Promise<boolean> {
    const now = new Date();
    const executionState = workflowRepeatUntilExecutionStateSchema.parse({
      kind: "repeatUntil",
      currentIteration: 1,
      currentIterationAttemptCount: 0,
      startedAt: now.toISOString(),
      unchangedIterations: 0,
      logicalNodeCount: 1,
      lastProgress: { available: false },
      completedIterations: [],
    });
    for (let retry = 0; retry < 20; retry += 1) {
      try {
        return await this.database.transaction(async (transaction) => {
          const nodes = await transaction
            .update(schema.workflowRunNodes)
            .set({
              dependencyState: {
                ...workflowJsonObjectSchema.parse(node.dependencyState),
                repeatUntil: executionState,
              },
              startedAt: node.startedAt ? new Date(node.startedAt) : now,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.workflowRunNodes.id, node.id),
                eq(schema.workflowRunNodes.runId, detail.run.id),
                eq(schema.workflowRunNodes.status, "ready"),
              ),
            )
            .returning({ id: schema.workflowRunNodes.id });
          if (!nodes[0]) return false;
          const lockedRun = await lockWorkflowRun(
            transaction,
            ownerId,
            detail.run.id,
          );
          if (
            !lockedRun ||
            !["queued", "running", "waiting"].includes(lockedRun.status)
          ) {
            throw new Error(
              "The workflow run changed state while initializing its repeat-until node.",
            );
          }
          await transaction
            .update(schema.workflowRuns)
            .set({
              status: "running",
              startedAt: lockedRun.startedAt ?? now,
              updatedAt: now,
            })
            .where(eq(schema.workflowRuns.id, detail.run.id));
          await insertWorkflowRunEvent(transaction, {
            runId: detail.run.id,
            runNodeId: node.id,
            attemptId: null,
            eventKey: `repeat-until-initialized:${node.id}`,
            type: "node.repeat-until.initialized",
            payload: {
              currentIteration: executionState.currentIteration,
              startedAt: executionState.startedAt,
            },
            actorType: "server",
            actorId: null,
          });
          return true;
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error(
      "Repeat-until initialization event contention exceeded its limit.",
    );
  }

  private async failReadyRepeatUntilNode(
    ownerId: string,
    detail: WorkflowRunDetail,
    node: WorkflowRunNode,
    code: string,
    message: string,
  ): Promise<boolean> {
    const now = new Date();
    const updated = await this.database.transaction(async (transaction) => {
      const nodes = await transaction
        .update(schema.workflowRunNodes)
        .set({ status: "failed", completedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.workflowRunNodes.id, node.id),
            eq(schema.workflowRunNodes.runId, detail.run.id),
            eq(schema.workflowRunNodes.status, "ready"),
          ),
        )
        .returning({ id: schema.workflowRunNodes.id });
      if (!nodes[0]) return false;
      const runs = await transaction
        .update(schema.workflowRuns)
        .set({
          status: "failed",
          errorCode: code.slice(0, 200),
          errorMessage: message.slice(0, 5_000),
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workflowRuns.id, detail.run.id),
            eq(schema.workflowRuns.ownerId, ownerId),
            inArray(schema.workflowRuns.status, [
              "queued",
              "running",
              "waiting",
            ]),
          ),
        )
        .returning({ id: schema.workflowRuns.id });
      if (!runs[0]) {
        throw new Error(
          "The workflow run changed state while failing its repeat-until node.",
        );
      }
      await transaction
        .update(schema.workflowRunNodes)
        .set({ status: "skipped", completedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.workflowRunNodes.runId, detail.run.id),
            inArray(schema.workflowRunNodes.status, ["blocked", "ready"]),
          ),
        );
      await transaction
        .update(schema.workflowRunNodeDependencies)
        .set({ status: "failed" })
        .where(
          and(
            eq(schema.workflowRunNodeDependencies.runId, detail.run.id),
            eq(schema.workflowRunNodeDependencies.status, "blocked"),
          ),
        );
      await insertWorkflowRunEvent(transaction, {
        runId: detail.run.id,
        runNodeId: node.id,
        attemptId: null,
        eventKey: `repeat-until-failed:${node.id}:${code}`,
        type: "node.repeat-until.failed",
        payload: { code, message },
        actorType: "server",
        actorId: null,
      });
      return true;
    });
    if (updated) {
      await this.database.transaction((transaction) =>
        cancelPendingWorkflowGates(transaction, {
          now,
          runId: detail.run.id,
        }),
      );
    }
    return updated;
  }

  private async initializePipelineNode(
    ownerId: string,
    detail: WorkflowRunDetail,
    node: WorkflowRunNode,
    configuration: WorkflowPipelineNodeConfiguration,
  ): Promise<boolean> {
    const selected = workflowValueAtPointer(
      workflowJsonValueSchema.parse(node.structuredInput),
      configuration.collectionPath,
    );
    if (
      !selected.found ||
      selected.value === null ||
      typeof selected.value !== "object"
    ) {
      await this.failUnsupportedRun(
        ownerId,
        detail.run.id,
        `The pipeline collection path ${configuration.collectionPath || "<root>"} must select a JSON array or object.`,
      );
      return true;
    }
    const collection = workflowJsonValueSchema.parse(selected.value);
    const collectionKind = Array.isArray(collection) ? "array" : "object";
    const objectCollection = Array.isArray(collection)
      ? null
      : workflowJsonObjectSchema.parse(collection);
    const entries: Array<[string, WorkflowJsonValue]> = Array.isArray(
      collection,
    )
      ? collection.map((value, index) => [String(index), value])
      : Object.keys(objectCollection!)
          .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
          .map((key) => [key, objectCollection![key]!]);
    if (entries.some(([key]) => key.length > 10_000)) {
      await this.failUnsupportedRun(
        ownerId,
        detail.run.id,
        "Pipeline collection keys cannot exceed 10,000 characters.",
      );
      return true;
    }
    const logicalNodeCount = entries.length * configuration.steps.length;
    if (
      expandedWorkflowNodeCount(detail) + logicalNodeCount >
      detail.run.budget.maxNodes
    ) {
      await this.failUnsupportedRun(
        ownerId,
        detail.run.id,
        "Expanding the pipeline collection would exceed the workflow node budget.",
      );
      return true;
    }
    const now = new Date();
    const itemRows = entries.map(([itemKey, value], position) => ({
      id: randomUUID(),
      runNodeId: node.id,
      itemKey,
      position,
      status: "ready" as const,
      executionState: {
        kind: "pipeline" as const,
        currentStepPosition: 0,
        currentStepAttemptCount: 0,
        completedSteps: [],
      },
      structuredInput: workflowJsonObjectSchema.parse({
        [configuration.itemInputKey]: value,
      }),
      measuredUsage: workflowMeasuredUsageSchema.parse({}),
      attemptCount: 0,
      readyAt: now,
      createdAt: now,
      updatedAt: now,
    }));
    for (let retry = 0; retry < 20; retry += 1) {
      try {
        return await this.database.transaction(async (transaction) => {
          const nodes = await transaction
            .update(schema.workflowRunNodes)
            .set({
              status: itemRows.length === 0 ? "completed" : "running",
              dependencyState: {
                ...workflowJsonObjectSchema.parse(node.dependencyState),
                collection: {
                  kind: collectionKind,
                  primitive: "pipeline",
                  totalItems: itemRows.length,
                  logicalNodeCount,
                  itemInputKey: configuration.itemInputKey,
                  maxConcurrency: configuration.maxConcurrency,
                  failurePolicy: configuration.failurePolicy,
                  stepCount: configuration.steps.length,
                },
              },
              structuredResult:
                itemRows.length === 0
                  ? collectionKind === "array"
                    ? []
                    : {}
                  : null,
              startedAt: node.startedAt ? new Date(node.startedAt) : now,
              readyAt: null,
              completedAt: itemRows.length === 0 ? now : null,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.workflowRunNodes.id, node.id),
                eq(schema.workflowRunNodes.runId, detail.run.id),
                eq(schema.workflowRunNodes.status, "ready"),
              ),
            )
            .returning({ id: schema.workflowRunNodes.id });
          if (!nodes[0]) return false;
          if (itemRows.length > 0) {
            await transaction
              .insert(schema.workflowRunNodeItems)
              .values(itemRows);
          }
          const lockedRun = await lockWorkflowRun(
            transaction,
            ownerId,
            detail.run.id,
          );
          if (
            !lockedRun ||
            !["queued", "running", "waiting"].includes(lockedRun.status)
          ) {
            throw new Error(
              "The workflow run changed state while initializing its pipeline node.",
            );
          }
          let readyNodeIds: string[] = [];
          let runStatus = "running";
          if (itemRows.length === 0) {
            readyNodeIds = (
              await settleWorkflowDependencies(transaction, {
                now,
                runId: detail.run.id,
                selectedDependencyIds: null,
                sourceNodeId: node.id,
              })
            ).readyNodeIds;
            runStatus = (
              await recomputeWorkflowRun(transaction, {
                codexThreadId: null,
                lockedRun,
                now,
              })
            ).status;
          } else {
            await transaction
              .update(schema.workflowRuns)
              .set({
                status: "running",
                startedAt: lockedRun.startedAt ?? now,
                updatedAt: now,
              })
              .where(eq(schema.workflowRuns.id, detail.run.id));
          }
          await insertWorkflowRunEvent(transaction, {
            runId: detail.run.id,
            runNodeId: node.id,
            attemptId: null,
            eventKey: `pipeline-initialized:${node.id}`,
            type: "node.pipeline.initialized",
            payload: {
              collectionKind,
              itemCount: itemRows.length,
              collectionPath: configuration.collectionPath,
              maxConcurrency: configuration.maxConcurrency,
              failurePolicy: configuration.failurePolicy,
              stepKeys: configuration.steps.map(({ key }) => key),
              readyNodeIds,
              runStatus,
            },
            actorType: "server",
            actorId: null,
          });
          return true;
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error(
      "Pipeline initialization event contention exceeded its limit.",
    );
  }

  private async initializeMapNode(
    ownerId: string,
    detail: WorkflowRunDetail,
    node: WorkflowRunNode,
    configuration: WorkflowMapNodeConfiguration,
  ): Promise<boolean> {
    const selected = workflowValueAtPointer(
      workflowJsonValueSchema.parse(node.structuredInput),
      configuration.collectionPath,
    );
    if (
      !selected.found ||
      selected.value === null ||
      typeof selected.value !== "object"
    ) {
      await this.failUnsupportedRun(
        ownerId,
        detail.run.id,
        `The map collection path ${configuration.collectionPath || "<root>"} must select a JSON array or object.`,
      );
      return true;
    }
    const collection = workflowJsonValueSchema.parse(selected.value);
    const collectionKind = Array.isArray(collection) ? "array" : "object";
    const objectCollection = Array.isArray(collection)
      ? null
      : workflowJsonObjectSchema.parse(collection);
    const entries: Array<[string, WorkflowJsonValue]> = Array.isArray(
      collection,
    )
      ? collection.map((value, index) => [String(index), value])
      : Object.keys(objectCollection!)
          .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
          .map((key) => [key, objectCollection![key]!]);
    if (entries.some(([key]) => key.length > 10_000)) {
      await this.failUnsupportedRun(
        ownerId,
        detail.run.id,
        "Map collection keys cannot exceed 10,000 characters.",
      );
      return true;
    }
    if (
      expandedWorkflowNodeCount(detail) + entries.length >
      detail.run.budget.maxNodes
    ) {
      await this.failUnsupportedRun(
        ownerId,
        detail.run.id,
        "Expanding the map collection would exceed the workflow node budget.",
      );
      return true;
    }
    const now = new Date();
    const itemRows = entries.map(([itemKey, value], position) => ({
      id: randomUUID(),
      runNodeId: node.id,
      itemKey,
      position,
      status: "ready" as const,
      structuredInput: workflowJsonObjectSchema.parse({
        [configuration.itemInputKey]: value,
      }),
      measuredUsage: workflowMeasuredUsageSchema.parse({}),
      attemptCount: 0,
      readyAt: now,
      createdAt: now,
      updatedAt: now,
    }));
    for (let retry = 0; retry < 20; retry += 1) {
      try {
        return await this.database.transaction(async (transaction) => {
          const nodes = await transaction
            .update(schema.workflowRunNodes)
            .set({
              status: itemRows.length === 0 ? "completed" : "running",
              dependencyState: {
                ...workflowJsonObjectSchema.parse(node.dependencyState),
                collection: {
                  kind: collectionKind,
                  primitive: "map",
                  totalItems: itemRows.length,
                  logicalNodeCount: itemRows.length,
                  itemInputKey: configuration.itemInputKey,
                  maxConcurrency: configuration.maxConcurrency,
                  failurePolicy: configuration.failurePolicy,
                },
              },
              structuredResult:
                itemRows.length === 0
                  ? collectionKind === "array"
                    ? []
                    : {}
                  : null,
              startedAt: node.startedAt ? new Date(node.startedAt) : now,
              readyAt: null,
              completedAt: itemRows.length === 0 ? now : null,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.workflowRunNodes.id, node.id),
                eq(schema.workflowRunNodes.runId, detail.run.id),
                eq(schema.workflowRunNodes.status, "ready"),
              ),
            )
            .returning({ id: schema.workflowRunNodes.id });
          if (!nodes[0]) return false;
          if (itemRows.length > 0) {
            await transaction
              .insert(schema.workflowRunNodeItems)
              .values(itemRows);
          }
          const lockedRun = await lockWorkflowRun(
            transaction,
            ownerId,
            detail.run.id,
          );
          if (
            !lockedRun ||
            !["queued", "running", "waiting"].includes(lockedRun.status)
          ) {
            throw new Error(
              "The workflow run changed state while initializing its map node.",
            );
          }
          let readyNodeIds: string[] = [];
          let runStatus = "running";
          if (itemRows.length === 0) {
            readyNodeIds = (
              await settleWorkflowDependencies(transaction, {
                now,
                runId: detail.run.id,
                selectedDependencyIds: null,
                sourceNodeId: node.id,
              })
            ).readyNodeIds;
            runStatus = (
              await recomputeWorkflowRun(transaction, {
                codexThreadId: null,
                lockedRun,
                now,
              })
            ).status;
          } else {
            await transaction
              .update(schema.workflowRuns)
              .set({
                status: "running",
                startedAt: lockedRun.startedAt ?? now,
                updatedAt: now,
              })
              .where(eq(schema.workflowRuns.id, detail.run.id));
          }
          await insertWorkflowRunEvent(transaction, {
            runId: detail.run.id,
            runNodeId: node.id,
            attemptId: null,
            eventKey: `map-initialized:${node.id}`,
            type: "node.map.initialized",
            payload: {
              collectionKind,
              itemCount: itemRows.length,
              collectionPath: configuration.collectionPath,
              maxConcurrency: configuration.maxConcurrency,
              failurePolicy: configuration.failurePolicy,
              readyNodeIds,
              runStatus,
            },
            actorType: "server",
            actorId: null,
          });
          return true;
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error("Map initialization event contention exceeded its limit.");
  }

  private async resolveGate(
    ownerId: string,
    runId: string,
    gateId: string,
    control: {
      actorId: string | null;
      actorType: string;
      eventKey: string;
      idempotencyPayload: Record<string, unknown> | null;
      now?: Date;
      outcome: "approved" | "denied" | "expired";
      reason: string | null;
    },
  ): Promise<WorkflowGateDecisionResult | null> {
    const now = control.now ?? new Date();
    for (let retry = 0; retry < 20; retry += 1) {
      try {
        const transition = await this.database.transaction(
          async (transaction) => {
            const gateRows = await transaction
              .select({
                gate: schema.workflowApprovalGates,
                node: schema.workflowRunNodes,
                revisionNode: schema.workflowRevisionNodes,
              })
              .from(schema.workflowApprovalGates)
              .innerJoin(
                schema.workflowRunNodes,
                eq(
                  schema.workflowRunNodes.id,
                  schema.workflowApprovalGates.runNodeId,
                ),
              )
              .innerJoin(
                schema.workflowRevisionNodes,
                eq(
                  schema.workflowRevisionNodes.id,
                  schema.workflowRunNodes.revisionNodeId,
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
                and(
                  eq(schema.workflowApprovalGates.id, gateId),
                  eq(schema.workflowApprovalGates.runId, runId),
                ),
              )
              .limit(1);
            const row = gateRows[0];
            if (!row) return null;
            const lockedNodes = await transaction
              .select({ id: schema.workflowRunNodes.id })
              .from(schema.workflowRunNodes)
              .where(
                and(
                  eq(schema.workflowRunNodes.id, row.node.id),
                  eq(schema.workflowRunNodes.runId, runId),
                ),
              )
              .for("update")
              .limit(1);
            if (!lockedNodes[0]) return null;
            const lockedGates = await transaction
              .select()
              .from(schema.workflowApprovalGates)
              .where(
                and(
                  eq(schema.workflowApprovalGates.id, gateId),
                  eq(schema.workflowApprovalGates.runId, runId),
                ),
              )
              .for("update")
              .limit(1);
            const lockedGate = lockedGates[0];
            if (!lockedGate) return null;
            const lockedRun = await lockWorkflowRun(
              transaction,
              ownerId,
              runId,
            );
            if (!lockedRun) return null;
            const existingEvents = await transaction
              .select({ payload: schema.workflowRunEvents.payload })
              .from(schema.workflowRunEvents)
              .where(
                and(
                  eq(schema.workflowRunEvents.runId, runId),
                  eq(schema.workflowRunEvents.eventKey, control.eventKey),
                ),
              )
              .limit(1);
            if (existingEvents[0]) {
              if (
                control.idempotencyPayload &&
                canonicalJson(
                  workflowJsonObjectSchema.parse(existingEvents[0].payload)
                    .request,
                ) !== canonicalJson(control.idempotencyPayload)
              ) {
                throw new WorkflowControlConflictError(
                  "This gate decision idempotency key was already used with different input.",
                );
              }
              return {
                replayed: true,
                terminalizedRun: lockedRun.status === "failed",
              };
            }
            if (lockedGate.status !== "pending") {
              if (
                lockedGate.status === control.outcome ||
                control.outcome === "expired"
              ) {
                return {
                  replayed: true,
                  terminalizedRun: lockedRun.status === "failed",
                };
              }
              throw new WorkflowControlConflictError(
                `A ${lockedGate.status} workflow gate cannot be ${control.outcome}.`,
              );
            }
            if (
              !["queued", "running", "waiting", "paused"].includes(
                lockedRun.status,
              )
            ) {
              if (control.outcome === "expired") {
                return { replayed: true, terminalizedRun: true };
              }
              throw new WorkflowControlConflictError(
                `A gate on a ${lockedRun.status} workflow run cannot accept a decision.`,
              );
            }
            if (
              control.outcome !== "expired" &&
              lockedGate.expiresAt &&
              lockedGate.expiresAt.getTime() <= now.getTime()
            ) {
              throw new WorkflowControlConflictError(
                "The workflow gate has expired and can no longer accept a decision.",
              );
            }
            const configuration = workflowGateNodeConfigurationSchema.parse(
              row.revisionNode.configuration,
            );
            const gates = await transaction
              .update(schema.workflowApprovalGates)
              .set({
                status: control.outcome,
                decision:
                  control.outcome === "expired" ? null : control.outcome,
                decidedByUserId:
                  control.actorType === "user" ? control.actorId : null,
                decisionReason: control.reason,
                decidedAt: control.outcome === "expired" ? null : now,
                updatedAt: now,
              })
              .where(
                and(
                  eq(schema.workflowApprovalGates.id, gateId),
                  eq(schema.workflowApprovalGates.status, "pending"),
                ),
              )
              .returning({ id: schema.workflowApprovalGates.id });
            if (!gates[0]) {
              return { replayed: true, terminalizedRun: false };
            }

            const approved = control.outcome === "approved";
            const skipDownstream =
              !approved && configuration.denialPolicy === "skip-downstream";
            await transaction
              .update(schema.workflowRunNodes)
              .set({
                status: approved
                  ? "completed"
                  : skipDownstream
                    ? "skipped"
                    : "failed",
                structuredResult: approved ? row.node.structuredInput : null,
                waitingAt: null,
                completedAt: now,
                updatedAt: now,
              })
              .where(
                and(
                  eq(schema.workflowRunNodes.id, row.node.id),
                  eq(schema.workflowRunNodes.status, "waiting-for-approval"),
                ),
              );
            let readyNodeIds: string[] = [];
            let skippedNodeIds: string[] = [];
            let runStatus: string | null = null;
            if (approved || skipDownstream) {
              const dependencyTransition = await settleWorkflowDependencies(
                transaction,
                {
                  now,
                  runId,
                  selectedDependencyIds: approved ? null : new Set(),
                  sourceNodeId: row.node.id,
                },
              );
              readyNodeIds = dependencyTransition.readyNodeIds;
              skippedNodeIds = dependencyTransition.skippedNodeIds;
              const runTransition = await recomputeWorkflowRun(transaction, {
                codexThreadId: null,
                lockedRun,
                now,
              });
              runStatus = runTransition.updated ? runTransition.status : null;
            } else {
              await transaction
                .update(schema.workflowRunNodes)
                .set({ status: "skipped", completedAt: now, updatedAt: now })
                .where(
                  and(
                    eq(schema.workflowRunNodes.runId, runId),
                    inArray(schema.workflowRunNodes.status, [
                      "blocked",
                      "ready",
                    ]),
                  ),
                );
              await transaction
                .update(schema.workflowRunNodeDependencies)
                .set({ status: "failed" })
                .where(
                  and(
                    eq(schema.workflowRunNodeDependencies.runId, runId),
                    eq(schema.workflowRunNodeDependencies.status, "blocked"),
                  ),
                );
              await transaction
                .update(schema.workflowRuns)
                .set({
                  status: "failed",
                  errorCode:
                    control.outcome === "expired"
                      ? "gate-expired"
                      : "gate-denied",
                  errorMessage:
                    control.reason ??
                    (control.outcome === "expired"
                      ? "The workflow approval gate expired."
                      : "The workflow approval gate was denied."),
                  pauseReason: null,
                  pausedAt: null,
                  completedAt: now,
                  updatedAt: now,
                })
                .where(eq(schema.workflowRuns.id, runId));
              runStatus = "failed";
            }
            await insertWorkflowRunEvent(transaction, {
              runId,
              runNodeId: row.node.id,
              attemptId: null,
              eventKey: control.eventKey,
              type: `node.gate.${control.outcome}`,
              payload: {
                gateId,
                outcome: control.outcome,
                reason: control.reason,
                resolvedAt: now.toISOString(),
                request: control.idempotencyPayload,
                readyNodeIds,
                skippedNodeIds,
                runStatus,
              },
              actorType: control.actorType,
              actorId: control.actorId,
            });
            return {
              replayed: false,
              terminalizedRun: runStatus === "failed",
            };
          },
        );
        if (!transition) return null;
        if (transition.terminalizedRun) {
          await this.database.transaction((transaction) =>
            cancelPendingWorkflowGates(transaction, { now, runId }),
          );
        }
        const run = await this.getRun(ownerId, runId);
        return run ? { replayed: transition.replayed, run } : null;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error("Gate decision event contention exceeded its limit.");
  }

  private async completeConditionNode(
    ownerId: string,
    detail: WorkflowRunDetail,
    node: WorkflowRunNode,
    requireMatch: boolean,
  ): Promise<boolean> {
    const structuredInput = workflowJsonValueSchema.parse(node.structuredInput);
    for (let retry = 0; retry < 20; retry += 1) {
      try {
        const transition = await this.database.transaction(
          async (transaction) => {
            const outgoing = await transaction
              .select({
                dependency: schema.workflowRunNodeDependencies,
                position: schema.workflowRevisionEdges.position,
              })
              .from(schema.workflowRunNodeDependencies)
              .leftJoin(
                schema.workflowRevisionEdges,
                eq(
                  schema.workflowRevisionEdges.id,
                  schema.workflowRunNodeDependencies.revisionEdgeId,
                ),
              )
              .where(
                and(
                  eq(schema.workflowRunNodeDependencies.runId, detail.run.id),
                  eq(schema.workflowRunNodeDependencies.fromNodeId, node.id),
                  eq(schema.workflowRunNodeDependencies.status, "blocked"),
                ),
              )
              .orderBy(
                asc(schema.workflowRevisionEdges.position),
                asc(schema.workflowRunNodeDependencies.createdAt),
              );
            const matching = outgoing.find(({ dependency }) => {
              const mapping = workflowJsonObjectSchema.parse(
                dependency.resultMapping,
              );
              return mapping.condition
                ? evaluateWorkflowPredicate(
                    structuredInput,
                    workflowPredicateSchema.parse(mapping.condition),
                  )
                : false;
            });
            const fallback = outgoing.find(({ dependency }) => {
              const mapping = workflowJsonObjectSchema.parse(
                dependency.resultMapping,
              );
              return mapping.condition === null;
            });
            const selected = matching ?? fallback ?? null;
            const now = new Date();
            if (!selected && requireMatch) {
              const nodes = await transaction
                .update(schema.workflowRunNodes)
                .set({
                  status: "failed",
                  structuredResult: structuredInput,
                  completedAt: now,
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(schema.workflowRunNodes.id, node.id),
                    eq(schema.workflowRunNodes.status, "ready"),
                  ),
                )
                .returning({ id: schema.workflowRunNodes.id });
              if (!nodes[0]) {
                return { advanced: false, terminalizedRun: false };
              }
              const lockedRun = await lockWorkflowRun(
                transaction,
                ownerId,
                detail.run.id,
              );
              if (
                !lockedRun ||
                !["queued", "running", "waiting"].includes(lockedRun.status)
              ) {
                throw new Error(
                  "The workflow run changed state during its condition transition.",
                );
              }
              await transaction
                .update(schema.workflowRunNodes)
                .set({ status: "skipped", completedAt: now, updatedAt: now })
                .where(
                  and(
                    eq(schema.workflowRunNodes.runId, detail.run.id),
                    inArray(schema.workflowRunNodes.status, [
                      "blocked",
                      "ready",
                    ]),
                  ),
                );
              await transaction
                .update(schema.workflowRunNodeDependencies)
                .set({ status: "failed" })
                .where(
                  and(
                    eq(schema.workflowRunNodeDependencies.runId, detail.run.id),
                    eq(schema.workflowRunNodeDependencies.status, "blocked"),
                  ),
                );
              await transaction
                .update(schema.workflowRuns)
                .set({
                  status: "failed",
                  errorCode: "condition-no-match",
                  errorMessage:
                    "No condition branch matched and the node requires a match.",
                  pauseReason: null,
                  pausedAt: null,
                  completedAt: now,
                  updatedAt: now,
                })
                .where(eq(schema.workflowRuns.id, detail.run.id));
              await insertWorkflowRunEvent(transaction, {
                runId: detail.run.id,
                runNodeId: node.id,
                attemptId: null,
                eventKey: `condition-failed:${node.id}`,
                type: "node.condition.failed",
                payload: {
                  code: "condition-no-match",
                  requireMatch,
                },
                actorType: "server",
                actorId: null,
              });
              return { advanced: true, terminalizedRun: true };
            }
            const nodes = await transaction
              .update(schema.workflowRunNodes)
              .set({
                status: "completed",
                structuredResult: structuredInput,
                completedAt: now,
                updatedAt: now,
              })
              .where(
                and(
                  eq(schema.workflowRunNodes.id, node.id),
                  eq(schema.workflowRunNodes.status, "ready"),
                ),
              )
              .returning({ id: schema.workflowRunNodes.id });
            if (!nodes[0]) {
              return { advanced: false, terminalizedRun: false };
            }
            const lockedRun = await lockWorkflowRun(
              transaction,
              ownerId,
              detail.run.id,
            );
            if (
              !lockedRun ||
              !["queued", "running", "waiting"].includes(lockedRun.status)
            ) {
              throw new Error(
                "The workflow run changed state during its condition transition.",
              );
            }
            const dependencyTransition = await settleWorkflowDependencies(
              transaction,
              {
                now,
                runId: detail.run.id,
                selectedDependencyIds: new Set(
                  selected ? [selected.dependency.id] : [],
                ),
                sourceNodeId: node.id,
              },
            );
            const runTransition = await recomputeWorkflowRun(transaction, {
              codexThreadId: null,
              lockedRun,
              now,
            });
            await insertWorkflowRunEvent(transaction, {
              runId: detail.run.id,
              runNodeId: node.id,
              attemptId: null,
              eventKey: `condition-completed:${node.id}`,
              type: "node.condition.completed",
              payload: {
                requireMatch,
                selectedDependencyId: selected?.dependency.id ?? null,
                selectedTargetNodeId: selected?.dependency.toNodeId ?? null,
                readyNodeIds: dependencyTransition.readyNodeIds,
                skippedNodeIds: dependencyTransition.skippedNodeIds,
                runStatus: runTransition.updated ? runTransition.status : null,
              },
              actorType: "server",
              actorId: null,
            });
            return { advanced: true, terminalizedRun: false };
          },
        );
        if (transition.terminalizedRun) {
          await this.database.transaction((transaction) =>
            cancelPendingWorkflowGates(transaction, {
              now: new Date(),
              runId: detail.run.id,
            }),
          );
        }
        return transition.advanced;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error(
      "Condition transition event contention exceeded its limit.",
    );
  }

  private async openGateNode(
    ownerId: string,
    detail: WorkflowRunDetail,
    node: WorkflowRunNode,
    configuration: WorkflowGateNodeConfiguration,
  ): Promise<boolean> {
    const gateId = randomUUID();
    const now = new Date();
    const expiresAt = configuration.expiresAfterMs
      ? new Date(now.getTime() + configuration.expiresAfterMs)
      : null;
    for (let retry = 0; retry < 20; retry += 1) {
      try {
        return await this.database.transaction(async (transaction) => {
          const nodes = await transaction
            .update(schema.workflowRunNodes)
            .set({
              status: "waiting-for-approval",
              waitingAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.workflowRunNodes.id, node.id),
                eq(schema.workflowRunNodes.status, "ready"),
              ),
            )
            .returning({ id: schema.workflowRunNodes.id });
          if (!nodes[0]) return false;
          const lockedRun = await lockWorkflowRun(
            transaction,
            ownerId,
            detail.run.id,
          );
          if (
            !lockedRun ||
            !["queued", "running", "waiting"].includes(lockedRun.status)
          ) {
            throw new Error(
              "The workflow run changed state while opening an approval gate.",
            );
          }
          await transaction.insert(schema.workflowApprovalGates).values({
            id: gateId,
            runId: detail.run.id,
            runNodeId: node.id,
            gateKey: node.nodeKey,
            status: "pending",
            prompt: configuration.prompt,
            permissionManifest: node.permissionManifest,
            requestedByType: "workflow",
            requestedById: node.id,
            expiresAt,
            createdAt: now,
            updatedAt: now,
          });
          const activeNodes = await transaction
            .select({ status: schema.workflowRunNodes.status })
            .from(schema.workflowRunNodes)
            .where(eq(schema.workflowRunNodes.runId, detail.run.id));
          const runStatus = activeNodes.some(
            ({ status }) => status === "running",
          )
            ? "running"
            : "waiting";
          await transaction
            .update(schema.workflowRuns)
            .set({
              status: runStatus,
              pauseReason: configuration.prompt,
              pausedAt: runStatus === "waiting" ? now : null,
              startedAt: lockedRun.startedAt ?? now,
              updatedAt: now,
            })
            .where(eq(schema.workflowRuns.id, detail.run.id));
          await insertWorkflowRunEvent(transaction, {
            runId: detail.run.id,
            runNodeId: node.id,
            attemptId: null,
            eventKey: `gate-requested:${gateId}`,
            type: "node.gate.requested",
            payload: {
              gateId,
              gateKey: node.nodeKey,
              prompt: configuration.prompt,
              expiresAt: expiresAt?.toISOString() ?? null,
              denialPolicy: configuration.denialPolicy,
            },
            actorType: "server",
            actorId: null,
          });
          return true;
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error("Gate transition event contention exceeded its limit.");
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
