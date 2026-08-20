import {
  clearSensitiveBytes,
  encryptChatPlanProtectedContent,
  generateAccountMasterKey,
} from "@cantrip/crypto";
import { describe, expect, it } from "vitest";

import type { ClientSessionContext } from "./client-session";
import { ClientEncryptionService } from "./client-encryption";
import { openEncryptedChatPlanWireState } from "./chat-plan-encryption";

const ownerId = "owner-chat-plan";
const serverId = "server-chat-plan";
const chatId = "chat-one";

function session(): ClientSessionContext {
  return { serverId, user: { id: ownerId } } as ClientSessionContext;
}

describe("ordinary chat Plan Mode encryption", () => {
  it("opens worker-protected plan content only at the client", async () => {
    const service = new ClientEncryptionService();
    service.setAccountMasterKey({
      accountMasterKey: generateAccountMasterKey(),
      identity: { ownerId, serverId },
      masterKeyRevision: 1,
    });
    const componentKey = service.componentKey({
      component: "chat-content",
      identity: { ownerId, serverId },
      keyRevision: 1,
    });
    const classification = { hasQuestion: false };
    try {
      const state = {
        classification,
        protectedContent: await encryptChatPlanProtectedContent({
          ownerId,
          chatId,
          keyRevision: 1,
          componentKey,
          content: {
            version: 1,
            classification,
            explanation: "SENTINEL client-only plan",
            steps: [{ step: "Encrypt plans", status: "completed" }],
            question: null,
          },
        }),
      };
      expect(JSON.stringify(state)).not.toContain("SENTINEL");
      await expect(
        openEncryptedChatPlanWireState(
          chatId,
          {
            kind: "chat-encrypted",
            chatId,
            mode: "plan",
            hasQuestion: false,
            state,
          },
          { service, session },
        ),
      ).resolves.toMatchObject({
        mode: "plan",
        explanation: "SENTINEL client-only plan",
        steps: [{ step: "Encrypt plans", status: "completed" }],
        question: null,
      });
    } finally {
      clearSensitiveBytes(componentKey);
    }
  });
});
