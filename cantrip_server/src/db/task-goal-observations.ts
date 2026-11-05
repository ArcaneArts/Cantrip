import type { TaskOpaqueSummary } from "@cantrip/protocol/tasks";
import { and, desc, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { ChatExecutionContext } from "./repository/chat-execution-lanes.js";
import { projectChatExecutionLock } from "./repository/chat-execution-lock.js";
import { TaskDispatchConflictError } from "./task-dispatch.js";
import * as schema from "./schema.js";

type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
interface Target {
  workerId: string;
  worktreeId: string;
  threadId: string;
  modelRouteId: string | null;
  providerAccountId: string | null;
}
/** Ephemeral read authority only. It cannot itself launch, lease, settle or admit work. */
export interface TaskGoalObservationFence {
  target: Target;
  fingerprint: string;
}
function stale(): never {
  throw new TaskDispatchConflictError(
    "The Task or its native session changed during Goal observation.",
    "stale-version",
  );
}

async function snapshot(
  tx: Database,
  owner: string,
  chatId: string,
  target: Target,
) {
  const [user] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, owner))
    .for("update")
    .limit(1);
  if (!user) stale();
  // Match the control writers' owner -> project -> Chat lock order. No lock
  // or transaction is held across the native RPC.
  await tx.execute(projectChatExecutionLock(owner, chatId));
  const [source] = await tx
    .select({
      chat: {
        id: schema.chats.id,
        projectId: schema.chats.projectId,
        experience: schema.chats.experience,
        placementRevision: schema.chats.placementRevision,
        managedInputRevision: schema.chats.managedInputRevision,
        automationPaused: schema.chats.automationPaused,
        status: schema.chats.status,
        activeWorkerId: schema.chats.activeWorkerId,
        activeWorktreeId: schema.chats.activeWorktreeId,
        activeWorktreeWorkerId: schema.projectWorktrees.workerId,
        activeWorktreePath: schema.projectWorktrees.path,
        archivedAt: schema.chats.archivedAt,
      },
      project: { taskSchedulingPaused: schema.projects.taskSchedulingPaused },
      taskRowVersion: schema.tasks.rowVersion,
    })
    .from(schema.chats)
    .innerJoin(
      schema.projects,
      and(
        eq(schema.projects.id, schema.chats.projectId),
        eq(schema.projects.ownerId, owner),
      ),
    )
    .innerJoin(
      schema.projectWorktrees,
      and(
        eq(schema.projectWorktrees.id, schema.chats.activeWorktreeId),
        eq(schema.projectWorktrees.projectId, schema.projects.id),
      ),
    )
    .innerJoin(schema.tasks, eq(schema.tasks.chatId, schema.chats.id))
    .where(eq(schema.chats.id, chatId))
    .for("update")
    .limit(1);
  if (!source || source.chat.archivedAt) stale();
  const [runtime] = await tx
    .select({
      id: schema.chatRuntimeSessions.id,
      threadId: schema.chatRuntimeSessions.codexThreadId,
      modelRouteId: schema.chatRuntimeSessions.modelRouteId,
      providerAccountId: schema.chatRuntimeSessions.providerAccountId,
    })
    .from(schema.chatRuntimeSessions)
    .where(
      and(
        eq(schema.chatRuntimeSessions.chatId, chatId),
        eq(schema.chatRuntimeSessions.workerId, target.workerId),
        eq(schema.chatRuntimeSessions.worktreeId, target.worktreeId),
      ),
    )
    .for("update")
    .limit(1);
  const [lane] = await tx
    .select({
      id: schema.chatExecutionLanes.id,
      activatedAt: schema.chatExecutionLanes.activatedAt,
      workerId: schema.chatExecutionLanes.workerId,
      worktreeId: schema.chatExecutionLanes.worktreeId,
      threadId: schema.chatExecutionLanes.codexThreadId,
    })
    .from(schema.chatExecutionLanes)
    .where(
      and(
        eq(schema.chatExecutionLanes.chatId, chatId),
        eq(schema.chatExecutionLanes.state, "active"),
      ),
    )
    .for("update")
    .limit(1);
  const [cycle] = await tx
    .select({
      id: schema.taskDispatchCycles.id,
      operationId: schema.taskDispatchCycles.operationId,
      state: schema.taskDispatchCycles.state,
      fencingToken: schema.taskDispatchCycles.fencingToken,
      leaseOwner: schema.taskDispatchCycles.leaseOwner,
      physicalWorkerId: schema.taskDispatchCycles.physicalWorkerId,
      worktreeId: schema.taskDispatchCycles.worktreeId,
      codexThreadId: schema.taskDispatchCycles.codexThreadId,
      modelRouteId: schema.taskDispatchCycles.modelRouteId,
      providerAccountId: schema.taskDispatchCycles.providerAccountId,
      goalInput: schema.taskDispatchCycles.goalInput,
    })
    .from(schema.taskDispatchCycles)
    .where(
      and(
        eq(schema.taskDispatchCycles.ownerId, owner),
        eq(schema.taskDispatchCycles.chatId, chatId),
      ),
    )
    .orderBy(
      desc(schema.taskDispatchCycles.createdAt),
      desc(schema.taskDispatchCycles.id),
    )
    .for("update")
    .limit(1);
  const dispatch = cycle
    ? {
        id: cycle.id,
        operationId: cycle.operationId,
        state: cycle.state,
        fencingToken: cycle.fencingToken,
        leaseOwner: cycle.leaseOwner,
        physicalWorkerId: cycle.physicalWorkerId,
        worktreeId: cycle.worktreeId,
        codexThreadId: cycle.codexThreadId,
        modelRouteId: cycle.modelRouteId,
        providerAccountId: cycle.providerAccountId,
      }
    : null;
  return {
    ...source,
    runtime: runtime ?? null,
    lane: lane ?? null,
    dispatch,
    goalInput: cycle?.goalInput
      ? {
          operationId: cycle.goalInput.receipt.operationId,
          deferred: cycle.goalInput.deferred,
          firstDispatchedOperationId:
            cycle.goalInput.firstDispatchedOperationId,
          failedBeforeDispatch: cycle.goalInput.failedBeforeDispatch ?? false,
          terminalObservedAt: cycle.goalInput.terminal?.observedAt ?? null,
          terminalProjectedAt: cycle.goalInput.terminal?.projectedAt ?? null,
        }
      : null,
  };
}
function dispatchIdentity(dispatch: TaskOpaqueSummary["dispatch"]) {
  return dispatch
    ? {
        id: dispatch.id,
        operationId: dispatch.operationId,
        state: dispatch.state,
        fencingToken: dispatch.fencingToken,
        leaseOwner: dispatch.leaseOwner,
        physicalWorkerId: dispatch.physicalWorkerId,
        worktreeId: dispatch.worktreeId,
        codexThreadId: dispatch.codexThreadId,
        modelRouteId: dispatch.modelRouteId,
        providerAccountId: dispatch.providerAccountId,
      }
    : null;
}

export class TaskGoalObservationRepository {
  constructor(private readonly database: Database) {}
  async capture(
    owner: string,
    context: ChatExecutionContext,
    task: TaskOpaqueSummary,
  ): Promise<TaskGoalObservationFence> {
    if (
      context.contextKind !== "project" ||
      context.experience !== "task" ||
      !context.threadId ||
      context.chatId !== task.chatId
    )
      stale();
    const target: Target = {
      workerId: context.workerId,
      worktreeId: context.worktreeId,
      threadId: context.threadId,
      modelRouteId: context.modelRouteId,
      providerAccountId: context.providerAccountId,
    };
    return this.database.transaction(async (tx) => {
      const s = await snapshot(tx, owner, context.chatId, target);
      const active =
        s.chat.activeWorktreeWorkerId === target.workerId &&
        s.chat.activeWorktreeId === target.worktreeId &&
        s.runtime?.threadId === target.threadId &&
        s.runtime.modelRouteId === target.modelRouteId &&
        s.runtime.providerAccountId === target.providerAccountId;
      // Retained-worktree recovery may intentionally observe its saved session
      // before restoring active placement. Its latest dispatch owns that affinity.
      const retained =
        s.dispatch?.physicalWorkerId === target.workerId &&
        s.dispatch.worktreeId === target.worktreeId &&
        s.dispatch.codexThreadId === target.threadId &&
        s.dispatch.modelRouteId === target.modelRouteId &&
        s.dispatch.providerAccountId === target.providerAccountId;
      if (
        (!active && !retained) ||
        s.taskRowVersion !== task.rowVersion ||
        s.chat.projectId !== context.projectId ||
        s.chat.experience !== "task" ||
        s.chat.automationPaused !== context.automationPaused ||
        s.chat.status !== context.status ||
        (s.lane?.id ?? null) !== context.executionLaneId ||
        (context.managedInputRevision !== undefined &&
          context.managedInputRevision !== s.chat.managedInputRevision) ||
        JSON.stringify(s.dispatch) !==
          JSON.stringify(dispatchIdentity(task.dispatch))
      )
        stale();
      return { target, fingerprint: JSON.stringify(s) };
    });
  }
  /** The projection transaction changed only the Task revision in this scope.
   * Carry that exact committed revision into a subsequent control CAS; do not
   * capture a newer scope and apply the old native observation to it. */
  afterProjection(
    fence: TaskGoalObservationFence,
    rowVersion: number,
  ): TaskGoalObservationFence {
    const snapshot = JSON.parse(fence.fingerprint);
    snapshot.taskRowVersion = rowVersion;
    return { ...fence, fingerprint: JSON.stringify(snapshot) };
  }
  async assertInTransaction(
    tx: Database,
    owner: string,
    chat: string,
    fence: TaskGoalObservationFence,
  ) {
    if (
      JSON.stringify(await snapshot(tx, owner, chat, fence.target)) !==
      fence.fingerprint
    )
      stale();
  }
  async validate(owner: string, chat: string, fence: TaskGoalObservationFence) {
    return this.database.transaction((tx) =>
      this.assertInTransaction(tx, owner, chat, fence),
    );
  }
}
