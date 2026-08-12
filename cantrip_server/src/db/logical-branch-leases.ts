import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import * as schema from "./schema.js";
import type { WorkflowRunTransaction } from "./workflow-run-transitions.js";

export class LogicalBranchLeaseConflictError extends Error {}

function isUniqueViolation(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (typeof current === "object") {
      const value = current as {
        code?: unknown;
        cause?: unknown;
        constraint?: unknown;
        message?: unknown;
      };
      if (
        value.code === "23505" ||
        value.constraint === "project_branch_leases_active_branch_unique" ||
        (typeof value.message === "string" &&
          /project_branch_leases_active_branch_unique|duplicate key/iu.test(
            value.message,
          ))
      ) {
        return true;
      }
      current = value.cause;
      continue;
    }
    break;
  }
  return false;
}

function conflict(branchName: string): LogicalBranchLeaseConflictError {
  return new LogicalBranchLeaseConflictError(
    `Logical branch ${branchName} is already leased by another agent in this project.`,
  );
}

export async function acquireChatLogicalBranchLease(
  transaction: WorkflowRunTransaction,
  input: {
    branchName: string | null;
    chatId: string;
    detached: boolean;
    laneId: string;
    projectId: string;
    workerId: string;
    worktreeId: string;
  },
): Promise<void> {
  if (!input.branchName) {
    if (input.detached) return;
    const replicas = await transaction
      .select({ id: schema.projectSources.id })
      .from(schema.projectSources)
      .where(
        and(
          eq(schema.projectSources.projectId, input.projectId),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .limit(2);
    if (replicas.length > 1) {
      throw new LogicalBranchLeaseConflictError(
        "The selected replica has not reported its current branch, so Cantrip cannot safely coordinate this turn across workers yet.",
      );
    }
    return;
  }
  const now = new Date();
  const existing = await transaction
    .select()
    .from(schema.projectBranchLeases)
    .where(eq(schema.projectBranchLeases.chatExecutionLaneId, input.laneId))
    .limit(1);
  if (existing[0]) {
    if (
      existing[0].projectId !== input.projectId ||
      existing[0].branchName !== input.branchName
    ) {
      throw conflict(input.branchName);
    }
    if (existing[0].state === "active") return;
  }

  const sameBranchChatLeases = await transaction
    .select({
      id: schema.projectBranchLeases.id,
      chatId: schema.chatExecutionLanes.chatId,
    })
    .from(schema.projectBranchLeases)
    .leftJoin(
      schema.chatExecutionLanes,
      eq(
        schema.chatExecutionLanes.id,
        schema.projectBranchLeases.chatExecutionLaneId,
      ),
    )
    .where(
      and(
        eq(schema.projectBranchLeases.projectId, input.projectId),
        eq(schema.projectBranchLeases.branchName, input.branchName),
        eq(schema.projectBranchLeases.state, "active"),
      ),
    )
    .limit(1);
  const holder = sameBranchChatLeases[0];
  if (holder && holder.chatId !== input.chatId)
    throw conflict(input.branchName);
  if (holder) {
    await transaction
      .update(schema.projectBranchLeases)
      .set({ state: "released", releasedAt: now, updatedAt: now })
      .where(eq(schema.projectBranchLeases.id, holder.id));
  }

  try {
    if (existing[0]) {
      await transaction
        .update(schema.projectBranchLeases)
        .set({
          state: "active",
          workerId: input.workerId,
          worktreeId: input.worktreeId,
          releasedAt: null,
          updatedAt: now,
        })
        .where(eq(schema.projectBranchLeases.id, existing[0].id));
      return;
    }
    await transaction.insert(schema.projectBranchLeases).values({
      id: randomUUID(),
      projectId: input.projectId,
      branchName: input.branchName,
      chatExecutionLaneId: input.laneId,
      worktreeId: input.worktreeId,
      workerId: input.workerId,
      state: "active",
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(input.branchName);
    throw error;
  }
}

export async function acquireWorkflowLogicalBranchLease(
  transaction: WorkflowRunTransaction,
  input: {
    branchName: string;
    leaseId: string;
    projectId: string;
    workerId: string;
    worktreeId: string | null;
  },
): Promise<void> {
  const now = new Date();
  const existing = await transaction
    .select()
    .from(schema.projectBranchLeases)
    .where(
      eq(schema.projectBranchLeases.workflowWorktreeLeaseId, input.leaseId),
    )
    .limit(1);
  if (existing[0]) {
    if (
      existing[0].projectId !== input.projectId ||
      existing[0].branchName !== input.branchName
    ) {
      throw conflict(input.branchName);
    }
    if (existing[0].state === "active") {
      await transaction
        .update(schema.projectBranchLeases)
        .set({
          workerId: input.workerId,
          worktreeId: input.worktreeId,
          updatedAt: now,
        })
        .where(eq(schema.projectBranchLeases.id, existing[0].id));
      return;
    }
  }
  try {
    if (existing[0]) {
      await transaction
        .update(schema.projectBranchLeases)
        .set({
          state: "active",
          workerId: input.workerId,
          worktreeId: input.worktreeId,
          releasedAt: null,
          updatedAt: now,
        })
        .where(eq(schema.projectBranchLeases.id, existing[0].id));
      return;
    }
    await transaction.insert(schema.projectBranchLeases).values({
      id: randomUUID(),
      projectId: input.projectId,
      branchName: input.branchName,
      workflowWorktreeLeaseId: input.leaseId,
      worktreeId: input.worktreeId,
      workerId: input.workerId,
      state: "active",
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(input.branchName);
    throw error;
  }
}

export async function releaseChatLogicalBranchLease(
  transaction: WorkflowRunTransaction,
  laneId: string,
): Promise<void> {
  const now = new Date();
  await transaction
    .update(schema.projectBranchLeases)
    .set({ state: "released", releasedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.projectBranchLeases.chatExecutionLaneId, laneId),
        eq(schema.projectBranchLeases.state, "active"),
      ),
    );
}

export async function releaseWorkflowLogicalBranchLease(
  transaction: WorkflowRunTransaction,
  leaseId: string,
): Promise<void> {
  const now = new Date();
  await transaction
    .update(schema.projectBranchLeases)
    .set({ state: "released", releasedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.projectBranchLeases.workflowWorktreeLeaseId, leaseId),
        eq(schema.projectBranchLeases.state, "active"),
      ),
    );
}
