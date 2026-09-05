import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createComputerUseActivityPublisher } from "../src/app/routes/computer-use-activity.js";

function fixture(domain: "chat" | "task" = "chat") {
  const operationId = randomUUID();
  const event = {
    type: "computer-use.activity",
    operationId,
    event: {
      type:
        domain === "chat"
          ? "agent.protected-message"
          : "agent.protected-task-message",
      telemetry: {
        kind: "activity",
        activityType: "computerUse",
        turnId: null,
      },
      message: {
        id: randomUUID(),
        classification: {
          role: "assistant",
          mode: "default",
          attachmentIds: [],
        },
        protectedContent: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: {
            version: 1,
            algorithm: "AES-256-GCM",
            keyRevision: 1,
            nonce: Buffer.alloc(12).toString("base64url"),
            ciphertext: Buffer.alloc(16).toString("base64url"),
          },
        },
        reasoningEffort: null,
        idempotencyKey: `computer-use:${operationId}`,
      },
    },
  };
  const chat = vi.fn(async () => ({ id: "saved-chat" }));
  const task = vi.fn(async () => ({ id: "saved-task" }));
  const asOwner = vi.fn((_owner: string, work: () => unknown) => work());
  const publish = createComputerUseActivityPublisher({
    ownerId: "owner",
    chatId: "chat",
    operationId,
    contentDomain: domain,
    upsertLiveEncryptedChatMessage: chat,
    upsertLiveTaskMessage: task,
    runAsOwner: asOwner as <T>(owner: string, work: () => T) => T,
  });
  return { event, publish, chat, task, asOwner };
}

describe("protected computer-use activity admission", () => {
  it.each(["chat", "task"] as const)(
    "persists one opaque %s activity under the authenticated owner and chat",
    async (domain) => {
      const f = fixture(domain);
      await f.publish(f.event);
      expect(
        domain === "chat" ? f.chat : f.task,
      ).toHaveBeenCalledExactlyOnceWith("owner", "chat", f.event.event.message);
      expect(domain === "chat" ? f.task : f.chat).not.toHaveBeenCalled();
      expect(f.asOwner).toHaveBeenCalledOnce();
      await expect(f.publish(f.event)).rejects.toThrow();
    },
  );

  it.each([
    "operation",
    "domain",
    "kind",
    "activityType",
    "turn",
    "role",
    "attachments",
  ])("rejects mismatched %s before persistence", async (field) => {
    const f = fixture();
    if (field === "operation") f.event.operationId = randomUUID();
    if (field === "domain") f.event.event.type = "agent.protected-task-message";
    if (field === "kind") f.event.event.telemetry.kind = "usage";
    if (field === "activityType")
      f.event.event.telemetry.activityType = "command";
    if (field === "turn")
      Object.assign(f.event.event.telemetry, { turnId: "borrowed-agent-turn" });
    if (field === "role") f.event.event.message.classification.role = "user";
    if (field === "attachments")
      Object.assign(f.event.event.message.classification, {
        attachmentIds: [randomUUID()],
      });
    await expect(f.publish(f.event)).rejects.toThrow();
    expect(f.chat).not.toHaveBeenCalled();
    expect(f.task).not.toHaveBeenCalled();
  });

  it("does not report success when durable insertion rejects", async () => {
    const f = fixture();
    f.chat.mockRejectedValue(new Error("synthetic insert failure"));
    await expect(f.publish(f.event)).rejects.toThrow(
      "synthetic insert failure",
    );
  });
});
