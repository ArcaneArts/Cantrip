// Actual Goal runtime, routing, live writers and SQL repositories. The turn
// boundary and worker are explicit controlled peers in this development fixture.
import { serverLogger } from "../../cantrip_server/src/logger.ts";
import { createTaskExecutionRecovery } from "../../cantrip_server/src/app/runtime/task-execution-recovery.ts";
import { createTaskGoalRuntime } from "../../cantrip_server/src/app/runtime/task-goal-runtime.ts";
import { createModelRoutingRuntime } from "../../cantrip_server/src/app/runtime/model-routing-runtime.ts";
import { turnLiveEnvironment } from "./turn-live-node-fixture.mjs";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { taskAutomaticFixture } from "./task-automatic-node-fixture.mjs";
import {
  automationPauseFixture,
  pausePeer,
} from "./automation-pause-node-fixture.mjs";
const { sql } = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("drizzle-orm");
function template(value, command) {
  if (value === "<goal-message-id>") return command.taskContext?.message?.id;
  if (value === "<goal-message-key>")
    return command.taskContext?.message?.idempotencyKey;
  if (value === "<goal-thread>") return command.threadId;
  if (Array.isArray(value)) return value.map((v) => template(v, command));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, template(v, command)]),
    );
  return value;
}
export async function taskGoalFixture(original, input) {
  const rootInput = input,
    scope = new AsyncLocalStorage(),
    clock = { now: input.retryClock ?? 60000 };
  input = new Proxy(rootInput, {
    get: (target, key) =>
      key === "owner"
        ? (scope.getStore() ?? target.owner)
        : Reflect.get(target, key),
  });
  const retryRepository = new Proxy(original.taskRetries, {
    get(target, key) {
      const method = Reflect.get(target, key);
      if (typeof method !== "function") return method;
      return (...args) => {
        if (
          input.action === "automatic" &&
          ["listCandidates", "noteFailure", "claimDue", "finish"].includes(key)
        ) {
          const index = {
            listCandidates: 0,
            noteFailure: 4,
            claimDue: 2,
            finish: 4,
          }[key];
          while (args.length < index) args.push(undefined);
          args[index] = clock.now;
        }
        return method.apply(target, args);
      };
    },
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const pending = new Set(),
    trace = [],
    commands = [],
    logs = [];
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
      if (key === "taskRetries") return retryRepository;
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
  const execute = (s) => repository.nativeCommands.database.execute(sql.raw(s));
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
      if (["chat.pause.set", "chat.native-control"].includes(command.type)) {
        const index =
          commands.filter((c) =>
            ["chat.pause.set", "chat.native-control"].includes(c.command.type),
          ).length - 1;
        return pausePeer({
          repository,
          input,
          worker,
          command,
          index,
          trace,
          execute,
          held,
        });
      }
      if (
        command.type === "chat.goal.get" &&
        (input.holdGoal === true ||
          input.holdGoalChats?.includes(command.chatId))
      )
        await held;
      if (input.failCommand === command.type)
        throw new Error("Controlled recovery worker failure");
      if (command.type === "chat.thread.ensure")
        return { threadId: "recovery-thread" };
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
      if (command.type === "task.message.protect") return input.taskMessage;
      if (
        [
          "chat.goal.create",
          "chat.goal.get",
          "chat.goal.update",
          "chat.automation.resume",
        ].includes(command.type)
      ) {
        if (input.goalBeforeReplySQL) await execute(input.goalBeforeReplySQL);
        if (input.goalBeforeReplyByType?.[command.type])
          await execute(input.goalBeforeReplyByType[command.type]);
        const selected = command.taskContext?.message
          ? (input.goalControlReply ?? input.goalReply)
          : input.goalReply;
        return template(input.goalReplies?.[command.type] ?? selected, command);
      }
      throw new Error("Unexpected Goal worker command " + command.type);
    },
  };
  const environment = turnLiveEnvironment(repository, input, bridge);
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
      ["warn", "debug", "error", "info"].map((k) => [k, log(k)]),
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
  const runtime = createTaskGoalRuntime({
    ...environment.runtime,
    ...routing,
    repository,
    bridge,
    app,
    applicationOwnerId: () => input.owner,
    resolvePromptAttachments: environment.recovery.resolvePromptAttachments,
    beginTurn: async (context, turn, options = {}) => {
      const { afterTurnCompleted, afterTurnFailed, ...rest } = options;
      trace.push({
        kind: "begin",
        owner: input.owner,
        context,
        input: turn,
        options: rest,
        hooks: {
          completed: Boolean(afterTurnCompleted),
          failed: Boolean(afterTurnFailed),
        },
      });
      if (input.beginSql) await execute(input.beginSql);
      if (input.failBegin) throw new Error("Controlled queued turn failure");
      return input.beginResult ?? null;
    },
    continuePendingWorktreeTransition: async (chat) => {
      trace.push({ kind: "pending", owner: input.owner, chat });
      if (input.pendingSql) await execute(input.pendingSql);
      return input.pending === true;
    },
    dispatchNextQueuedPrompt: async (chat) => {
      trace.push({ kind: "queue", owner: input.owner, chat });
    },
    queueTaskScheduleTick: () => trace.push({ kind: "tick" }),
  });
  const savedNow = Date.now;
  let recoveryClock = input.recoveryClock;
  if (input.recoveryClock !== undefined)
    Date.now = () =>
      new Error().stack
        .split("\n")[2]
        ?.includes("app/runtime/task-execution-recovery.ts")
        ? recoveryClock
        : savedNow();
  const recovery = createTaskExecutionRecovery({
    repository,
    bridge,
    goals: runtime,
    ownerId: () => input.owner,
    leaseOwner: input.recoveryLeaseOwner ?? "recovery-server",
    publish: (chat, project) =>
      trace.push({
        kind: "recovery-publish",
        owner: input.owner,
        chat,
        project,
      }),
    unpause: async (owner, chat) => {
      trace.push({ kind: "unpause", owner, chat });
      if (input.unpauseSql) await execute(input.unpauseSql);
      if (!input.leavePaused)
        await repository.setChatAutomationPaused(owner, chat, false);
    },
    reportFailure: (chat, error) =>
      trace.push({
        kind: "recovery-error",
        owner: input.owner,
        chat,
        message: error.message,
      }),
  });
  let result, error;
  try {
    const context = ["automatic", "pause"].includes(input.action)
      ? null
      : (input.context ??
        (await repository.getChatExecutionContext(input.owner, input.chat)));
    const task = ["automatic", "pause"].includes(input.action)
      ? null
      : await repository.tasks.get(input.owner, input.chat);
    switch (input.action) {
      case "pause":
        result = await automationPauseFixture({
          repository,
          input,
          bridge,
          environment,
          runtime,
          app,
          trace,
          release,
          track,
        });
        break;
      case "automatic":
        result = await taskAutomaticFixture({
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
        });
        break;
      case "recover":
        result = await recovery.recover(
          input.chat,
          input.resume ?? false,
          input.automatic ?? false,
        );
        break;
      case "recover-detached":
        track(
          recovery.recover(
            input.chat,
            input.resume ?? false,
            input.automatic ?? false,
          ),
        );
        result = null;
        break;
      case "recover-batch":
        result = await Promise.all(
          input.recoveries.map((r) =>
            recovery
              .recover(input.chat, r.resume ?? false, r.automatic ?? false)
              .then(
                (value) => ({ value }),
                (error) => ({ error: error.message }),
              ),
          ),
        );
        break;
      case "recover-reconcile":
        for (const at of input.reconcileClocks ??
          Array(input.count ?? 1).fill(recoveryClock)) {
          recoveryClock = at;
          await recovery.reconcile(input.owner);
        }
        result = null;
        break;
      case "read":
        result = await runtime.readEncryptedTaskGoal(
          context,
          task,
          input.message ?? null,
          input.observeExecution ?? false,
          input.activate ?? false,
          input.runtimeFailure,
          input.observationOnly ?? false,
        );
        break;
      case "start":
        result = await runtime.startGoalTurn(
          context,
          input.turn,
          input.options,
        );
        break;
      case "resume":
        result = await runtime.resumeChatAutomation(
          input.chat,
          input.activate ?? false,
          input.reconciled ?? false,
        );
        break;
      case "continue":
        result = await runtime.continueTaskGoalInWorktree(
          context,
          input.turn,
          input.lease,
        );
        break;
      case "launch":
        result = await runtime.launchPreparedTaskGoal(
          input.chat,
          input.operation,
          input.options,
        );
        break;
      case "reconcile":
        result = await runtime.reconcileTaskGoalDispatch(task, input.state);
        break;
      case "retain":
        await runtime.retainTaskGoalLease(input.lease);
        await runtime.retainTaskGoalLease(input.lease);
        result = null;
        break;
      default:
        throw new Error("Goal fixture action");
    }
  } catch (e) {
    error = { message: e.message };
    if (input.action === "pause" && e.statusCode !== undefined)
      error.statusCode = e.statusCode;
  } finally {
    for (;;) {
      await Promise.allSettled([...pending]);
      await new Promise(setImmediate);
      if (pending.size === 0) break;
    }
    Date.now = savedNow;
    runtime.close();
    for (const [key, value] of Object.entries(saved)) serverLogger[key] = value;
    for (;;) {
      await Promise.allSettled([...pending]);
      await environment.settle();
      await new Promise(setImmediate);
      if (pending.size === 0 && environment.pending.size === 0) break;
    }
  }
  return {
    result: result ?? null,
    trace,
    commands,
    events: environment.events,
    logs,
    ...(error ? { error } : {}),
  };
}
