// Controlled model responses over the real worker transport. Cryptography uses
// the unchanged worker/crypto implementation, never a server-side plaintext path.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { protectChatMessage } from "../../cantrip_worker/src/chat-message-encryption.ts";
import { taskMessageOpaqueContentSchema } from "../../packages/protocol/dist/index.js";
import {
  encryptTaskProtectedContent,
  decryptTaskProtectedContent,
  encryptTaskGoalObjective,
  decryptTaskGoalObjective,
  encryptTaskMessageProtectedContent,
  decryptTaskMessageProtectedContent,
  decryptChatMessageProtectedContent,
} from "../../packages/crypto/dist/index.js";
import { componentKey } from "./native-settings-http-fixture.mjs";
import { taskContent } from "./task-wire-fixtures.mjs";
import { dashboardPullRequest } from "./task-dashboard-fixtures.mjs";

export const goalMarker = "private-task-dashboard-goal-content";
export const ordinaryObjective = "Controlled ordinary Goal";
export function dashboardGoalWorker({ inferenceProgress } = {}) {
  const protectedTasks = new Map(),
    objectives = new Map(),
    messages = new Map();
  const proved = new Set(),
    commands = [],
    turns = [],
    resumeMessages = new Map();
  let mode = "normal",
    prMode = "normal",
    held,
    turnGate;
  const goal = (threadId, status = "active") => ({
    threadId,
    objective: ordinaryObjective,
    status,
    tokenBudget: 1000,
    tokensUsed: 17,
    timeUsedSeconds: 3,
    createdAt: 1000,
    updatedAt: 2000,
  });
  async function protectTask(owner, chat, content) {
    const protectedContent = await encryptTaskProtectedContent({
      ownerId: owner,
      chatId: chat,
      keyRevision: 1,
      componentKey,
      content,
    });
    protectedTasks.set(JSON.stringify(protectedContent), content);
    return { classification: content.classification, protectedContent };
  }
  async function proveTask(owner, chat, task) {
    const key = JSON.stringify(task.protectedContent);
    assert.ok(protectedTasks.has(key), "exact admitted Task ciphertext");
    const classification =
      task.classification ??
      Object.fromEntries(
        Object.keys(taskContent().classification).map((key) => [
          key,
          task[key],
        ]),
      );
    const content = await decryptTaskProtectedContent({
      ownerId: owner,
      chatId: chat,
      keyRevision: 1,
      componentKey,
      encrypted: task.protectedContent,
      publicClassification: classification,
    });
    assert.deepEqual(content, protectedTasks.get(key));
    proved.add(key);
    return content;
  }
  async function proveObjective(owner, value) {
    const classification = {
      chatId: value.chatId,
      threadId: value.threadId,
      status: value.status,
    };
    const content = await decryptTaskGoalObjective({
      ownerId: owner,
      ...classification,
      keyRevision: 1,
      componentKey,
      encrypted: value.protectedObjective,
      publicClassification: classification,
    });
    assert.equal(content.objective, goalMarker);
    proved.add(JSON.stringify(value.protectedObjective));
  }
  async function proveMessage(owner, value, task) {
    const input = {
      ownerId: owner,
      messageId: value.id,
      keyRevision: 1,
      componentKey,
      encrypted: value.protectedContent,
      publicClassification: value.classification,
    };
    const content = await (
      task
        ? decryptTaskMessageProtectedContent
        : decryptChatMessageProtectedContent
    )(input);
    assert.ok(
      messages.has(JSON.stringify(value.protectedContent)),
      "worker admitted encrypted message",
    );
    assert.deepEqual(
      content,
      messages.get(JSON.stringify(value.protectedContent)),
    );
    proved.add(JSON.stringify(value.protectedContent));
    return content;
  }
  function redact(value) {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => {
          if (
            ["protectedContent", "protectedObjective"].includes(key) &&
            child
          ) {
            // protectedObjective can itself be an opaque Chat message.
            if (key === "protectedObjective" && child.classification)
              return [key, redact(child)];
            assert.ok(
              proved.has(JSON.stringify(child)),
              "only independently decrypted ciphertext is normalized",
            );
            return [key, "<verified endpoint ciphertext>"];
          }
          return [key, redact(child)];
        }),
      );
    return value;
  }
  return {
    commands,
    turns,
    protectedTasks,
    proved,
    protectTask,
    proveTask,
    proveObjective,
    proveMessage,
    redact,
    mode(value) {
      mode = value;
    },
    prMode(value) {
      prMode = value;
    },
    holdClosed() {
      let release;
      held = {
        requested: false,
        settled: false,
        promise: new Promise((resolve) => {
          release = resolve;
        }),
      };
      held.release = release;
      return held;
    },
    holdTurn() {
      let release;
      turnGate = {
        promise: new Promise((resolve) => {
          release = resolve;
        }),
        requested: false,
        settled: false,
      };
      turnGate.release = release;
      return turnGate;
    },
    releaseAll() {
      held?.release();
      turnGate?.release();
    },
    async handle(command, emit, { owner, encryption }) {
      if (command.type === "chat.thread.ensure")
        return { threadId: command.threadId ?? "thread" };
      if (command.type === "chat.message.protect") {
        const result = await protectChatMessage({
          id: command.message.id,
          message: command.message,
          service: encryption,
        });
        const content = await decryptChatMessageProtectedContent({
          ownerId: owner,
          messageId: result.id,
          keyRevision: 1,
          componentKey,
          encrypted: result.protectedContent,
          publicClassification: result.classification,
        });
        messages.set(JSON.stringify(result.protectedContent), content);
        await proveMessage(owner, result, false);
        return result;
      }
      if (command.type === "github.pull-requests.list") {
        commands.push(structuredClone(command));
        assert.equal(command.repository, "fixture/repository");
        assert.equal(command.limit, 100);
        assert.equal(command.cursor, null);
        const admittedMode = prMode;
        if (command.state === "closed" && held) {
          const current = held;
          current.requested = true;
          await current.promise;
          current.settled = true;
          held = undefined;
        }
        if (admittedMode === "early-failure" && command.state === "open")
          throw new Error("Controlled PR failure");
        if (admittedMode === "long-error")
          throw new Error("x".repeat(1999) + "😀" + "tail");
        if (admittedMode === "invalid")
          return {
            state: command.state,
            total: -1,
            pullRequests: [],
            nextCursor: null,
          };
        const pullRequests =
          command.state === "open"
            ? [
                dashboardPullRequest(1),
                dashboardPullRequest(2),
                dashboardPullRequest(3, { headRef: "old-branch" }),
                dashboardPullRequest(4, { headRef: "unrelated" }),
              ]
            : [
                dashboardPullRequest(5, {
                  headRef: "old-branch",
                  state: "closed",
                  merged: true,
                  closedAt: "2026-10-25T00:00:00.000Z",
                }),
                dashboardPullRequest(6, { state: "closed", merged: false }),
              ];
        return {
          state: command.state,
          total: pullRequests.length,
          pullRequests,
          nextCursor: null,
        };
      }
      if (
        [
          "chat.goal.get",
          "chat.goal.update",
          "chat.goal.clear",
          "chat.goal.create",
        ].includes(command.type)
      ) {
        commands.push(structuredClone(command));
        if (mode === "error")
          throw new Error(
            command.chatId === "22222222-2222-4222-8222-222222222222"
              ? "Controlled ordinary Goal failure"
              : goalMarker,
          );
        if (mode === "invalid") return { goal: "invalid Goal" };
        if (command.type === "chat.goal.clear")
          return { cleared: true, ignored: "stripped" };
        if (command.type === "chat.goal.create") {
          assert.equal(command.objective, ordinaryObjective);
          assert.match(command.operationId, /^gui-goal:[0-9a-f-]{36}$/);
          assert.ok(command.session);
          return { goal: goal(command.threadId) };
        }
        if (!command.taskContext) {
          const result = goal(command.threadId, command.status ?? "active");
          if (!command.protectObjective)
            return { goal: mode === "null" ? null : result };
          const id = randomUUID();
          const objective =
            command.protectedObjective ??
            (await protectChatMessage({
              id,
              message: {
                id,
                role: "user",
                mode: "goal",
                content: [{ type: "text", text: ordinaryObjective }],
                idempotencyKey: "goal-objective",
              },
              service: encryption,
            }));
          const content = await decryptChatMessageProtectedContent({
            ownerId: owner,
            messageId: objective.id,
            keyRevision: 1,
            componentKey,
            encrypted: objective.protectedContent,
            publicClassification: objective.classification,
          });
          messages.set(JSON.stringify(objective.protectedContent), content);
          await proveMessage(owner, objective, false);
          delete result.objective;
          return {
            kind: "chat-encrypted",
            goal:
              mode === "null"
                ? null
                : { ...result, protectedObjective: objective },
          };
        }
        let task = command.taskContext.task;
        const content = await proveTask(owner, command.chatId, task);
        const status =
          mode === "completed" ? "complete" : (command.status ?? "active");
        if (
          status === "complete" &&
          content.classification.state !== "complete"
        ) {
          content.classification.state = "complete";
          task = await protectTask(owner, command.chatId, content);
        }
        const classification = {
          chatId: mode === "wrong-chat" ? "unrelated-chat" : command.chatId,
          threadId:
            mode === "wrong-thread" ? "unrelated-thread" : command.threadId,
          status,
        };
        const key = JSON.stringify(classification);
        if (!objectives.has(key))
          objectives.set(
            key,
            await encryptTaskGoalObjective({
              ownerId: owner,
              chatId: classification.chatId,
              threadId: classification.threadId,
              keyRevision: 1,
              componentKey,
              content: { version: 1, classification, objective: goalMarker },
            }),
          );
        const snapshot = {
          ...classification,
          protectedObjective: objectives.get(key),
          tokenBudget: 1000,
          tokensUsed: 17,
          timeUsedSeconds: 3,
          createdAt: 1000,
          updatedAt: 2000,
        };
        await proveObjective(owner, snapshot);
        let message = null;
        if (command.taskContext.message) {
          const marker = command.taskContext.message;
          assert.equal(marker.kind, "resume");
          assert.match(marker.id, /^[0-9a-f-]{36}$/);
          assert.match(
            marker.idempotencyKey,
            /^task-goal-resume:[0-9a-f-]{36}$/,
          );
          assert.notEqual(
            marker.id,
            marker.idempotencyKey.slice("task-goal-resume:".length),
          );
          const classification = {
            role: "user",
            mode: "goal",
            attachmentIds: [],
          };
          const content = {
            version: 1,
            classification,
            content: [{ type: "text", text: goalMarker }],
          };
          const protectedContent = await encryptTaskMessageProtectedContent({
            ownerId: owner,
            messageId: marker.id,
            keyRevision: 1,
            componentKey,
            content,
          });
          messages.set(JSON.stringify(protectedContent), content);
          message = {
            id: marker.id,
            idempotencyKey: marker.idempotencyKey,
            classification,
            protectedContent,
            reasoningEffort: null,
          };
          await proveMessage(owner, message, true);
          resumeMessages.set(marker.id, structuredClone(message));
          if (mode === "wrong-message")
            message.idempotencyKey = "unrelated-message";
        }
        return {
          goal: mode === "null" ? null : snapshot,
          task,
          message,
          ...(mode === "wrong-execution"
            ? { execution: { threadId: "unrelated-thread", status: "idle" } }
            : {}),
        };
      }
      if (command.type === "chat.turn") {
        const message = resumeMessages.get(command.clientMessageId);
        assert.ok(
          message,
          "Goal resumes using the worker's admitted encrypted Task message",
        );
        assert.deepEqual(
          command.protectedTaskPrompt,
          taskMessageOpaqueContentSchema.parse(message),
          "Goal resumes with the exact admitted protected Task input",
        );
        const content = await proveMessage(
          owner,
          command.protectedTaskPrompt,
          true,
        );
        assert.equal(content.content[0].text, goalMarker);
        assert.equal(command.prompt, undefined);
        assert.equal(command.resultMode.kind, "task-message-encrypted");
        assert.equal(
          command.resultMode.idempotencyKey,
          `assistant:${message.id}`,
        );
        inferenceProgress?.emit(command, emit);
        turns.push(command);
        if (turnGate) {
          const current = turnGate;
          current.requested = true;
          await current.promise;
          current.settled = true;
          turnGate = undefined;
        }
        throw new Error("Controlled model completion boundary");
      }
      if (command.type === "chat.interrupt") return { interrupted: true };
      return undefined;
    },
  };
}
