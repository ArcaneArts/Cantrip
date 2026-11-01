// The actual Source turn runs through its durable bootstrap. A deliberate
// observation boundary stops it immediately after loading worker attribution;
// this fixture does not claim to exercise the unported worker stream.
import { createChatTurnRuntime } from "../../cantrip_server/src/app/runtime/chat-turn-runtime.ts";
import { createModelRoutingRuntime } from "../../cantrip_server/src/app/runtime/model-routing-runtime.ts";
import { turnLiveEnvironment } from "./turn-live-node-fixture.mjs";
class BootstrapBoundary extends Error {}
export async function turnBootstrapFixture(repository, input) {
  const commands = [],
    stageLogs = [];
  const bridge = {
    isConnected: () => input.connected !== false,
    async request(worker, command) {
      commands.push({ worker, command });
      if (input.failCommand === command.type)
        throw new Error("Controlled bootstrap worker failure");
      if (Object.hasOwn(input.responses ?? {}, command.type))
        return input.responses[command.type];
      if (command.type === "chat.message.protect")
        return {
          ...input.protectedMessage,
          id: command.message.id,
          idempotencyKey: command.message.idempotencyKey,
        };
      if (command.type === "chat.turn.rollback") return { rolledBack: true };
      if (command.type === "chat.native-logical.complete") return null;
      throw new Error("Unexpected bootstrap worker command " + command.type);
    },
  };
  const environment = turnLiveEnvironment(repository, input, bridge);
  let execution, nativeCommandReceipt, userMessage, routePairs, attachments;
  const native = new Proxy(repository.nativeCommands, {
    get(target, key) {
      if (key === "admit")
        return async (...args) => {
          const result = await target.admit(...args);
          execution = result.execution;
          nativeCommandReceipt = result.receipt;
          return result;
        };
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const observed = new Proxy(repository, {
    get(target, key) {
      if (key === "nativeCommands") return native;
      if (key === "getWorker")
        return async (...args) => {
          await target.getWorker(...args);
          throw new BootstrapBoundary();
        };
      if (key === "startChatExecutionLane")
        return async (...args) => {
          execution = await target.startChatExecutionLane(...args);
          return execution;
        };
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const log = (context, message) => {
    if (
      context.event === "task.turn-bootstrap-stage" &&
      context.stage !== "load-worker-attribution"
    ) {
      const { durationMs, err, ...fields } = context;
      stageLogs.push({ message, ...fields });
    }
  };
  const routing = createModelRoutingRuntime({
    repository,
    bridge,
    app: { log: { info: log, warn: log, error: log } },
    applicationOwnerId: () => input.owner,
    openRouterRuntimeCatalogs: { hydrate: async () => false },
    publishLiveInvalidation() {},
    publishProjectTokenUsageChange() {},
    routeCooldowns: new Map(),
    runtimeCooldownKey: (r) => r.routeId,
  });
  const live = { ...environment.runtime };
  for (const key of [
    "appendLiveEncryptedChatMessage",
    "appendLiveTaskMessage",
  ]) {
    const append = live[key];
    live[key] = async (...args) => {
      const value = await append(...args);
      if (value) userMessage = live.taskMessageServerStub(value);
      return value;
    };
  }
  const unexpected = () => {
    throw new Error("Worker stream crossed the bootstrap observation boundary");
  };
  const { beginTurn: begin } = createChatTurnRuntime({
    ...live,
    ...routing,
    app: { log: { info: log, warn: log, error: log } },
    repository: observed,
    serverId: "bootstrap-server",
    applicationOwnerId: () => input.owner,
    bridge,
    routeCooldowns: new Map(),
    runtimeCooldownKey: (r) => r.routeId,
    runAsOwner: unexpected,
    cancelChatTurnOutcomeRecovery: unexpected,
    continuePendingWorktreeTransition: unexpected,
    dispatchNextQueuedPrompt: unexpected,
    routePairsForConfiguration: async (...args) => {
      routePairs = await routing.routePairsForConfiguration(...args);
      return routePairs;
    },
    resolvePromptAttachments: async (...args) => {
      attachments = await environment.recovery.resolvePromptAttachments(
        ...args,
      );
      return attachments;
    },
  });
  const context =
    input.context ??
    (await repository.getChatExecutionContext(input.owner, input.chat));
  try {
    try {
      await begin(context, input.input ?? {}, input.options ?? {});
      throw new Error("Bootstrap boundary was not reached");
    } catch (error) {
      if (!(error instanceof BootstrapBoundary)) throw error;
    }
    await environment.settle();
    return {
      execution,
      ...(nativeCommandReceipt ? { nativeCommandReceipt } : {}),
      userMessage,
      routePairs,
      attachments,
      events: environment.events,
      commands,
      stageLogs,
    };
  } finally {
    routing.close();
  }
}
