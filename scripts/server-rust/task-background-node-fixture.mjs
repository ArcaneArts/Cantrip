// Actual scheduler, retry, recovery, routing, launchers, Goal and SQL services.
// Worker/catalog I/O and worktree/queue continuation are controlled peers.
import { createTaskSchedulerRuntime } from "../../cantrip_server/src/app/runtime/task-scheduler-runtime.ts";
import { createTaskDispatchEligibilityRuntime } from "../../cantrip_server/src/app/runtime/task-dispatch-eligibility-runtime.ts";
import { createTaskGoalRuntime } from "../../cantrip_server/src/app/runtime/task-goal-runtime.ts";
import { createChatAutomationPauseRuntime } from "../../cantrip_server/src/app/runtime/chat-automation-pause-runtime.ts";
import { createTaskClaimedExecutionRuntime } from "../../cantrip_server/src/app/runtime/task-claimed-execution-runtime.ts";
import { createTaskResumedExecutionRuntime } from "../../cantrip_server/src/app/runtime/task-resumed-execution-runtime.ts";
import { createTaskExecutionRecovery } from "../../cantrip_server/src/app/runtime/task-execution-recovery.ts";
import { createTaskOperationQueue } from "../../cantrip_server/src/app/runtime/task-operation-queue.ts";
import { createTaskAutomaticRetry } from "../../cantrip_server/src/app/runtime/task-automatic-retry.ts";
import { generateAutomaticTitle } from "../../cantrip_server/src/chats/automatic-labeling.ts";
import { createProjectTaskPauseRuntime } from "../../cantrip_server/src/app/runtime/project-task-pause-runtime.ts";
export async function taskBackgroundFixture({
  repository,
  input,
  environment,
  routing,
  bridge,
  app,
  beginTurn,
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
  const runAsOwner = (owner, operation) => scope.run(owner, operation);
  let scheduler, timer;
  const wakeup = () => {
    trace.push({ kind: "tick" });
    scheduler.queueTaskScheduleTick();
  };
  const goals = createTaskGoalRuntime({
    ...environment.runtime,
    ...routing,
    repository,
    bridge,
    app,
    applicationOwnerId: () => input.owner,
    beginTurn,
    resolvePromptAttachments: environment.recovery.resolvePromptAttachments,
    continuePendingWorktreeTransition: async (chat) => {
      trace.push({ kind: "pending", chat });
      return input.pendingTransition === true;
    },
    dispatchNextQueuedPrompt: async (chat) => {
      trace.push({ kind: "queue", chat });
    },
    queueTaskScheduleTick: wakeup,
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
  const setProjectTasksPaused = createProjectTaskPauseRuntime({
    ...environment.runtime,
    ...goals,
    repository,
    setChatAutomationPause,
  });
  const recovery = createTaskExecutionRecovery({
    repository,
    bridge,
    ownerId: () => input.owner,
    leaseOwner: "background-server:instance",
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
  const launcher = createTaskClaimedExecutionRuntime(
    {
      ...environment.runtime,
      ...routing,
      ...goals,
      repository,
      bridge,
      beginTurn,
      runAsOwner,
      queueTaskScheduleTick: wakeup,
      launchPreflightTimeoutMs: input.launchTimeoutMs,
    },
    app,
  );
  const resumer = createTaskResumedExecutionRuntime({
    ...environment.runtime,
    ...goals,
    repository,
    bridge,
    runAsOwner,
    setChatAutomationPause,
    runClaimedTaskOperation: launcher.runClaimedTaskOperation,
  });
  const eligibility = createTaskDispatchEligibilityRuntime(
    { repository, bridge, ...routing },
    app,
    input.eligibilityTimeoutMs,
  );
  const queue = createTaskOperationQueue({
    repository,
    applicationOwnerId: () => input.owner,
    publishChatInvalidation: environment.runtime.publishChatInvalidation,
    queueTaskScheduleTick: wakeup,
    nameTask: (task) =>
      track(
        generateAutomaticTitle({
          repository,
          bridge,
          ownerId: input.owner,
          chatId: task.chatId,
          input: { kind: "task", task },
          availableModelRuntimes: routing.availableModelRuntimes,
          publishChatSummary: environment.runtime.publishChatSummary,
        }),
      ),
  });
  const retries = createTaskAutomaticRetry({
    repository,
    recover: recovery.recover,
    observe: (context, task) =>
      goals.readEncryptedTaskGoal(
        context,
        task,
        null,
        true,
        false,
        undefined,
        true,
      ),
    queue: (chat, data, kind) => queue(chat, data, kind, { automatic: true }),
    runAsOwner,
    publish: (chat, projectId) =>
      environment.runtime.publishChatInvalidation(chat, "task", null, {
        experience: "task",
        projectId,
      }),
    report: (chatId, err) =>
      app.log.warn(
        { chatId, err },
        "Automatic Task retry did not start; history is retained",
      ),
  });
  scheduler = createTaskSchedulerRuntime(
    {
      ...eligibility,
      repository,
      runAsOwner,
      publishChatInvalidation: environment.runtime.publishChatInvalidation,
      serverId: "background-server",
      serverInstanceId: "instance",
      automaticRetry: retries,
      taskRecovery: recovery,
      runClaimedTaskOperation: (...args) =>
        track(launcher.runClaimedTaskOperation(...args)),
      runResumedTaskDispatch: (...args) =>
        track(resumer.runResumedTaskDispatch(...args)),
    },
    app,
  );
  const rows = async (statement) => {
    const result = await execute(statement);
    return (Array.isArray(result) ? result : result.rows)[0]?.result ?? null;
  };
  const until = async (predicate) => {
    const deadline = Date.now() + 10000;
    while (!(await predicate())) {
      if (Date.now() >= deadline)
        throw new Error("Background scheduler fixture observation timed out");
      await new Promise(setImmediate);
    }
  };
  const drain = async () => {
    for (;;) {
      await scheduler.waitForActiveTaskScheduleTick();
      await Promise.allSettled([...pending]);
      await environment.settle();
      if (pending.size === 0 && environment.pending.size === 0) break;
    }
  };
  const snapshots = [];
  try {
    for (const step of input.steps ?? [{ kind: "tick" }, { kind: "drain" }]) {
      switch (step.kind) {
        case "tick":
          scheduler.queueTaskScheduleTick();
          break;
        case "ticks":
          for (let n = 0; n < step.count; n++)
            scheduler.queueTaskScheduleTick();
          break;
        case "wait":
          await scheduler.waitForActiveTaskScheduleTick();
          break;
        case "start":
          if (!timer) {
            timer = setInterval(scheduler.queueTaskScheduleTick, 1000);
            timer.unref();
            scheduler.queueTaskScheduleTick();
          }
          break;
        case "stop":
          clearInterval(timer);
          timer = undefined;
          retries.stop();
          break;
        case "close-goals":
          goals.close();
          break;
        case "project-pause": {
          const owner = step.owner ?? input.owner;
          const operation = runAsOwner(owner, () =>
            setProjectTasksPaused(
              owner,
              step.project ?? "github",
              step.paused === true,
            ),
          );
          if (step.detached) track(operation);
          else {
            let error = null;
            try {
              await operation;
            } catch (failure) {
              error =
                failure instanceof Error ? failure.message : String(failure);
            }
            snapshots.push({ projectPauseError: error });
          }
          break;
        }
        case "release":
          release();
          break;
        case "drain":
          await drain();
          break;
        case "sql":
          await execute(step.sql);
          break;
        case "snapshot":
          snapshots.push(await rows(step.sql));
          break;
        case "wait-sql":
          await until(
            async () =>
              JSON.stringify(await rows(step.sql)) ===
              JSON.stringify(step.value),
          );
          break;
        case "wait-commands":
          await until(
            () =>
              commands.filter(
                (c) =>
                  c.command.type === (step.command ?? "chat.turn") &&
                  (!step.chat || c.command.chatId === step.chat),
              ).length >= step.count,
          );
          break;
        default:
          throw new Error("Background scheduler fixture step");
      }
    }
    return { snapshots };
  } finally {
    clearInterval(timer);
    retries.stop();
    release();
    await drain();
    goals.close();
  }
}
