import { worktreeInventorySchema } from "@cantrip/protocol";
import type {
  ChatExecutionContext,
  ServerRepository,
} from "../../db/repository.js";
import { ExecutionLaneConflictError } from "../../db/repository.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";

/** A completed worktree cleanup must not strand the Task's conversation. */
export async function reconcileTaskTurnPlacement(
  repository: ServerRepository,
  bridge: LimitedWorkerCommandBus,
  ownerId: string,
  context: ChatExecutionContext,
): Promise<ChatExecutionContext> {
  if (
    context.contextKind !== "project" ||
    context.experience !== "task" ||
    context.rootKind !== "git-worktree" ||
    context.status === "running" ||
    context.status === "waiting-for-approval"
  )
    return context;
  const worktrees = await repository.listProjectWorktrees(
    ownerId,
    context.projectId,
  );
  const selected = worktrees.find(({ id }) => id === context.worktreeId);
  if (!selected || selected.lifecycleState === "ready") return context;
  // Refresh real worker truth, rather than turning a cached lifecycle flag
  // into a permanent execution preflight failure.
  const source = worktrees.find(
    (item) =>
      item.isPrimary &&
      item.projectSourceId === selected.projectSourceId &&
      item.workerId === context.workerId,
  );
  if (!source || !bridge.isConnected(context.workerId)) return context;
  const inventory = worktreeInventorySchema.parse(
    await bridge.request(context.workerId, {
      type: "worktree.reconcile",
      sourcePath: source.path,
    }),
  );
  const reconciled = await repository.reconcileProjectWorktrees(
    ownerId,
    context.projectId,
    context.workerId,
    inventory,
  );
  const observed = reconciled?.find(({ id }) => id === context.worktreeId);
  if (observed?.lifecycleState === "ready") return context;
  // Only an agent-managed, actually missing checkout may return to its own
  // source's Primary. Never relocate pinned chats or a creating/error target.
  if (
    context.worktreeMode !== "agent-managed" ||
    selected.isPrimary ||
    !["missing", "prunable"].includes(selected.lifecycleState) ||
    !observed ||
    !["missing", "prunable"].includes(observed.lifecycleState)
  )
    return context;
  const primary = reconciled?.find(
    (item) =>
      item.isPrimary &&
      item.projectSourceId === selected.projectSourceId &&
      item.workerId === context.workerId &&
      item.lifecycleState === "ready",
  );
  if (!primary) return context;
  await repository.updateChatWorktree(
    ownerId,
    context.chatId,
    {
      worktreeId: primary.id,
      mode: "agent-managed",
    },
    context.worktreeId,
  );
  const latest = await repository.getChatExecutionContext(
    ownerId,
    context.chatId,
  );
  if (
    !latest ||
    latest.worktreeId !== primary.id ||
    latest.workerId !== context.workerId
  )
    throw new ExecutionLaneConflictError(
      "The Task placement changed while preparing your follow-up. Please retry.",
    );
  return latest;
}
