import {
  generateAccountMasterKey,
  encryptChatMessageProtectedContent,
  deriveFieldKey,
  encryptPayload,
} from "@cantrip/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@cantrip/protocol";
import { projectTrajectory } from "@/components/chat/trajectory-model";
import { getMessagePage } from "./api";
import { clientEncryption } from "./client-encryption";
import { clearClientSession, setClientSession } from "./client-session";
const ownerId = "history-owner",
  serverId = "history-server",
  chatId = "chat";
const messageId = "11111111-1111-4111-8111-111111111111";
const initial = {
  model: "actual-native-model",
  modelProvider: "native-provider",
  reasoningEffort: null,
  effectiveReasoningEffort: "high",
  serviceTier: null,
  effectiveServiceTier: "fast",
  collaborationMode: "plan",
};
beforeEach(() => {
  setClientSession({
    authMode: "accounts",
    csrfToken: "q".repeat(32),
    expiresAt: null,
    serverId,
    user: {
      id: ownerId,
      kind: "account",
      displayName: "History",
      email: "history@example.com",
      role: "member",
    },
  });
  clientEncryption.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: { ownerId, serverId },
    masterKeyRevision: 1,
  });
});
afterEach(() => {
  clientEncryption.lock();
  clearClientSession();
  vi.unstubAllGlobals();
});
async function fixture(content?: ChatMessage["content"]) {
  const componentKey = clientEncryption.componentKey({
    component: "chat-content",
    identity: { ownerId, serverId },
    keyRevision: 1,
  });
  const classification = {
    role: "assistant" as const,
    mode: "default" as const,
    attachmentIds: [],
  };
  try {
    const protectedContent = await encryptChatMessageProtectedContent({
      ownerId,
      messageId,
      keyRevision: 1,
      componentKey,
      content: {
        version: 1,
        classification,
        content: content ?? [
          {
            type: "activity",
            activity: {
              type: "turnSummary",
              id: "turn:turn:summary",
              status: "completed",
              durationMs: 1000,
              startedAt: 1,
              completedAt: 2,
              correlation: {
                sourceMethod: "turn/completed",
                diagnosticId: null,
                threadId: "thread",
                turnId: "turn",
                itemId: null,
              },
            },
          },
        ],
      },
    });
    const message = {
      ...classification,
      id: messageId,
      chatId,
      contextKind: "project",
      worktreeId: "worktree",
      scratchRootId: null,
      executionLaneId: "lane",
      sequence: 1,
      protectedContent,
      modelId: null,
      modelRouteId: null,
      providerId: null,
      providerName: null,
      providerModelName: null,
      reasoningEffort: null,
      appliedReasoningEffort: null,
      reasoningAdjusted: false,
      idempotencyKey: "summary",
      createdAt: "2026-09-08T00:00:00.000Z",
    };
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([
          serverId,
          "worker",
          chatId,
          "binding",
          "thread",
          "turn",
          1,
          0,
          "completed",
          1000,
          2000,
        ]),
      ),
    );
    const associatedData = {
      ownerId,
      component: "chat-content" as const,
      table: "native-history-turns",
      rowId: Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
      field: "metadata",
      formatVersion: 1 as const,
      keyRevision: 1,
    };
    const key = deriveFieldKey({ componentKey, ...associatedData });
    const metadata = await encryptPayload({
      key,
      associatedData,
      plaintext: new TextEncoder().encode(
        JSON.stringify({
          version: 2,
          reducedTurn: {
            id: "turn",
            metadata: { initialSettings: initial },
            conflicts: [],
          },
          evidence: [],
        }),
      ),
    });
    key.fill(0);
    return {
      page: {
        kind: "chat-encrypted",
        messages: [message],
        page: {
          hasMore: false,
          nextBeforeSequence: null,
          oldestSequence: 1,
          newestSequence: 1,
          startsAtUserTurn: true,
        },
      },
      archive: {
        chatId,
        turns: [
          {
            bindingId: "binding",
            workerId: "worker",
            turn: {
              threadId: "thread",
              turnId: "turn",
              revision: 1,
              ordinal: 0,
              status: "completed",
              startedAtMs: 1000,
              completedAtMs: 2000,
              metadata,
            },
          },
        ],
      },
    };
  } finally {
    componentKey.fill(0);
  }
}
describe("canonical GUI history native settings recovery", () => {
  it("recovers a projected native turn with no summary on reload without manufacturing messages or lifecycle", async () => {
    const content: ChatMessage["content"] = [
      {
        type: "text",
        text: "Native response",
        correlation: {
          sourceMethod: "native-history",
          diagnosticId: null,
          threadId: "thread",
          turnId: "turn",
          itemId: "native-item",
        },
      },
    ];
    const data = await fixture(content);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) =>
        Response.json(
          String(url).includes("native-history") ? data.archive : data.page,
        ),
      ),
    );
    for (let reconnect = 0; reconnect < 2; reconnect++) {
      const result = await getMessagePage(chatId);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]!.content).toEqual(content);
      expect(result.messages[0]!.id).toBe(messageId);
      const input = { messages: result.messages, active: false, nowMs: 2000 };
      const withoutEvidence = projectTrajectory(input)!;
      const recovered = projectTrajectory({
        ...input,
        nativeTurnSettings: result.nativeTurnSettings,
      })!;
      expect(recovered.events).toEqual(withoutEvidence.events);
      expect(recovered.completedAtMs).toEqual(withoutEvidence.completedAtMs);
      expect(recovered.nativeTurnSettings).toEqual([
        expect.objectContaining({
          threadId: "thread",
          turnId: "turn",
          status: "available",
          initialSettings: initial,
        }),
      ]);
    }
  });

  it("decrypts the stored page then joins exact encrypted turn evidence without new message identities", async () => {
    const data = await fixture();
    const fetch = vi.fn(async (url: string | URL | Request) =>
      Response.json(
        String(url).includes("native-history") ? data.archive : data.page,
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await getMessagePage(chatId);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.id).toBe(messageId);
    expect(result.messages[0]!.sequence).toBe(1);
    expect(result.messages[0]!.content).toEqual([
      expect.objectContaining({
        activity: expect.objectContaining({
          type: "turnSummary",
          status: "completed",
          initialSettings: initial,
        }),
      }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1]![0])).toContain(
      `/api/chats/${chatId}/native-history/turns/read`,
    );
    expect(JSON.stringify(data.page)).not.toContain("actual-native-model");
    expect(JSON.stringify(data.archive)).not.toContain("actual-native-model");
  });
  it("keeps canonical message history readable when the supplemental archive cannot be read", async () => {
    const data = await fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) =>
        String(url).includes("native-history")
          ? Response.json({ error: "unavailable" }, { status: 503 })
          : Response.json(data.page),
      ),
    );
    const result = await getMessagePage(chatId);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.id).toBe(messageId);
    expect(result.messages[0]!.content[0]).toMatchObject({
      type: "activity",
      activity: { type: "turnSummary", status: "completed" },
    });
    expect(JSON.stringify(result.messages)).not.toContain("initialSettings");
  });
});
