// Actual Source recovery coordinator and repositories. Turn, account handoff
// and Task collaborators below are controlled fixture boundaries only.
import { createChatRecoveryRuntime } from "../../cantrip_server/src/app/runtime/chat-recovery-runtime.ts";
import { createModelRoutingRuntime } from "../../cantrip_server/src/app/runtime/model-routing-runtime.ts";
import { turnLiveEnvironment } from "./turn-live-node-fixture.mjs";
import { serverLogger } from "../../cantrip_server/src/logger.ts";
import { createRequire } from "node:module";
const { sql } = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("drizzle-orm");
export async function recoveryFixture(original, input) {
  const trace = [],
    logs = [],
    commands = [],
    pending = new Set();
  const track = (p) => {
    pending.add(p);
    p.then(
      () => pending.delete(p),
      () => pending.delete(p),
    );
    return p;
  };
  const repository = new Proxy(original, {
    get(target, key) {
      const value = Reflect.get(target, key);
      return typeof value === "function"
        ? (...args) => {
            const result = value.apply(target, args);
            return result && typeof result.then === "function"
              ? track(result)
              : result;
          }
        : value;
    },
  });
  const execute = (statement) =>
    repository.nativeCommands.database.execute(sql.raw(statement));
  const log = (level) => (context, message) => {
    const { err, ...fields } = context;
    logs.push({
      level,
      message,
      ...fields,
      error: Boolean(err),
      ...(err ? { errorMessage: err.message } : {}),
    });
  };
  const app = {
    log: Object.fromEntries(
      ["info", "debug", "warn", "error"].map((level) => [level, log(level)]),
    ),
  };
  const saved = {};
  for (const level of ["info", "debug", "warn", "error"]) {
    saved[level] = serverLogger[level];
    serverLogger[level] = (message, context) =>
      log(level)(context ?? {}, message);
  }
  saved.sampled = serverLogger.sampled;
  serverLogger.sampled = (_key, _count, level, message, context) =>
    log(level)(context ?? {}, message);
  const bridge = {
    isConnected: () => input.connected !== false,
    async request(worker, command, options) {
      commands.push({
        worker,
        command,
        timeoutMs: Object.hasOwn(options ?? {}, "timeoutMs")
          ? options.timeoutMs
          : 600000,
      });
      if (input.failCommand === command.type)
        throw new Error("Controlled recovery worker failure");
      if (command.type === "chat.queue.execute") return null;
      if (command.type === "chat.thread.ensure")
        return { threadId: "recovery-thread" };
      if (command.type === "worktree.status") return input.worktreeStatus;
      if (command.type === "chat.message.protect")
        return {
          ...input.protectedMessage,
          id: command.message.id,
          idempotencyKey: command.message.idempotencyKey,
          classification: {
            ...input.protectedMessage.classification,
            role: command.message.role,
            mode: command.message.mode ?? "default",
          },
        };
      throw new Error("Unexpected recovery worker command " + command.type);
    },
  };
  const environment = turnLiveEnvironment(repository, input, bridge);
  const routing = createModelRoutingRuntime({
    repository,
    bridge,
    app,
    applicationOwnerId: () => input.owner,
    openRouterRuntimeCatalogs: { hydrate: async () => false },
    routeCooldowns: new Map(),
    runtimeCooldownKey: (r) => r.routeId,
    publishLiveInvalidation() {},
    publishProjectTokenUsageChange() {},
  });
  const runtime = createChatRecoveryRuntime({
    ...environment.runtime,
    ...routing,
    repository,
    bridge,
    app,
    applicationOwnerId: () => input.owner,
    runAsOwner: (_owner, run) => track(Promise.resolve(run())),
    beginTurn: async (context, turn, options) => {
      trace.push({
        kind: "begin",
        owner: input.owner,
        context,
        input: turn,
        options,
      });
      if (input.beginSql) await execute(input.beginSql);
      if (input.failBegin) throw new Error("Controlled queued turn failure");
    },
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
    recoverTaskExecution: async (chat) => {
      trace.push({ kind: "recover-task", owner: input.owner, chat });
      return input.recoverTask === true;
    },
    continueTaskGoalInWorktree: async (context, turn) => {
      trace.push({
        kind: "continue-goal",
        owner: input.owner,
        context,
        input: turn,
      });
      return input.continueGoal === true;
    },
    reconcileTaskExecutions: async (owner) => {
      trace.push({ kind: "reconcile-tasks", owner });
    },
    launchPreparedTaskGoal: async () => {
      throw new Error("Unexpected Task launch in coordinator fixture");
    },
    failTaskGoalLaunch: async () => {
      throw new Error("Unexpected Task launch failure in coordinator fixture");
    },
    queueTaskScheduleTick: () => {
      throw new Error("Unexpected Task tick in coordinator fixture");
    },
  });
  try {
    let results;
    switch (input.action ?? "dispatch") {
      case "dispatch":
        results = await Promise.all(
          Array.from({ length: input.count ?? 1 }, () =>
            runtime.dispatchNextQueuedPrompt(input.chat),
          ),
        );
        break;
      case "transition":
        results = [await runtime.continuePendingWorktreeTransition(input.chat)];
        break;
      case "resume":
        results = [
          await runtime.resumePendingWorktreeTransitionsForWorker(
            input.owner,
            input.worker ?? "alpha",
          ),
        ];
        break;
      case "configure":
        results = [
          await repository.setChatModelConfiguration(
            input.owner,
            input.chat,
            input.configuration,
          ),
        ];
        break;
      default:
        throw new Error("Unknown recovery fixture action");
    }
    while (pending.size) await Promise.allSettled([...pending]);
    await environment.settle();
    return {
      results: results.map((v) => v ?? null),
      trace,
      commands,
      events: environment.events,
      logs,
    };
  } finally {
    routing.close();
    for (const [level, value] of Object.entries(saved))
      serverLogger[level] = value;
  }
}
