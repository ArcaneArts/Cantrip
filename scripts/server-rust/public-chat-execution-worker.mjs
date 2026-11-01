// Existing worker encryption/session/client code around a controlled model.
// All admission, dispatch and settlement use the actual server HTTP endpoints.
import assert from "node:assert/strict";
import { ManagedNativeCommandSession } from "../../cantrip_worker/src/codex/managed-native-command-session.ts";
import { NativeCommandClient } from "../../cantrip_worker/src/native-command-client.ts";
import { createManagedQueueInputCodec } from "../../cantrip_worker/src/managed-queue-input.ts";
import {
  openEncryptedChatTurn,
  encryptChatTurnResult,
  protectChatMessage,
} from "../../cantrip_worker/src/chat-message-encryption.ts";

export function publicExecutionWorker() {
  let fixture, nextGate, nextPause, nextPauseGate;
  const adapters = new Map(),
    gates = new Set(),
    turns = [],
    controls = [],
    pauses = [],
    acknowledgments = [],
    queueChanges = [],
    requests = [],
    failures = [];
  function session(command) {
    return {
      chatId: command.chatId,
      threadId: command.threadId ?? "thread",
      contextKind: command.contextKind ?? "project",
      projectId: command.policyProjectId ?? fixture.scope.projectId,
      placementId: command.worktreeId ?? fixture.scope.placementId,
      modelRouteId: command.model?.routeId ?? "public-route",
      providerAccountId: command.provider?.accountId ?? null,
      runtimeGeneration: "public-http-runtime",
      connectionId: `gui:${command.nativeCommandReceipt?.operationGeneration ?? "control"}`,
    };
  }
  function adapter(command, encryption) {
    if (!adapters.has(command.chatId)) {
      const identity = session(command);
      const client = new NativeCommandClient({
        serverUrl: fixture.fixture.server.origin,
        workerId: fixture.scope.workerId,
        token: () => fixture.credential,
        fetch: async (...args) => {
          const response = await fetch(...args);
          requests.push({
            path: new URL(args[0]).pathname,
            status: response.status,
          });
          return response;
        },
      });
      const runtime = { transportGeneration: identity.runtimeGeneration };
      const value = new ManagedNativeCommandSession({
        identity: {
          serverId: fixture.serverId,
          ownerId: fixture.owner,
          workerId: fixture.scope.workerId,
          chatId: identity.chatId,
          contextKind: identity.contextKind,
          projectId: identity.projectId,
          placementId: identity.placementId,
        },
        runtime,
        client,
        encryption,
        policy: {
          cwd: "/worker-owned/settings",
          codexHome: "/controlled-public-runtime",
          permissionProfileId: ":workspace",
          security: {
            permissions: ":workspace",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
          },
        },
        beginExecution: async () => {
          throw new Error(
            "Controlled public fixture does not admit autonomous model execution",
          );
        },
        onError: (error, operationId) =>
          failures.push({ message: error.message, operationId }),
      });
      adapters.set(command.chatId, { value, client, session: identity });
    }
    return adapters.get(command.chatId);
  }
  function codec(encryption, chatId) {
    return createManagedQueueInputCodec({
      encryption,
      chatId,
      defaults: () => ({
        mode: "default",
        modelId: "public-model",
        reasoningEffort: null,
        worktreeId: fixture.scope.placementId,
      }),
    });
  }
  return {
    turns,
    controls,
    pauses,
    acknowledgments,
    queueChanges,
    requests,
    failures,
    attach(value) {
      fixture = value;
    },
    failNextPause(mode) {
      nextPause = mode;
    },
    holdNextPause() {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      const gate = { promise, release, dispatched: false };
      nextPauseGate = gate;
      gates.add(gate);
      return gate;
    },
    holdNext() {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      const gate = { promise, release, dispatched: false };
      nextGate = gate;
      gates.add(gate);
      return gate;
    },
    releaseAll() {
      for (const gate of gates) gate.release();
      gates.clear();
    },
    async drained() {
      const done = () =>
        turns.every(
          ({ command, finished }) =>
            finished &&
            (!command.nativeCommandReceipt ||
              acknowledgments.some(
                (ack) =>
                  ack.rootOperationId ===
                    command.nativeCommandReceipt.operationId &&
                  ack.rootOperationGeneration ===
                    command.nativeCommandReceipt.operationGeneration,
              )),
        );
      const deadline = Date.now() + 15000;
      while (!done() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(
        done(),
        "controlled turns finish their real receipts and logical acknowledgments before fixture teardown",
      );
    },
    codec(encryption, chatId) {
      return codec(encryption, chatId);
    },
    async handle(command, emit, { encryption }) {
      if (command.type === "chat.queue.changed") {
        queueChanges.push(command);
        return null;
      }
      if (command.type === "chat.thread.ensure") return { threadId: "thread" };
      if (command.type === "chat.goal.get") return { goal: null };
      if (command.type === "chat.pause.set") {
        const mode = nextPause;
        const gate = nextPauseGate;
        nextPause = undefined;
        nextPauseGate = undefined;
        pauses.push({ command, mode: mode ?? "acknowledge" });
        if (gate) {
          gate.dispatched = true;
          await gate.promise;
          gates.delete(gate);
        }
        if (mode === "reject")
          throw new Error("Controlled worker pause failure");
        return {
          paused: mode === "opposite" ? !command.paused : command.paused,
          active: null,
        };
      }
      if (command.type === "chat.turn.rollback") return { rolledBack: true };
      if (command.type === "chat.message.protect")
        return protectChatMessage({
          id: command.message.id,
          message: command.message,
          service: encryption,
        });
      if (command.type === "chat.queue.prepare")
        return codec(encryption, command.chatId).normalizePrompt(
          command.prompt,
        );
      if (command.type === "chat.native-logical.complete") {
        adapters
          .get(command.chatId)
          ?.value.completeGuiLogical(
            command.rootOperationId,
            command.rootOperationGeneration,
          );
        acknowledgments.push(command);
        return null;
      }
      if (
        command.type === "chat.native-control" ||
        command.type === "chat.steer"
      ) {
        const prompt =
          command.control?.protectedPrompt ?? command.protectedPrompt;
        const opened = await openEncryptedChatTurn({
          prompt,
          history: [],
          threadId: command.threadId,
          service: encryption,
        });
        assert.ok(opened.startsWith("private-public-chat-"));
        controls.push(command);
        if (command.type === "chat.native-control") {
          const entry = adapters.get(command.chatId);
          assert.ok(entry, "native steer uses an existing worker session");
          await entry.value.withExpectedActivationGeneration(
            command.nativeActivationGeneration,
            () =>
              entry.value.executeGuiCommand(entry.session, {
                method: "turn/steer",
                operationId: command.operationId,
                queueClaim: command.queueClaim,
                params: {
                  threadId: command.threadId,
                  input: [{ type: "text", text: opened }],
                  clientUserMessageId: command.nativeClientUserMessageId,
                },
                dispatch: async () => ({ turnId: "public-held-turn" }),
              }),
          );
        }
        return null;
      }
      if (command.type !== "chat.turn") return undefined;
      const gate = nextGate;
      nextGate = undefined;
      const record = { command, completed: false };
      turns.push(record);
      try {
        const opened = await openEncryptedChatTurn({
          prompt: command.protectedPrompt,
          history: command.protectedHistory,
          threadId: command.threadId,
          service: encryption,
        });
        assert.ok(opened.startsWith("private-public-chat-"));
        let entry;
        if (command.nativeCommandReceipt) {
          entry = adapter(command, encryption);
          entry.session = session(command);
          await entry.client.bindPreparation({
            operationId: command.nativeCommandReceipt.operationId,
            operationGeneration:
              command.nativeCommandReceipt.operationGeneration,
            payloadDigest: command.nativeCommandReceipt.payloadDigest,
            session: entry.session,
          });
          await entry.value.dispatchGui(
            command.nativeCommandReceipt,
            entry.session,
          );
        }
        if (gate) {
          gate.dispatched = true;
          await gate.promise;
          gates.delete(gate);
        }
        const turnId = "public-turn-" + turns.length;
        if (entry)
          await entry.value.guiReceipt(
            command.nativeCommandReceipt,
            entry.session,
            { turn: { id: turnId } },
          );
        const result = await encryptChatTurnResult({
          service: encryption,
          messageId: command.resultMode.messageId,
          idempotencyKey: command.resultMode.idempotencyKey,
          result: {
            threadId: command.threadId ?? "thread",
            turnId,
            status: "completed",
            text: "private-public-chat-answer",
          },
        });
        if (entry)
          entry.value.markGuiFinished(
            command.nativeCommandReceipt.operationId,
            command.nativeCommandReceipt.operationGeneration,
          );
        record.completed = true;
        return result;
      } finally {
        record.finished = true;
      }
    },
  };
}
