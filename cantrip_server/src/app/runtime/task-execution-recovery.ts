import type {
  ChatExecutionContext,
  ServerRepository,
} from "../../db/repository.js";
import type { createTaskGoalRuntime } from "./task-goal-runtime.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";

type Goals = ReturnType<typeof createTaskGoalRuntime>;
interface Dependencies {
  repository: ServerRepository;
  bridge: LimitedWorkerCommandBus;
  ownerId(): string;
  leaseOwner: string;
  goals: Pick<
    Goals,
    | "readEncryptedTaskGoal"
    | "continueTaskGoalInWorktree"
    | "retainTaskGoalLease"
    | "reconcileTaskGoalDispatch"
    | "resumeChatAutomation"
  >;
  publish(chatId: string, projectId: string): void;
  unpause(ownerId: string, chatId: string): Promise<unknown>;
  reportFailure?(chatId: string, error: unknown): void;
}

/** Reattach to native truth, not a cached failed chat flag or a fresh Goal. */
export function createTaskExecutionRecovery({
  repository,
  bridge,
  ownerId,
  leaseOwner,
  goals,
  publish,
  unpause,
  reportFailure,
}: Dependencies) {
  const recovering = new Map<
    string,
    { operation: Promise<boolean>; resume: boolean }
  >();
  const observedAt = new Map<string, number>();
  async function recover(chatId: string, resume = false): Promise<boolean> {
    const prior = recovering.get(chatId);
    if (prior) {
      const recovered = await prior.operation;
      // An explicit Resume must not be swallowed by a concurrent passive
      // observation which intentionally preserves the user's paused state.
      return resume && !prior.resume ? recover(chatId, true) : recovered;
    }
    const operation = run(chatId, resume);
    recovering.set(chatId, { operation, resume });
    try {
      return await operation;
    } finally {
      recovering.delete(chatId);
      observedAt.set(chatId, Date.now());
    }
  }

  async function run(chatId: string, resume: boolean) {
    const owner = ownerId();
    let context = await repository.getChatExecutionContext(owner, chatId);
    const task = await repository.tasks.get(owner, chatId);
    if (
      !context ||
      context.contextKind !== "project" ||
      context.experience !== "task" ||
      !task?.planGoalEnabled ||
      !task.implementationStartedAt
    )
      return false;
    if (task.state === "complete") {
      await goals.reconcileTaskGoalDispatch(task, "complete");
      return true;
    }
    if (!bridge.isConnected(context.workerId))
      throw new Error(
        "The project worker is offline. Reconnect it, then retry recovery.",
      );
    if (context.automationPaused && !resume) return true;
    const cycle = task.dispatch;
    if (
      !cycle ||
      cycle.operationKind !== "finalize" ||
      !cycle.codexThreadId ||
      !cycle.worktreeId ||
      ![
        "running",
        "expired",
        "failed",
        ...(resume ? ["succeeded"] : []),
      ].includes(cycle.state)
    )
      return false;
    // Healthy turns and their intentional worktree handoffs keep using the
    // existing continuation path. Recovery is for interrupted ownership.
    if (
      !resume &&
      context.status !== "offline" &&
      context.status !== "failed" &&
      cycle.state === "running" &&
      cycle.leaseOwner === leaseOwner
    )
      return false;
    // The dispatch keeps the original session affinity even if an old failed
    // worktree continuation changed the chat's active placement after restart.
    const affinity = await repository.getProjectWorktreeContext(
      owner,
      context.projectId,
      cycle.worktreeId,
    );
    if (
      !affinity ||
      affinity.workerId !== context.workerId ||
      cycle.physicalWorkerId !== context.workerId
    )
      throw new Error(
        "The retained Task session belongs to a different worker.",
      );
    let currentObservation:
      Awaited<ReturnType<Goals["readEncryptedTaskGoal"]>> | undefined;
    if (resume && context.threadId && goals.continueTaskGoalInWorktree) {
      currentObservation = await goals.readEncryptedTaskGoal(
        context,
        task,
        null,
        true,
      );
      if (
        !currentObservation.goal &&
        currentObservation.execution?.threadId === context.threadId &&
        currentObservation.execution.status === "idle"
      ) {
        const latest = await repository.getChatExecutionContext(owner, chatId);
        if (
          !latest ||
          latest.threadId !== context.threadId ||
          latest.worktreeId !== context.worktreeId ||
          latest.workerId !== context.workerId ||
          latest.automationPaused !== context.automationPaused
        )
          throw new Error("The Task changed during recovery. Please retry.");
        if (context.automationPaused) {
          await unpause(owner, chatId);
          const unpaused = await repository.getChatExecutionContext(
            owner,
            chatId,
          );
          if (
            !unpaused ||
            unpaused.threadId !== context.threadId ||
            unpaused.worktreeId !== context.worktreeId ||
            unpaused.workerId !== context.workerId ||
            unpaused.automationPaused
          )
            throw new Error("The Task changed during recovery. Please retry.");
          context = unpaused;
        }
        return goals.continueTaskGoalInWorktree(context, {
          text: "Resume the saved approved Task implementation Goal in this checkout. Preserve already-completed work and validate the remaining acceptance criteria.",
          idempotencyKey: `task-goal-repair:${chatId}:${Date.now()}`,
        });
      }
    }
    if (context.threadId && context.threadId !== cycle.codexThreadId)
      throw new Error(
        "The Task already has a different session. Recovery did not replace it.",
      );
    if (context.automationPaused && resume) {
      await unpause(owner, chatId);
      const unpaused = await repository.getChatExecutionContext(owner, chatId);
      if (
        !unpaused ||
        unpaused.contextKind !== "project" ||
        unpaused.workerId !== context.workerId ||
        unpaused.worktreeId !== context.worktreeId ||
        unpaused.threadId !== context.threadId ||
        unpaused.automationPaused
      )
        throw new Error("The Task changed during recovery. Please retry.");
      context = unpaused;
    }
    const observedContext: ChatExecutionContext = {
      ...context,
      worktreeId: cycle.worktreeId,
      cwd: affinity.worktree.path,
      threadId: cycle.codexThreadId,
      modelRouteId: cycle.modelRouteId,
      providerAccountId: cycle.providerAccountId,
      // Native execution observation supplies the actual chat status on worker.
    };
    const result =
      currentObservation && context.worktreeId === cycle.worktreeId
        ? currentObservation
        : await goals.readEncryptedTaskGoal(observedContext, task, null, true);
    if (
      !result.execution ||
      result.execution.threadId !== cycle.codexThreadId ||
      !result.goal ||
      result.goal.threadId !== cycle.codexThreadId
    )
      throw new Error(
        "The worker could not observe the retained Task session. No new agent was started.",
      );
    if (result.execution.status === "failed")
      throw new Error(
        "The native Task session reports a runtime error. Its history was preserved.",
      );
    // Re-read before changing placement: a concurrent user action must win.
    const current = await repository.getChatExecutionContext(owner, chatId);
    if (
      !current ||
      current.contextKind !== "project" ||
      current.workerId !== context.workerId ||
      current.worktreeId !== context.worktreeId ||
      current.threadId !== context.threadId ||
      current.automationPaused !== context.automationPaused
    )
      throw new Error("The Task changed during recovery. Please retry.");
    if (result.goal.status === "complete") {
      await goals.reconcileTaskGoalDispatch(task, "complete");
      await repository.setChatStatus(chatId, result.execution.status);
      publish(chatId, context.projectId!);
      return true;
    }
    const shouldResume =
      result.execution.status === "idle" &&
      (resume || result.goal.status === "active") &&
      context.status !== "running";
    const lease =
      cycle.state === "succeeded"
        ? await repository.taskDispatch.recoverStartedGoal(
            owner,
            cycle,
            leaseOwner,
            new Date(),
            { allowSettled: true },
          )
        : await repository.taskDispatch.recoverStartedGoal(
            owner,
            cycle,
            leaseOwner,
          );
    if (context.worktreeId !== cycle.worktreeId) {
      const restored = await repository.updateChatWorktree(
        owner,
        chatId,
        {
          worktreeId: cycle.worktreeId,
          mode: context.worktreeMode,
        },
        context.worktreeId,
      );
      if (!restored)
        throw new Error("The retained Task worktree is unavailable.");
      context = (await repository.getChatExecutionContext(owner, chatId))!;
    }
    // A native Goal has already continued on this session. Do not replay the
    // obsolete handoff which would detach it and start a second continuation.
    const pending = await repository.getPendingChatWorktreeTransition(
      owner,
      chatId,
    );
    if (pending)
      await repository.cancelChatWorktreeTransition(
        owner,
        chatId,
        pending.lane.id,
      );
    await goals.retainTaskGoalLease(lease);
    const synchronized = (await repository.tasks.get(owner, chatId))!;
    // Keep the slot until activation/turn admission; reconciling a stopped
    // Goal here would settle it again immediately before Resume.
    if (!shouldResume)
      await goals.reconcileTaskGoalDispatch(synchronized, synchronized.state);
    if (
      result.execution.status === "running" &&
      !context.executionLaneId &&
      context.status !== "running"
    ) {
      await repository.startChatExecutionLane(
        owner,
        chatId,
        "agent",
        "Recovered native Task Goal",
      );
    } else if (context.status !== "running") {
      await repository.setChatStatus(chatId, result.execution.status);
    }
    publish(chatId, context.projectId!);
    if (shouldResume) {
      // The pending handoff was already reconciled above. Do not re-enter the
      // handoff's in-progress guard and accidentally suppress this resume.
      await goals.resumeChatAutomation(chatId, resume, true);
    }
    return true;
  }

  async function reconcile(owner: string) {
    const cycles = await repository.taskDispatch.list(owner);
    for (const cycle of cycles) {
      if (
        cycle.operationKind !== "finalize" ||
        !["running", "expired", "failed"].includes(cycle.state) ||
        !cycle.codexThreadId ||
        Date.now() - (observedAt.get(cycle.chatId) ?? 0) < 30_000
      )
        continue;
      // A failed observation is not proof that native work has stopped. The
      // persisted lease still bounds ownership; explicit recovery can retry.
      await recover(cycle.chatId).catch((error) =>
        reportFailure?.(cycle.chatId, error),
      );
    }
  }
  return { recover, reconcile };
}
