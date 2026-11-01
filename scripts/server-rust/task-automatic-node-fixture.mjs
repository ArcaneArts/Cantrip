// Actual Source actor, Goal/recovery, admission, naming, Live and repositories.
// Clock and held worker replies are explicit differential-test boundaries.
import { createTaskAutomaticRetry } from "../../cantrip_server/src/app/runtime/task-automatic-retry.ts";
import { createTaskOperationQueue } from "../../cantrip_server/src/app/runtime/task-operation-queue.ts";
import { generateAutomaticTitle } from "../../cantrip_server/src/chats/automatic-labeling.ts";
export async function taskAutomaticFixture({
  repository,
  input,
  scope,
  clock,
  bridge,
  routing,
  runtime,
  recovery,
  environment,
  track,
  commands,
  release,
  execute,
  log,
  trace,
}) {
  const queue = createTaskOperationQueue({
    repository,
    applicationOwnerId: () => input.owner,
    publishChatInvalidation: environment.runtime.publishChatInvalidation,
    queueTaskScheduleTick: () => trace.push({ kind: "tick" }),
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
  const actor = createTaskAutomaticRetry({
    repository,
    recover: recovery.recover,
    observe: (context, task) =>
      runtime.readEncryptedTaskGoal(
        context,
        task,
        null,
        true,
        false,
        undefined,
        true,
      ),
    queue: (chat, data, kind) => queue(chat, data, kind, { automatic: true }),
    runAsOwner: (owner, operation) => scope.run(owner, operation),
    publish: (chat, projectId) =>
      environment.runtime.publishChatInvalidation(chat, "task", null, {
        experience: "task",
        projectId,
      }),
    report: (chatId, err) =>
      log("warn")(
        { chatId, err },
        "Automatic Task retry did not start; history is retained",
      ),
  });
  const rows = async (statement) => {
    const result = await execute(statement);
    return (Array.isArray(result) ? result : result.rows)[0]?.result ?? null;
  };
  const until = async (predicate) => {
    const deadline = Date.now() + 10000;
    while (!(await predicate())) {
      if (Date.now() >= deadline)
        throw new Error("Automatic retry fixture observation timed out");
      await new Promise(setImmediate);
    }
  };
  const snapshots = [];
  try {
    for (const step of input.steps ?? [{ kind: "tick" }, { kind: "drain" }]) {
      switch (step.kind) {
        case "tick":
          await actor.tick();
          break;
        case "ticks":
          await Promise.all(
            Array.from({ length: step.count }, () => actor.tick()),
          );
          break;
        case "drain":
          await actor.drain();
          break;
        case "stop":
          actor.stop();
          break;
        case "release":
          release();
          break;
        case "clock":
          clock.now = step.now;
          break;
        case "wait-commands":
          await until(
            () =>
              commands.filter((c) => c.command.type === "chat.goal.get")
                .length >= step.count,
          );
          break;
        case "wait-sql":
          await until(async () => (await rows(step.sql)) === step.value);
          break;
        case "sql":
          await execute(step.sql);
          break;
        case "snapshot":
          snapshots.push(await rows(step.sql));
          break;
        default:
          throw new Error("Automatic retry fixture step");
      }
    }
    return { snapshots };
  } finally {
    actor.stop();
    release();
    await actor.drain();
  }
}
