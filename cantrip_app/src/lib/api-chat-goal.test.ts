import { generateAccountMasterKey } from "@cantrip/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getChatGoal, updateChatGoal } from "./api/chats";
import { request } from "./api-client";
import { clientEncryption } from "./client-encryption";
import { clearClientSession, setClientSession } from "./client-session";
import { protectChatGoalObjective } from "./chat-message-encryption";

vi.mock("./api-client", async (original) => ({
  ...(await original<typeof import("./api-client")>()),
  request: vi.fn(),
}));
const metadata = {
  threadId: "thread",
  status: "paused",
  tokenBudget: 5000,
  tokensUsed: 125,
  timeUsedSeconds: 45,
  createdAt: 1,
  updatedAt: 2,
};
beforeEach(() => {
  vi.mocked(request).mockReset();
  setClientSession({
    authMode: "accounts",
    csrfToken: "q".repeat(32),
    expiresAt: null,
    serverId: "server",
    user: {
      id: "owner",
      kind: "account",
      displayName: "Goal",
      email: "goal@example.com",
      role: "member",
    },
  });
  clientEncryption.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: { ownerId: "owner", serverId: "server" },
    masterKeyRevision: 1,
  });
});
afterEach(() => {
  clientEncryption.lock();
  clearClientSession();
});

describe("goal API", () => {
  it("reads encrypted status without losing the private objective", async () => {
    const protectedObjective = await protectChatGoalObjective(
      "SENTINEL full objective",
    );
    vi.mocked(request).mockResolvedValue({
      kind: "chat-encrypted",
      goal: { ...metadata, protectedObjective },
    });
    await expect(getChatGoal("chat")).resolves.toEqual({
      goal: { ...metadata, objective: "SENTINEL full objective" },
    });
    expect(request).toHaveBeenCalledWith("/api/chats/chat/goal?encrypted=1");
  });

  it("sends only encrypted edits and keeps status and token budget out of the patch", async () => {
    vi.mocked(request).mockImplementation(async (_path, init) => {
      const patch = JSON.parse(String(init?.body));
      expect(String(init?.body)).not.toContain("SENTINEL");
      expect(Object.keys(patch)).toEqual(["protectedObjective"]);
      return {
        kind: "chat-encrypted",
        goal: { ...metadata, protectedObjective: patch.protectedObjective },
      };
    });
    await expect(
      updateChatGoal("chat", { objective: "SENTINEL revised objective" }),
    ).resolves.toEqual({
      goal: { ...metadata, objective: "SENTINEL revised objective" },
    });
  });

  it("does not report success when an older worker ignores the edit", async () => {
    vi.mocked(request).mockResolvedValue({
      goal: { ...metadata, objective: "Old objective" },
    });
    await expect(
      updateChatGoal("chat", { objective: "New objective" }),
    ).rejects.toThrow("goal edit was not applied");
  });
});
