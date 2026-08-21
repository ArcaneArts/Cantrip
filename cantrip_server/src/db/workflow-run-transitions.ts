import {
  workflowJsonObjectSchema,
  workflowJsonValueSchema,
  workflowMeasuredUsageSchema,
  type WorkflowJsonValue,
  type WorkflowMeasuredUsage,
  type WorkflowRunStatus,
} from "@cantrip/protocol/workflows";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";
import { workflowValueAtPointer } from "../workflows/values.js";

type WorkflowRunDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
export type WorkflowRunTransaction = Parameters<
  Parameters<WorkflowRunDatabase["transaction"]>[0]
>[0];

export interface WorkflowDependencyTransitionResult {
  readyNodeIds: string[];
  skippedNodeIds: string[];
}

export interface WorkflowRunTransitionResult {
  status: WorkflowRunStatus;
  updated: boolean;
}

export async function cancelPendingWorkflowGates(
  transaction: WorkflowRunTransaction,
  input: { now: Date; runId: string },
): Promise<string[]> {
  const nodes = await transaction
    .update(schema.workflowRunNodes)
    .set({
      status: "cancelled",
      executionLeaseKey: null,
      timeoutAt: null,
      waitingAt: null,
      completedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(schema.workflowRunNodes.runId, input.runId),
        eq(schema.workflowRunNodes.nodeType, "gate"),
        eq(schema.workflowRunNodes.status, "waiting-for-approval"),
      ),
    )
    .returning({ id: schema.workflowRunNodes.id });
  if (nodes.length > 0) {
    await transaction
      .update(schema.workflowNodeAttempts)
      .set({
        status: "cancelled",
        heartbeatAt: input.now,
        completedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          inArray(
            schema.workflowNodeAttempts.runNodeId,
            nodes.map(({ id }) => id),
          ),
          eq(schema.workflowNodeAttempts.status, "waiting-for-approval"),
        ),
      );
  }
  await transaction
    .update(schema.workflowApprovalGates)
    .set({ status: "cancelled", updatedAt: input.now })
    .where(
      and(
        eq(schema.workflowApprovalGates.runId, input.runId),
        eq(schema.workflowApprovalGates.status, "pending"),
      ),
    );
  return nodes.map(({ id }) => id);
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

export function aggregateWorkflowUsage(
  values: unknown[],
): WorkflowMeasuredUsage {
  const usages = values.map((value) =>
    workflowMeasuredUsageSchema.parse(value),
  );
  const costBearingUsages = usages.filter(
    (usage) =>
      usage.costAvailable ||
      usage.estimatedCostUsd !== null ||
      usage.inputTokens > 0 ||
      usage.outputTokens > 0 ||
      usage.cachedInputTokens > 0 ||
      usage.totalTokens > 0 ||
      usage.durationMs > 0,
  );
  const costAvailable =
    costBearingUsages.length > 0 &&
    costBearingUsages.every(
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

export async function lockWorkflowRun(
  transaction: WorkflowRunTransaction,
  ownerId: string,
  runId: string,
) {
  const rows = await transaction
    .select()
    .from(schema.workflowRuns)
    .where(
      and(
        eq(schema.workflowRuns.id, runId),
        eq(schema.workflowRuns.ownerId, ownerId),
      ),
    )
    .for("update")
    .limit(1);
  return rows[0] ?? null;
}

export async function insertWorkflowRunEvent(
  transaction: WorkflowRunTransaction,
  input: {
    actorId: string | null;
    actorType: string;
    attemptId: string | null;
    eventKey: string;
    payload: unknown;
    runId: string;
    runNodeId: string | null;
    type: string;
  },
): Promise<void> {
  const existing = await transaction
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
  const latest = await transaction
    .select({ sequence: schema.workflowRunEvents.sequence })
    .from(schema.workflowRunEvents)
    .where(eq(schema.workflowRunEvents.runId, input.runId))
    .orderBy(asc(schema.workflowRunEvents.sequence))
    .for("update");
  await transaction.insert(schema.workflowRunEvents).values({
    runId: input.runId,
    runNodeId: input.runNodeId,
    attemptId: input.attemptId,
    sequence: (latest.at(-1)?.sequence ?? -1) + 1,
    eventKey: input.eventKey.slice(0, 500),
    type: input.type.slice(0, 200),
    payload: jsonObject(input.payload),
    actorType: input.actorType.slice(0, 100),
    actorId: input.actorId?.slice(0, 500) ?? null,
  });
}

export async function settleWorkflowDependencies(
  transaction: WorkflowRunTransaction,
  input: {
    now: Date;
    runId: string;
    selectedDependencyIds: ReadonlySet<string> | null;
    sourceNodeId: string;
  },
): Promise<WorkflowDependencyTransitionResult> {
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
        eq(schema.workflowRunNodeDependencies.runId, input.runId),
        eq(schema.workflowRunNodeDependencies.fromNodeId, input.sourceNodeId),
        eq(schema.workflowRunNodeDependencies.status, "blocked"),
      ),
    )
    .orderBy(
      asc(schema.workflowRevisionEdges.position),
      asc(schema.workflowRunNodeDependencies.createdAt),
    );
  const selected = outgoing
    .filter(
      ({ dependency }) =>
        input.selectedDependencyIds === null ||
        input.selectedDependencyIds.has(dependency.id),
    )
    .map(({ dependency }) => dependency.id);
  const skipped = outgoing
    .filter(
      ({ dependency }) =>
        input.selectedDependencyIds !== null &&
        !input.selectedDependencyIds.has(dependency.id),
    )
    .map(({ dependency }) => dependency.id);
  if (selected.length > 0) {
    await transaction
      .update(schema.workflowRunNodeDependencies)
      .set({ status: "satisfied", satisfiedAt: input.now })
      .where(inArray(schema.workflowRunNodeDependencies.id, selected));
  }
  if (skipped.length > 0) {
    await transaction
      .update(schema.workflowRunNodeDependencies)
      .set({ status: "skipped", satisfiedAt: null })
      .where(inArray(schema.workflowRunNodeDependencies.id, skipped));
  }

  const readyNodeIds: string[] = [];
  const skippedNodeIds: string[] = [];
  const queued = [
    ...new Set(outgoing.map(({ dependency }) => dependency.toNodeId)),
  ].sort();
  const visited = new Set<string>();
  while (queued.length > 0) {
    const targetNodeId = queued.shift()!;
    if (visited.has(targetNodeId)) continue;
    visited.add(targetNodeId);
    const targetRows = await transaction
      .select({ status: schema.workflowRunNodes.status })
      .from(schema.workflowRunNodes)
      .where(
        and(
          eq(schema.workflowRunNodes.id, targetNodeId),
          eq(schema.workflowRunNodes.runId, input.runId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !targetRows[0] ||
      !["blocked", "ready"].includes(targetRows[0].status)
    ) {
      continue;
    }
    const incoming = await transaction
      .select({
        dependency: schema.workflowRunNodeDependencies,
        position: schema.workflowRevisionEdges.position,
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
      .leftJoin(
        schema.workflowRevisionEdges,
        eq(
          schema.workflowRevisionEdges.id,
          schema.workflowRunNodeDependencies.revisionEdgeId,
        ),
      )
      .where(
        and(
          eq(schema.workflowRunNodeDependencies.runId, input.runId),
          eq(schema.workflowRunNodeDependencies.toNodeId, targetNodeId),
        ),
      )
      .orderBy(
        asc(schema.workflowRevisionEdges.position),
        asc(schema.workflowRunNodeDependencies.createdAt),
      );
    const impossible = incoming.some(({ dependency }) =>
      ["failed", "skipped"].includes(dependency.status),
    );
    if (impossible) {
      const targets = await transaction
        .update(schema.workflowRunNodes)
        .set({
          status: "skipped",
          dependencyState: {
            remaining: incoming.filter(
              ({ dependency }) => dependency.status === "blocked",
            ).length,
            satisfied: incoming.filter(
              ({ dependency }) => dependency.status === "satisfied",
            ).length,
          },
          completedAt: input.now,
          readyAt: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(schema.workflowRunNodes.id, targetNodeId),
            inArray(schema.workflowRunNodes.status, ["blocked", "ready"]),
          ),
        )
        .returning({ id: schema.workflowRunNodes.id });
      if (!targets[0]) continue;
      skippedNodeIds.push(targetNodeId);
      const cascaded = await transaction
        .update(schema.workflowRunNodeDependencies)
        .set({ status: "skipped", satisfiedAt: null })
        .where(
          and(
            eq(schema.workflowRunNodeDependencies.runId, input.runId),
            eq(schema.workflowRunNodeDependencies.fromNodeId, targetNodeId),
            eq(schema.workflowRunNodeDependencies.status, "blocked"),
          ),
        )
        .returning({
          targetNodeId: schema.workflowRunNodeDependencies.toNodeId,
        });
      queued.push(...new Set(cascaded.map(({ targetNodeId: id }) => id)));
      queued.sort();
      continue;
    }
    if (
      incoming.length === 0 ||
      incoming.some(({ dependency }) => dependency.status !== "satisfied")
    ) {
      await transaction
        .update(schema.workflowRunNodes)
        .set({
          dependencyState: {
            remaining: incoming.filter(
              ({ dependency }) => dependency.status !== "satisfied",
            ).length,
            satisfied: incoming.filter(
              ({ dependency }) => dependency.status === "satisfied",
            ).length,
          },
          updatedAt: input.now,
        })
        .where(eq(schema.workflowRunNodes.id, targetNodeId));
      continue;
    }

    const mapped = incoming.map(({ dependency, source }) => {
      const mapping = workflowJsonObjectSchema.parse(dependency.resultMapping);
      const sourceOutput =
        typeof mapping.sourceOutput === "string" ? mapping.sourceOutput : null;
      const targetInput =
        typeof mapping.targetInput === "string" ? mapping.targetInput : null;
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
        dependencyState: { remaining: 0, satisfied: incoming.length },
        structuredInput,
        readyAt: input.now,
        updatedAt: input.now,
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
  return { readyNodeIds, skippedNodeIds };
}

export async function recomputeWorkflowRun(
  transaction: WorkflowRunTransaction,
  input: {
    codexThreadId: string | null;
    lockedRun: typeof schema.workflowRuns.$inferSelect;
    now: Date;
  },
): Promise<WorkflowRunTransitionResult> {
  const [nodes, dependencies] = await Promise.all([
    transaction
      .select()
      .from(schema.workflowRunNodes)
      .where(eq(schema.workflowRunNodes.runId, input.lockedRun.id)),
    transaction
      .select()
      .from(schema.workflowRunNodeDependencies)
      .where(eq(schema.workflowRunNodeDependencies.runId, input.lockedRun.id)),
  ]);
  const allCompleted = nodes.every(({ status }) =>
    ["completed", "skipped"].includes(status),
  );
  const computedStatus: WorkflowRunStatus = allCompleted
    ? "completed"
    : nodes.some(({ status: nodeStatus }) => nodeStatus === "failed")
      ? "failed"
      : nodes.some(({ status: nodeStatus }) => nodeStatus === "running")
        ? "running"
        : nodes.some(
              ({ status: nodeStatus }) => nodeStatus === "waiting-for-approval",
            )
          ? "waiting"
          : nodes.some(({ status: nodeStatus }) => nodeStatus === "ready")
            ? "queued"
            : nodes.some(({ status: nodeStatus }) => nodeStatus === "paused")
              ? "paused"
              : nodes.some(
                    ({ status: nodeStatus }) => nodeStatus === "recovering",
                  )
                ? "recovering"
                : "failed";
  const status: WorkflowRunStatus =
    input.lockedRun.status === "paused" &&
    ["queued", "running", "waiting", "paused"].includes(computedStatus)
      ? "paused"
      : computedStatus;
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
  const terminal = status === "completed" || status === "failed";
  const deadlocked = status === "failed";
  const pendingGate =
    status === "waiting"
      ? (
          await transaction
            .select({ id: schema.workflowApprovalGates.id })
            .from(schema.workflowApprovalGates)
            .where(
              and(
                eq(schema.workflowApprovalGates.runId, input.lockedRun.id),
                eq(schema.workflowApprovalGates.status, "pending"),
              ),
            )
            .orderBy(asc(schema.workflowApprovalGates.createdAt))
            .limit(1)
        )[0]
      : null;
  const runs = await transaction
    .update(schema.workflowRuns)
    .set({
      status,
      structuredResult,
      measuredUsage: aggregateWorkflowUsage(
        nodes.map(({ measuredUsage }) => measuredUsage),
      ),
      codexThreadId: nodes.length === 1 ? input.codexThreadId : null,
      errorCode: deadlocked ? "workflow-deadlock" : null,
      errorMessage: deadlocked
        ? "No workflow node can make durable progress."
        : null,
      pauseReason:
        status === "paused"
          ? input.lockedRun.pauseReason
          : status === "waiting"
            ? pendingGate
              ? "Waiting for a protected workflow gate decision."
              : input.lockedRun.pauseReason
            : null,
      pausedAt:
        status === "paused" || status === "waiting"
          ? (input.lockedRun.pausedAt ?? input.now)
          : null,
      recoveryState: "stable",
      completedAt: terminal ? input.now : null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(schema.workflowRuns.id, input.lockedRun.id),
        eq(schema.workflowRuns.ownerId, input.lockedRun.ownerId),
        inArray(schema.workflowRuns.status, [
          "queued",
          "running",
          "waiting",
          "paused",
        ]),
      ),
    )
    .returning({ id: schema.workflowRuns.id });
  return { status, updated: Boolean(runs[0]) };
}
