import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CANTRIP_MCP_OPERATIONS,
  type CantripMcpBinding,
  type CantripAgentOperationRequest,
} from "@cantrip/protocol";
import { executeCantripMcpChatOperation } from "../../../cantrip_worker/src/mcp/chat-operations.js";
import {
  openMessage,
  protectChatMessage,
  openEncryptedChatTurn,
} from "../../../cantrip_worker/src/chat-message-encryption.js";
import { createManagedQueueInputCodec } from "../../../cantrip_worker/src/managed-queue-input.js";
import { encodePrivateDisplayLabelForWorker } from "../../../cantrip_worker/src/private-label-encryption.js";
import type { WorkerEncryptionService } from "../../../cantrip_worker/src/worker-encryption.js";
import { createAgentChatOperations } from "../src/agent-tools/chat-operations.js";
import { LOCAL_USER_ID as owner } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { createNativeSettingsFixture } from "./native-settings-repository-fixture.js";

const key = new Uint8Array(32).fill(19);
const encryption = {
  ownerId: () => owner,
  serverIdentity: () => "server",
  componentKey: () => ({ key: key.slice(), keyRevision: 1 }),
  status: () => ({ error: null }),
} as unknown as WorkerEncryptionService;
let f: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
let target: string;
let binding: CantripMcpBinding;
const publish = vi.fn();
const dispatch = vi.fn(async () => {});
const relays: CantripAgentOperationRequest[] = [];
function server() {
  return createAgentChatOperations({
    applicationOwnerId: () => owner,
    repository: f.repository,
    publishEncryptedChatMessage: publish,
    dispatchNextQueuedPrompt: dispatch,
  });
}
async function invoke(
  operation: CantripAgentOperationRequest["operation"],
  args: Record<string, unknown>,
) {
  return executeCantripMcpChatOperation({
    binding,
    service: encryption,
    requestId: randomUUID(),
    request: { operation, arguments: args },
    execute: async (_binding, request) => {
      relays.push(request);
      const context = (await f.repository.getChatExecutionContext(
        owner,
        f.chatId,
      ))!;
      return server()(context, request);
    },
  });
}
beforeAll(async () => {
  f = await createNativeSettingsFixture();
  const source = (await f.repository.getChatExecutionContext(owner, f.chatId))!;
  if (source.contextKind !== "project")
    throw new Error("Project fixture required");
  const [model] = await f.db.select().from(schema.modelProfiles).limit(1);
  const title = (id: string, label: string) =>
    encodePrivateDisplayLabelForWorker({
      ownerId: owner,
      rowId: id,
      label,
      recordKind: "chat",
      service: encryption,
    });
  await f.db
    .update(schema.chats)
    .set({ protectedLabel: await title(f.chatId, "Main") })
    .where(eq(schema.chats.id, f.chatId));
  target = randomUUID();
  await f.repository.createChat(owner, source.projectId, {
    id: target,
    titleProtection: await title(target, "Fixer"),
    worktreeMode: "agent-managed",
  });
  await f.repository.setChatModelConfiguration(owner, target, {
    modelId: model!.id,
    reasoningEffort: null,
    customSubagentModel: false,
    subagentModelId: null,
    subagentReasoningEffort: null,
  });
  binding = {
    bindingId: randomUUID(),
    ownerId: owner,
    contextKind: "project",
    projectId: source.projectId,
    chatId: f.chatId,
    workerId: f.workerId,
    executionLaneId: "lane",
    worktreeId: source.worktreeId,
    rootKind: source.rootKind,
    scratchRootId: null,
    permissionProfileId: ":workspace",
    allowedOperations: [...CANTRIP_MCP_OPERATIONS],
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}, 60_000);
afterAll(async () => {
  await f?.close();
});

describe.sequential(
  "protected agent chat tools through the real repository and queue",
  () => {
    it("lists decrypted chat names and supports pagination without plaintext on the relay", async () => {
      const result = await invoke("chat.list", { limit: 1 });
      expect((result.data as any).chats).toHaveLength(1);
      expect((result.data as any).chats[0].title).toBe("Main");
      expect((result.data as any).nextCursor).toBe(1);
      const next = await invoke("chat.list", { cursor: 1 });
      expect((next.data as any).chats[0]).toMatchObject({
        id: target,
        title: "Fixer",
      });
    });
    it("delivers both visible transcript records, queues once, preserves pause, and protects provenance", async () => {
      await f.repository.setChatAutomationPaused(owner, target, true);
      const operationId = randomUUID();
      const message =
        "PRIVATE_AGENT_MESSAGE: please review the queue implementation";
      const result = await invoke("chat.send", {
        chatId: target,
        operationId,
        message,
      });
      expect(result.mutated).toBe(true);
      expect((result.data as any).targetTitle).toBe("Fixer");
      expect(
        (await f.repository.getChatExecutionContext(owner, target))
          ?.automationPaused,
      ).toBe(true);
      const queue = await f.repository.listEncryptedQueuedPrompts(
        owner,
        target,
      );
      expect(queue).toHaveLength(1);
      const received = await f.repository.listEncryptedMessages(owner, target);
      const sent = await f.repository.listEncryptedMessages(owner, f.chatId);
      expect(received).toHaveLength(1);
      expect(sent).toHaveLength(1);
      const content = await openMessage({
        componentKey: key,
        message: received[0]!,
        ownerId: owner,
      });
      expect(content[0]).toMatchObject({
        text: message,
        chatCommunication: {
          sourceTitle: "Main",
          targetTitle: "Fixer",
          direction: "received",
        },
      });
      const outgoing = await openMessage({
        componentKey: key,
        message: sent[0]!,
        ownerId: owner,
      });
      expect(outgoing[0]).toMatchObject({
        text: message,
        chatCommunication: { direction: "sent" },
      });
      const modelInput = await openEncryptedChatTurn({
        history: [],
        prompt: queue[0]!.pendingMessage,
        service: encryption,
        threadId: "recipient-native-thread",
      });
      expect(modelInput).toContain("another agent, not the human user");
      const codec = createManagedQueueInputCodec({
        encryption,
        chatId: target,
        defaults: () => ({
          mode: "default",
          modelId: queue[0]!.modelId,
          reasoningEffort: null,
          worktreeId: null,
        }),
      });
      const projected = await codec.openPrompt(queue[0]!);
      expect(JSON.stringify(projected.input)).toContain(
        "another agent, not the human user",
      );
      expect(JSON.stringify(queue)).not.toContain(message);
      expect(JSON.stringify(relays)).not.toContain(message);
      expect(JSON.stringify(relays)).not.toContain('"Main"');
      expect(publish).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenCalledWith(target);
      await invoke("chat.send", { chatId: target, operationId, message });
      expect(
        await f.repository.listEncryptedQueuedPrompts(owner, target),
      ).toHaveLength(1);
      expect(
        await f.repository.listEncryptedMessages(owner, target),
      ).toHaveLength(1);
      expect(
        await f.repository.listEncryptedMessages(owner, f.chatId),
      ).toHaveLength(1);
    });
    it("reads bounded text with agent attribution and waits for real status or streaming changes", async () => {
      const read = await invoke("chat.read", {
        chatId: target,
        maxChars: 10,
        limit: 1,
      });
      expect((read.data as any).messages[0]).toMatchObject({
        role: "agent",
        text: "PRIVATE_AG",
      });
      expect((read.data as any).truncated).toBe(true);
      const unchanged = await invoke("chat.wait", {
        chatId: target,
        afterCursor: (read.data as any).cursor,
        timeoutMs: 0,
      });
      expect((unchanged.data as any).timedOut).toBe(true);
      await f.repository.setChatAutomationPaused(owner, target, false);
      const changed = await invoke("chat.wait", {
        chatId: target,
        afterCursor: (read.data as any).cursor,
        timeoutMs: 0,
      });
      expect((changed.data as any).timedOut).toBe(false);
      expect((changed.data as any).chat.automationPaused).toBe(false);
    });
    it("rejects unknown, archived, self, or foreign chat IDs and user-selected native actions", async () => {
      await expect(
        invoke("chat.read", { chatId: randomUUID() }),
      ).rejects.toThrow("current project");
      await expect(
        invoke("chat.send", {
          chatId: f.chatId,
          operationId: randomUUID(),
          message: "self",
        }),
      ).rejects.toThrow("another chat");
      const previous = relays.find(
        (request) => request.operation === "chat.send",
      )!;
      const context = (await f.repository.getChatExecutionContext(
        owner,
        f.chatId,
      ))!;
      const malicious = structuredClone(previous);
      (malicious.arguments.turn as any).queuedPrompt.nativeAction = "runShell";
      await expect(server()(context, malicious)).rejects.toThrow(
        "delivery envelope",
      );
      await expect(
        server()({ ...context, projectId: "foreign-project" } as any, previous),
      ).rejects.toThrow("sending chat");
      await f.db
        .update(schema.chats)
        .set({ archivedAt: new Date() })
        .where(eq(schema.chats.id, target));
      await expect(invoke("chat.read", { chatId: target })).rejects.toThrow(
        "current project",
      );
      await f.db
        .update(schema.chats)
        .set({ archivedAt: null })
        .where(eq(schema.chats.id, target));
    });
    it("rolls back the queue and recipient copy when saving the outgoing message fails", async () => {
      const before = await f.repository.listEncryptedQueuedPrompts(
        owner,
        target,
      );
      const original = f.repository.agentChatDelivery.transaction.bind(
        f.repository.agentChatDelivery,
      );
      const injected = vi
        .spyOn(f.repository.agentChatDelivery, "transaction")
        .mockImplementation((ownerId, sourceId, targetId, apply) =>
          original(ownerId, sourceId, targetId, async (repository) => {
            const append = repository.appendEncryptedMessage.bind(repository);
            repository.appendEncryptedMessage = async (...args) => {
              if (args[1] === sourceId)
                throw new Error("Simulated source write failure");
              return append(...args);
            };
            return apply(repository);
          }),
        );
      try {
        await expect(
          invoke("chat.send", {
            chatId: target,
            operationId: randomUUID(),
            message: "ROLLBACK_MESSAGE",
          }),
        ).rejects.toThrow("source write failure");
      } finally {
        injected.mockRestore();
      }
      expect(
        await f.repository.listEncryptedQueuedPrompts(owner, target),
      ).toHaveLength(before.length);
      expect(
        await f.repository.listEncryptedMessages(owner, target),
      ).toHaveLength(1);
    });
    it("retains attribution and deduplication after repository restart", async () => {
      const request = relays.find(
        (request) => request.operation === "chat.send",
      )!;
      await f.restart();
      const context = (await f.repository.getChatExecutionContext(
        owner,
        f.chatId,
      ))!;
      await server()(context, request);
      expect(
        await f.repository.listEncryptedMessages(owner, target),
      ).toHaveLength(1);
      const read = await invoke("chat.read", { chatId: target });
      expect((read.data as any).messages[0].chatCommunication.sourceTitle).toBe(
        "Main",
      );
    });
    it("uses the configured default for older chats without an explicit model", async () => {
      const context = (await f.repository.getChatExecutionContext(
        owner,
        target,
      ))!;
      await f.db
        .update(schema.chats)
        .set({ modelId: null })
        .where(eq(schema.chats.id, target));
      const listed = await invoke("chat.list", {});
      expect(
        (listed.data as any).chats.find((chat: any) => chat.id === target)
          .modelId,
      ).toBeTruthy();
      await f.db
        .update(schema.chats)
        .set({ modelId: context.modelId })
        .where(eq(schema.chats.id, target));
    });
    it("wakes a bounded wait on an in-place message revision without a new sequence", async () => {
      const before = await invoke("chat.read", { chatId: target });
      const [receipt] = await f.repository.listEncryptedMessages(owner, target);
      const content = await openMessage({
        componentKey: key,
        message: receipt!,
        ownerId: owner,
      });
      const edited = await protectChatMessage({
        id: receipt!.id,
        service: encryption,
        message: {
          role: receipt!.role,
          mode: "default",
          idempotencyKey: `agent-chat:${f.chatId}:${target}:${(content[0] as any).chatCommunication.deliveryId}:received`,
          content: [
            { ...(content[0] as any), text: "Revised protected delivery text" },
          ],
        },
      });
      const waiting = invoke("chat.wait", {
        chatId: target,
        afterCursor: (before.data as any).cursor,
        timeoutMs: 2000,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await f.repository.upsertEncryptedMessage(owner, target, edited);
      const result = await waiting;
      expect((result.data as any).timedOut).toBe(false);
      expect((result.data as any).messages[0].sequence).toBe(receipt!.sequence);
      expect((result.data as any).messages[0].text).toBe(
        "Revised protected delivery text",
      );
    });
    it("keeps the delivery receipt separate from the pending input and deduplicates it once execution starts", async () => {
      const [prompt] = await f.repository.listEncryptedQueuedPrompts(
        owner,
        target,
      );
      const [receipt] = await f.repository.listEncryptedMessages(owner, target);
      expect(receipt!.role).toBe("assistant");
      expect(prompt!.pendingMessage.id).not.toBe(receipt!.id);
      await f.repository.appendEncryptedMessage(
        owner,
        target,
        prompt!.pendingMessage,
      );
      const read = await invoke("chat.read", { chatId: target });
      expect((read.data as any).messages).toHaveLength(1);
      expect((read.data as any).messages[0]).toMatchObject({
        role: "agent",
        chatCommunication: { sourceTitle: "Main" },
      });
    });
    it("spends a bounded read on the newest messages instead of hiding them behind older text", async () => {
      await invoke("chat.send", {
        chatId: target,
        operationId: randomUUID(),
        message: "LATEST_REPLY ready for review",
      });
      const read = await invoke("chat.read", { chatId: target, maxChars: 8 });
      const messages = (read.data as any).messages;
      expect(messages.at(-1).text).toBe("LATEST_R");
      expect(
        messages.map((message: any) => message.text).join(""),
      ).toHaveLength(8);
      expect((read.data as any).truncated).toBe(true);
    });
    it("does not let unavailable display-label ciphertext block valid chat access", async () => {
      const [row] = await f.db
        .select()
        .from(schema.chats)
        .where(eq(schema.chats.id, target));
      const corrupt = structuredClone(row!.protectedLabel!);
      corrupt.protectedLabel.envelope.ciphertext = "A".repeat(43);
      await f.db
        .update(schema.chats)
        .set({ protectedLabel: corrupt })
        .where(eq(schema.chats.id, target));
      try {
        const result = await invoke("chat.read", { chatId: target });
        expect((result.data as any).chat.title).toBe(`Agent ${target}`);
        expect((result.data as any).messages.at(-1).text).toBe(
          "LATEST_REPLY ready for review",
        );
      } finally {
        await f.db
          .update(schema.chats)
          .set({ protectedLabel: row!.protectedLabel })
          .where(eq(schema.chats.id, target));
      }
    });
  },
);
