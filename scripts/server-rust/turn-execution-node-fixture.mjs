import { AsyncLocalStorage } from "node:async_hooks";
import { turnOutcomeFixture } from "./turn-outcome-node-fixture.mjs";
import { taskBackgroundFixture } from "./task-background-node-fixture.mjs";
import { createTaskResumedExecutionRuntime } from "../../cantrip_server/src/app/runtime/task-resumed-execution-runtime.ts";
import { createChatAutomationPauseRuntime } from "../../cantrip_server/src/app/runtime/chat-automation-pause-runtime.ts";
import { pausePeer } from "./automation-pause-node-fixture.mjs";
// Controlled worker/continuation collaborators around the actual Source turn.
// These tests do not stand in for real CLI receipt/queue HTTP acceptance.
import { createChatTurnRuntime } from "../../cantrip_server/src/app/runtime/chat-turn-runtime.ts";
import { createModelRoutingRuntime } from "../../cantrip_server/src/app/runtime/model-routing-runtime.ts";
import { WorkerUnavailableError } from "../../cantrip_server/src/workers/bridge.ts";
import { workerServerEnvelopeSchema } from "../../packages/protocol/dist/index.js";
import { turnLiveEnvironment } from "./turn-live-node-fixture.mjs";
import { createRequire } from "node:module";
const { sql } = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("drizzle-orm");
import { serverLogger } from "../../cantrip_server/src/logger.ts";
import { createTaskGoalRuntime } from "../../cantrip_server/src/app/runtime/task-goal-runtime.ts";
import { createTaskClaimedExecutionRuntime } from "../../cantrip_server/src/app/runtime/task-claimed-execution-runtime.ts";
export function streamTemplate(value, command, attempt) {
  if (Array.isArray(value))
    return value.map((v) => streamTemplate(v, command, attempt));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        streamTemplate(v, command, attempt),
      ]),
    );
  const fields = {
    "<lane>": command.executionLaneId,
    "<request>": command.clientMessageId,
    "<thread>": command.threadId ?? "stream-thread",
    "<turn>": attempt.result?.turnId ?? "stream-turn",
    "<chat>": command.chatId,
    "<worker>": "alpha",
    "<goal-thread>": command.threadId,
    "<task-response-id>": command.resultMode?.messageId,
    "<task-chat>": command.task?.chatId,
    "<task-operation-id>":
      command.operationId ?? command.resultMode?.operation?.operationId,
    "<task-response-key>": command.resultMode?.idempotencyKey,
    "<goal-message-id>": command.taskContext?.message?.id,
    "<goal-message-key>": command.taskContext?.message?.idempotencyKey,
  };
  return typeof value === "string" && Object.hasOwn(fields, value)
    ? fields[value]
    : value;
}
export async function turnExecutionFixture(repository, input) {
  const rootInput = input,
    scope = new AsyncLocalStorage();
  input = new Proxy(rootInput, {
    get: (target, key) =>
      key === "owner"
        ? (scope.getStore() ?? target.owner)
        : Reflect.get(target, key),
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const chatAttempts = new Map();

  const commands = [],
    logs = [],
    trace = [],
    publications = [],
    pending = new Set();
  let attemptIndex = 0;
  const began = Date.now();
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
      if (["chat.pause.set", "chat.native-control"].includes(command.type))
        return pausePeer({
          repository,
          input,
          worker,
          command,
          index:
            commands.filter((c) =>
              ["chat.pause.set", "chat.native-control"].includes(
                c.command.type,
              ),
            ).length - 1,
          trace,
          execute: (s) =>
            repository.nativeCommands.database.execute(sql.raw(s)),
          held:
            input.op === "native-command-task-background"
              ? held
              : Promise.resolve(),
        });
      if (input.failCommand === command.type)
        throw new Error("Controlled recovery worker failure");
      if (command.type === "task.operation.prepare") {
        const operation = (async () => {
          if (input.prepareDelayMs)
            await new Promise((resolve) =>
              setTimeout(resolve, input.prepareDelayMs),
            );
          if (input.prepareBeforeReplySQL)
            await repository.nativeCommands.database.execute(
              sql.raw(input.prepareBeforeReplySQL),
            );
          const prepared =
            input.preparedTasks?.[command.task.chatId] ?? input.preparedTask;
          return input.templatePreparedTask
            ? streamTemplate(prepared, command, {})
            : prepared;
        })();
        pending.add(operation);
        operation.then(
          () => pending.delete(operation),
          () => pending.delete(operation),
        );
        return operation;
      }
      if (command.type === "chat.thread.ensure")
        return { threadId: "recovery-thread" };
      if (
        [
          "chat.goal.create",
          "chat.goal.get",
          "chat.goal.update",
          "chat.automation.resume",
        ].includes(command.type)
      )
        return streamTemplate(
          command.taskContext?.message
            ? (input.goalControlReply ?? input.goalReply)
            : input.goalReply,
          command,
          {},
        );
      if (command.type === "chat.turn") {
        let attempt;
        if (input.chatAttempts) {
          const index = chatAttempts.get(command.chatId) ?? 0;
          chatAttempts.set(command.chatId, index + 1);
          attempt = input.chatAttempts[command.chatId]?.[index];
        } else attempt = input.attempts[attemptIndex++];
        if (input.holdTurnChats?.includes(command.chatId)) await held;
        if (!attempt) throw new Error("Unexpected stream attempt");
        for (const event of attempt.events ?? [])
          await options.onEvent(
            workerServerEnvelopeSchema.parse({
              kind: "event",
              requestId: "77777777-7777-4777-8777-000000000001",
              event: streamTemplate(event, command, attempt),
            }).event,
          );
        if (attempt.error) {
          const error = attempt.error.unavailable
            ? new WorkerUnavailableError(attempt.error.message)
            : new Error(attempt.error.message);
          if (attempt.error.code) error.code = attempt.error.code;
          throw error;
        }
        return attempt.templateResult
          ? streamTemplate(attempt.result, command, attempt)
          : attempt.result;
      }
      if (command.type === "chat.message.protect") {
        if (input.holdProtection) await held;
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
      }
      if (command.type === "task.message.protect") return input.taskMessage;
      if (
        command.type === "chat.native-logical.complete" ||
        command.type === "agent.interaction.cancel"
      )
        return null;
      if (command.type === "chat.turn.rollback") return { rolledBack: true };
      if (command.type === "label.generate")
        return input.labelResult ?? { titleProtection: null };
      throw new Error("Unexpected stream worker command " + command.type);
    },
  };
  const environment = turnLiveEnvironment(repository, input, bridge);
  const log = (level) => (context, message) => {
    const { err, durationMs, ...fields } = context;
    if (
      durationMs !== undefined &&
      (!(durationMs >= 0) || durationMs > Date.now() - began + 1000)
    )
      throw new Error("Invalid actual stream log duration");
    logs.push({
      level,
      message,
      ...fields,
      ...(durationMs !== undefined ? { durationMs: "<duration>" } : {}),
      error: Boolean(err),
      ...(err ? { errorMessage: err.message } : {}),
    });
  };
  const app = {
    log: {
      info: log("info"),
      debug: log("debug"),
      warn: log("warn"),
      error: log("error"),
    },
  };
  const restore = {};
  for (const level of ["info", "debug", "warn", "error"]) {
    restore[level] = serverLogger[level];
    serverLogger[level] = (message, context) =>
      log(level)(context ?? {}, message);
  }
  restore.sampled = serverLogger.sampled;
  serverLogger.sampled = (_key, _every, level, message, context) =>
    log(level)(context ?? {}, message);
  const routeCooldowns = new Map(),
    runtimeCooldownKey = (r) =>
      r.routeId +
      (r.provider.accountId ? ":account:" + r.provider.accountId : "");
  const routing = createModelRoutingRuntime({
    repository,
    bridge,
    app,
    applicationOwnerId: () => input.owner,
    openRouterRuntimeCatalogs: { hydrate: async () => false },
    publishLiveInvalidation: (resource, fields) =>
      publications.push({ kind: "invalidation", resource, fields }),
    publishProjectTokenUsageChange: (ownerId, projectId, completed) =>
      publications.push({ kind: "usage", ownerId, projectId, completed }),
    routeCooldowns,
    runtimeCooldownKey,
  });
  const options = structuredClone(input.options ?? {});
  const completed = (kind) => async (value) => {
    trace.push({
      kind,
      chatId: value.execution.chatId,
      messageId: value.userMessage.id,
      turnId: value.result.turnId ?? null,
      attribution: value.attribution,
    });
    if (input.failHook === kind)
      throw new Error("Controlled post-processing failure");
  };
  const failed = (kind) => async (value) => {
    trace.push({
      kind,
      chatId: value.execution.chatId,
      messageId: value.userMessage.id,
    });
    if (input.failHook === kind)
      throw new Error("Controlled post-processing failure");
  };
  if (options.structuredResult) {
    options.structuredResult.onCompleted = completed("structured-completed");
    options.structuredResult.onFailed = failed("structured-failed");
    if (input.structuredAfter)
      options.structuredResult.afterCompleted = completed("structured-after");
  }
  if (input.afterCompleted)
    options.afterTurnCompleted = completed("after-completed");
  if (input.afterFailed) options.afterTurnFailed = failed("after-failed");
  const buildTurn = (overrides = {}) =>
    createChatTurnRuntime({
      ...environment.runtime,
      ...routing,
      app,
      repository,
      bridge,
      routeCooldowns,
      runtimeCooldownKey,
      serverId: "stream-server",
      applicationOwnerId: () => input.owner,
      runAsOwner: (owner, run) =>
        scope.run(owner, () => {
          const p = run();
          pending.add(p);
          p.then(
            () => pending.delete(p),
            () => pending.delete(p),
          );
          return p;
        }),
      cancelChatTurnOutcomeRecovery: (worker, chatId, messageId) =>
        trace.push({ kind: "cancel-recovery", worker, chatId, messageId }),
      continuePendingWorktreeTransition: async (chatId) => {
        trace.push({ kind: "continue-worktree", chatId });
        return input.pendingTransition === true;
      },
      dispatchNextQueuedPrompt: async (chatId) => {
        trace.push({ kind: "dispatch-queue", chatId });
      },
      resolvePromptAttachments: (...args) =>
        environment.recovery.resolvePromptAttachments(...args),
      ...overrides,
    });
  const { beginTurn } = buildTurn();
  const goals =
    input.op === "native-command-task-claimed"
      ? createTaskGoalRuntime({
          ...environment.runtime,
          ...routing,
          repository,
          bridge,
          app,
          applicationOwnerId: () => input.owner,
          beginTurn,
          resolvePromptAttachments:
            environment.recovery.resolvePromptAttachments,
          continuePendingWorktreeTransition: async (chat) => {
            trace.push({ kind: "pending", chat });
            return input.pendingTransition === true;
          },
          dispatchNextQueuedPrompt: async (chat) => {
            trace.push({ kind: "queue", chat });
          },
          queueTaskScheduleTick: () => trace.push({ kind: "tick" }),
        })
      : null;
  let result = null,
    beginError = null;
  try {
    const context =
      input.context ??
      (await repository.getChatExecutionContext(input.owner, input.chat));
    try {
      if (input.op === "native-command-turn-outcome") {
        result = await turnOutcomeFixture({
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
          execute: (statement) =>
            repository.nativeCommands.database.execute(sql.raw(statement)),
        });
      } else if (input.op === "native-command-task-background") {
        result = await taskBackgroundFixture({
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
          execute: (statement) =>
            repository.nativeCommands.database.execute(sql.raw(statement)),
        });
      } else if (goals) {
        const launcher = createTaskClaimedExecutionRuntime(
          {
            ...environment.runtime,
            ...routing,
            ...goals,
            repository,
            bridge,
            beginTurn,
            runAsOwner: (_owner, operation) => operation(),
            queueTaskScheduleTick: () => trace.push({ kind: "tick" }),
            launchPreflightTimeoutMs: input.launchTimeoutMs,
          },
          app,
        );
        if (input.action === "resume") {
          const setChatAutomationPause = createChatAutomationPauseRuntime(
            {
              repository,
              bridge,
              publishChatSummary: environment.runtime.publishChatSummary,
              resumeChatAutomation: goals.resumeChatAutomation,
            },
            app,
          );
          const resumer = createTaskResumedExecutionRuntime({
            ...environment.runtime,
            ...goals,
            repository,
            bridge,
            runAsOwner: (_owner, operation) => operation(),
            setChatAutomationPause,
            runClaimedTaskOperation: launcher.runClaimedTaskOperation,
          });
          const operation = resumer.runResumedTaskDispatch(
            input.owner,
            input.claim,
          );
          if (input.detached) {
            pending.add(operation);
            operation.then(
              () => pending.delete(operation),
              () => pending.delete(operation),
            );
          } else await operation;
        } else if (input.action === "finish")
          await launcher.finishClaimedTaskFailure(
            input.owner,
            input.claim,
            input.failure ? new Error(input.failure) : undefined,
          );
        else
          await launcher.runClaimedTaskOperation(
            input.owner,
            input.claim,
            input.preparedRuntime ?? null,
          );
      } else result = await beginTurn(context, input.input ?? {}, options);
    } catch (error) {
      beginError = error.message;
    }
    while (pending.size) {
      const values = await Promise.allSettled([...pending]);
      const failure = values.find((v) => v.status === "rejected");
      if (failure) throw failure.reason;
    }
    await environment.settle();
    return {
      result,
      beginError,
      commands,
      events: environment.events,
      publications,
      trace,
      logs,
    };
  } finally {
    release();
    goals?.close();
    routing.close();
    for (const [level, method] of Object.entries(restore))
      serverLogger[level] = method;
  }
}
