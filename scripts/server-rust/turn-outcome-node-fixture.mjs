// Actual outcome, coordinator, Task recovery, Goal and turn services. Only
// worker/catalog I/O, account preparation and scheduler wakeup are controlled.
import { createChatRecoveryRuntime } from "../../cantrip_server/src/app/runtime/chat-recovery-runtime.ts";
import { createChatTurnOutcomeRuntime } from "../../cantrip_server/src/app/runtime/chat-turn-outcome-runtime.ts";
import { createTaskGoalRuntime } from "../../cantrip_server/src/app/runtime/task-goal-runtime.ts";
import { createTaskExecutionRecovery } from "../../cantrip_server/src/app/runtime/task-execution-recovery.ts";
import { createChatAutomationPauseRuntime } from "../../cantrip_server/src/app/runtime/chat-automation-pause-runtime.ts";
import {
  ChatTurnOutcomeRecoveryScheduler,
  chatTurnOutcomeRecoveryKey,
} from "../../cantrip_server/src/chats/turn-outcome-recovery.ts";
import { workerServerEnvelopeSchema } from "../../packages/protocol/dist/index.js";
export async function turnOutcomeFixture({
  repository,
  input,
  environment,
  routing,
  bridge,
  app,
  buildTurn,
  scope,
  trace,
  pending,
  commands,
  release,
  execute,
}) {
  const track = (promise) => {
    const settled = promise.then(
      () => {},
      () => {},
    );
    pending.add(settled);
    settled.then(() => pending.delete(settled));
    return promise;
  };
  const runAsOwner = (owner, run) =>
    scope.run(owner, () => track(Promise.resolve(run())));
  const timers = new ChatTurnOutcomeRecoveryScheduler();
  let coordinator;
  const { beginTurn } = buildTurn({
    cancelChatTurnOutcomeRecovery: (worker, chat, message) =>
      timers.settle(chatTurnOutcomeRecoveryKey(worker, chat, message)),
    continuePendingWorktreeTransition: (chat) =>
      track(coordinator.continuePendingWorktreeTransition(chat)),
    dispatchNextQueuedPrompt: (chat) =>
      track(coordinator.dispatchNextQueuedPrompt(chat)),
  });
  const tick = () => trace.push({ kind: "tick" });
  const goals = createTaskGoalRuntime({
    ...environment.runtime,
    ...routing,
    repository,
    bridge,
    app,
    applicationOwnerId: () => input.owner,
    beginTurn,
    resolvePromptAttachments: environment.recovery.resolvePromptAttachments,
    continuePendingWorktreeTransition: (chat) =>
      track(coordinator.continuePendingWorktreeTransition(chat)),
    dispatchNextQueuedPrompt: (chat) =>
      track(coordinator.dispatchNextQueuedPrompt(chat)),
    queueTaskScheduleTick: tick,
  });
  const setChatAutomationPause = createChatAutomationPauseRuntime(
    {
      repository,
      bridge,
      publishChatSummary: environment.runtime.publishChatSummary,
      resumeChatAutomation: goals.resumeChatAutomation,
    },
    app,
  );
  const taskRecovery = createTaskExecutionRecovery({
    repository,
    bridge,
    ownerId: () => input.owner,
    leaseOwner: "outcome-server:instance",
    goals,
    publish: (chat, projectId) => {
      environment.runtime.publishChatSummary(chat, projectId);
      environment.runtime.publishChatInvalidation(chat, "task", null, {
        experience: "task",
        projectId,
      });
    },
    unpause: (owner, chat) =>
      setChatAutomationPause(owner, chat, false, { resumeAutomation: false }),
    reportFailure: (chatId, err) =>
      app.log.warn(
        { chatId, err },
        "Could not observe a retained Task session for recovery",
      ),
  });
  const dependencies = {
    ...environment.runtime,
    ...routing,
    ...goals,
    repository,
    bridge,
    app,
    applicationOwnerId: () => input.owner,
    beginTurn,
    runAsOwner,
    queueTaskScheduleTick: tick,
    prepareQueuedAccount: async (context) => {
      trace.push({ kind: "prepare-account", owner: input.owner, context });
      if (input.failAccount)
        throw new Error("Controlled queued account failure");
      if (input.accountSql) {
        await execute(input.accountSql);
        return repository.getChatExecutionContext(input.owner, context.chatId);
      }
      return context;
    },
    recoverTaskExecution: taskRecovery.recover,
    reconcileTaskExecutions: taskRecovery.reconcile,
    continueTaskGoalInWorktree: goals.continueTaskGoalInWorktree,
  };
  coordinator = createChatRecoveryRuntime(dependencies);
  const recover = createChatTurnOutcomeRuntime({
    ...dependencies,
    continuePendingWorktreeTransition: (chat) =>
      track(coordinator.continuePendingWorktreeTransition(chat)),
    dispatchNextQueuedPrompt: (chat) =>
      track(coordinator.dispatchNextQueuedPrompt(chat)),
  });
  const drain = async () => {
    for (;;) {
      await Promise.allSettled([...pending]);
      await environment.settle();
      if (!pending.size && !environment.pending.size) break;
    }
  };
  const snapshots = [];
  try {
    for (const step of input.steps) {
      switch (step.kind) {
        case "recover":
        case "batch": {
          const owner = step.owner ?? input.owner;
          const operations = (step.notifications ?? [step.notification]).map(
            (notification) => {
              notification = workerServerEnvelopeSchema.parse({
                kind: "notification",
                notification,
              }).notification;
              return runAsOwner(owner, () =>
                recover(owner, step.worker ?? "alpha", notification),
              );
            },
          );
          if (!step.detached) {
            const results = await Promise.allSettled(operations);
            snapshots.push({
              recoveryErrors: results.map((r) =>
                r.status === "rejected" ? r.reason.message : null,
              ),
            });
          }
          break;
        }
        case "drain":
          await drain();
          break;
        case "release":
          release();
          break;
        case "wait-commands": {
          const deadline = Date.now() + 10000;
          while (
            commands.filter(
              (c) =>
                c.command.type === (step.command ?? "chat.message.protect"),
            ).length < step.count
          ) {
            if (Date.now() >= deadline)
              throw new Error("Outcome command observation timed out");
            await new Promise(setImmediate);
          }
          break;
        }
        case "sql":
          await execute(step.sql);
          break;
        case "snapshot": {
          const result = await execute(step.sql);
          snapshots.push(
            (Array.isArray(result) ? result : result.rows)[0]?.result ?? null,
          );
          break;
        }
        default:
          throw new Error("Outcome fixture step");
      }
    }
    return { snapshots };
  } finally {
    release();
    await drain();
    goals.close();
    timers.clear();
  }
}
