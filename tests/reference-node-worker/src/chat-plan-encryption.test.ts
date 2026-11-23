import { decryptChatPlanProtectedContent } from "@cantrip/crypto";
import { describe, expect, it } from "vitest";

import { protectChatPlanState } from "./chat-plan-encryption.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

describe("worker chat Plan Mode encryption", () => {
  it("protects semantic plan state before emitting it", async () => {
    const ownerId = "owner-chat-plan";
    const componentKey = new Uint8Array(32).fill(9);
    const service = {
      ownerId: () => ownerId,
      componentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision: 1,
      }),
    } as unknown as WorkerEncryptionService;
    const protectedState = await protectChatPlanState({
      chatId: "chat-one",
      service,
      state: {
        explanation: "SENTINEL worker-only plan",
        steps: [{ step: "Seal it", status: "completed" }],
        question: null,
      },
    });

    expect(JSON.stringify(protectedState)).not.toContain("SENTINEL");
    await expect(
      decryptChatPlanProtectedContent({
        ownerId,
        chatId: "chat-one",
        keyRevision: 1,
        componentKey,
        encrypted: protectedState.protectedContent,
        publicClassification: protectedState.classification,
      }),
    ).resolves.toMatchObject({
      explanation: "SENTINEL worker-only plan",
      steps: [{ step: "Seal it", status: "completed" }],
      question: null,
    });
  });
});
