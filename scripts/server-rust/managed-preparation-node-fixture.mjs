// Disposable adapter to the unchanged production repositories and runtime.
import { createRequire } from "node:module";
import { createManagedChatPreparation } from "../../cantrip_server/src/app/runtime/managed-chat-preparation.ts";
import { createModelRoutingRuntime } from "../../cantrip_server/src/app/runtime/model-routing-runtime.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { sql } = require("drizzle-orm");
export async function managedPreparationFixture(repository, input) {
  const jobs = repository.managedChatPreparations;
  const { owner, chat, worker } = input;
  if (input.op === "preparation-run") return runPreparation(repository, input);
  switch (input.op) {
    case "preparation-get":
      return jobs.get(owner, chat);
    case "preparation-request":
      return jobs.request(owner, chat, worker);
    case "preparation-claim":
      return jobs.claim(owner, chat, worker);
    case "preparation-update":
      return jobs.update(
        owner,
        input.state,
        input.phase,
        input.failedPhase ?? null,
        input.terminal,
      );
    case "preparation-exit":
      return jobs.consoleExited(
        owner,
        worker,
        input.terminal,
        input.generation,
      );
    case "preparation-worker":
      return jobs.forWorker(owner, worker);
    case "preparation-console":
      return repository.getOrCreateChatConsole(owner, chat, input.input);
    default:
      throw new Error("Unknown preparation fixture operation");
  }
}

async function runPreparation(repository, input) {
  const calls = [],
    publications = [],
    attachments = new Map();
  let fail = input.fail;
  let releaseThread, threadSeen, releaseConsole;
  const threadGate = new Promise((resolve) => (releaseThread = resolve));
  const seen = new Promise((resolve) => (threadSeen = resolve));
  const consoleGate = new Promise((resolve) => (releaseConsole = resolve));
  const bridge = {
    isConnected: () => true,
    async request(worker, command, options) {
      calls.push({ worker, command });
      if (command.type === "chat.thread.ensure") {
        threadSeen();
        if (input.gate) await threadGate;
        if (input.ensureSql)
          await repository.projects.database.execute(sql.raw(input.ensureSql));
        if (fail === "thread") throw new Error("Controlled thread failure");
        return {
          threadId:
            input.threadResult ?? command.threadId ?? "prepared-native-thread",
        };
      }
      if (command.type === "terminal.prepare-state") {
        if (fail === "state") throw new Error("Controlled state failure");
        return {
          ...input.input,
          id: input.changedIdentity
            ? "88888888-8888-4888-8888-888888888888"
            : command.terminalId,
        };
      }
      if (command.type === "terminal.open") {
        if (fail === "console") throw new Error("Controlled console failure");
        const finished = new Promise((resolve) =>
          attachments.set(command.attachmentId, () =>
            resolve({ status: "detached" }),
          ),
        );
        if (input.gate) await consoleGate;
        if (input.exitBeforeReady)
          return { status: "exited", exitCode: 1, signal: null };
        await options.onEvent({
          type: "terminal.ready",
          terminalId: command.terminalId,
        });
        if (input.exitAfterReady)
          return { status: "exited", exitCode: 1, signal: null };
        return finished;
      }
      if (command.type === "terminal.detach") {
        attachments.get(command.attachmentId)?.();
        return { status: "detached" };
      }
      throw new Error("Unexpected preparation worker command " + command.type);
    },
  };
  const routing = createModelRoutingRuntime({
    repository,
    bridge,
    app: { log: {} },
    applicationOwnerId: () => input.owner,
    openRouterRuntimeCatalogs: { hydrate: async () => false },
    publishLiveInvalidation() {},
    publishProjectTokenUsageChange() {},
    routeCooldowns: new Map(),
    runtimeCooldownKey: (r) => r.routeId,
  });
  const preparation = createManagedChatPreparation({
    ...routing,
    repository,
    bridge,
    serverId: "preparation-server",
    runAsOwner: (_owner, run) => run(),
    interruptLiveAgentInteractionRequests: (...args) =>
      repository.interruptAgentInteractionRequests(...args),
    publish: (ownerId, chatId) =>
      publications.push({
        ownerId,
        scope: { kind: "chat", chatId },
        resource: "chat-preparation",
        action: "invalidated",
        entityId: null,
        revision: null,
        payload: null,
      }),
  });
  let joinError = null,
    joinBeforeConsoleReady = null,
    phaseBeforeConsoleReady = null;
  try {
    await preparation.request(input.owner, input.chat);
    if (input.gate) {
      await seen;
      await preparation.request(input.owner, input.chat);
      let joined = false;
      const join = preparation
        .join(input.owner, input.chat)
        .then(() => (joined = true));
      assert(!joined, "GUI join must await thread preparation");
      releaseThread();
      await join;
      joinBeforeConsoleReady = joined;
      phaseBeforeConsoleReady = (
        await repository.managedChatPreparations.get(input.owner, input.chat)
      ).phase;
      releaseConsole();
    } else {
      try {
        await preparation.join(input.owner, input.chat);
      } catch (error) {
        joinError = error.message;
      }
    }
    await preparation.settle(input.owner, input.chat);
    if (input.retry) {
      fail = null;
      await preparation.request(input.owner, input.chat);
      await preparation.settle(input.owner, input.chat);
    }
    if (input.reconnect) {
      await preparation.workerConnected(input.owner, input.worker);
      await preparation.settle(input.owner, input.chat);
    }
    const state = await repository.managedChatPreparations.get(
      input.owner,
      input.chat,
    );
    const terminal = state
      ? await repository.getTerminalExecutionContext(
          input.owner,
          state.terminalId,
        )
      : null;
    return {
      state,
      terminal,
      calls,
      publications,
      joinError,
      joinBeforeConsoleReady,
      phaseBeforeConsoleReady,
    };
  } finally {
    releaseThread();
    releaseConsole();
  }
}
function assert(value, message) {
  if (!value) throw new Error(message);
}
