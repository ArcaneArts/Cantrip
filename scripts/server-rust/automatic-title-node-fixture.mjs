import { createTaskOperationQueue } from "../../cantrip_server/src/app/runtime/task-operation-queue.ts";
import { retryTaskOperation } from "../../cantrip_server/src/app/runtime/task-automatic-retry.ts";
import {
  generateAutomaticTitle,
  labelingModelConfiguration,
} from "../../cantrip_server/src/chats/automatic-labeling.ts";
import { createModelRoutingRuntime } from "../../cantrip_server/src/app/runtime/model-routing-runtime.ts";
import { turnLiveEnvironment } from "./turn-live-node-fixture.mjs";
import { serverLogger } from "../../cantrip_server/src/logger.ts";
import { createRequire } from "node:module";
const { sql } = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("drizzle-orm");
export async function automaticTitleFixture(repository, input) {
  if (input.action === "claim")
    return (
      (
        await repository.chatState.claimAutomaticTitle(
          input.owner,
          input.chat,
          input.messageId,
        )
      )?.claimId ?? null
    );
  if (input.action === "finish")
    return repository.chatState.finishAutomaticTitle(
      input.owner,
      input.chat,
      input.claim,
      input.title ?? null,
      input.empty ?? false,
    );
  const logs = [],
    commands = [],
    pending = new Set();
  let ticks = 0;
  const restore = serverLogger.debug;
  const restoreSampled = serverLogger.sampled;
  serverLogger.debug = (message, context) =>
    logs.push({ level: "debug", message, ...context, error: false });
  serverLogger.sampled = (_key, _every, level, message, context) =>
    logs.push({ level, message, ...context, error: false });
  const bridge = {
    isConnected: () => input.connected !== false,
    async request(worker, command, options) {
      commands.push({ worker, command, timeoutMs: options.timeoutMs });
      const index =
        commands.filter((c) => c.command.type === "label.generate").length - 1;
      const before = input.labelBeforeReplySQL?.[index] ?? input.beforeReplySQL;
      for (const statement of Array.isArray(before)
        ? before
        : before
          ? [before]
          : [])
        await repository.nativeCommands.database.execute(sql.raw(statement));
      if (input.failRequest) throw new Error("private-provider-error-marker");
      return input.labelResults?.[index] ?? input.labelResult;
    },
  };
  const environment = turnLiveEnvironment(repository, input, bridge);
  const routing = createModelRoutingRuntime({
    repository,
    bridge,
    app: { log: {} },
    applicationOwnerId: () => input.owner,
    openRouterRuntimeCatalogs: { hydrate: async () => false },
    routeCooldowns: new Map(),
    runtimeCooldownKey: (r) => r.routeId,
    publishLiveInvalidation() {},
    publishProjectTokenUsageChange() {},
  });
  const generate = async (task) =>
    generateAutomaticTitle({
      repository,
      bridge,
      ownerId: input.owner,
      chatId: input.chat,
      input: task
        ? { kind: "task", task }
        : { kind: "message", message: input.message },
      availableModelRuntimes: task
        ? routing.availableModelRuntimes
        : async (context, modelId) =>
            (
              await routing.routePairsForConfiguration(
                context,
                labelingModelConfiguration(modelId),
              )
            ).map((p) => p.root.runtime),
      publishChatSummary: environment.runtime.publishChatSummary,
    });
  const nameTask = (task) => {
    const promise = generate(task);
    pending.add(promise);
    promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
  };
  let value = null;
  try {
    if (input.op === "native-command-task-queue") {
      const queue = createTaskOperationQueue({
        repository,
        applicationOwnerId: () => input.owner,
        publishChatInvalidation: environment.runtime.publishChatInvalidation,
        queueTaskScheduleTick: () => {
          ticks++;
        },
        nameTask,
      });
      if (input.action === "retry")
        value = await retryTaskOperation(
          repository,
          input.owner,
          input.task && typeof input.task === "object"
            ? input.task
            : await repository.tasks.get(input.owner, input.chat),
          (chat, data, kind) =>
            queue(chat, data, kind, { automatic: input.automatic === true }),
          input.operationId,
        );
      else
        value = await queue(input.chat, input.input, input.kind, {
          automatic: input.automatic === true,
        });
    } else
      await generate(
        input.task
          ? typeof input.task === "object"
            ? input.task
            : await repository.tasks.get(input.owner, input.chat)
          : null,
      );
    while (pending.size) await Promise.allSettled([...pending]);
    await environment.settle();
    return {
      commands,
      events: environment.events,
      logs,
      ...(input.op === "native-command-task-queue" ? { value, ticks } : {}),
    };
  } finally {
    while (pending.size) await Promise.allSettled([...pending]);
    await environment.settle();
    routing.close();
    serverLogger.debug = restore;
    serverLogger.sampled = restoreSampled;
  }
}
