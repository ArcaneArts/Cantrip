import { generateAccountMasterKey } from "@cantrip/crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteQueuedPrompt,
  getQueuedPromptState,
  reorderQueuedPrompts,
  updateQueuedPrompt,
} from "./api";
import { requestQueueMutation } from "./queue-mutation-recovery";
import { createEncryptedChatTurn } from "./chat-message-encryption";
import { clientEncryption } from "./client-encryption";
import { clearClientSession, setClientSession } from "./client-session";
import { PendingQueueImports } from "../components/chat/pending-queue-imports";
import { PromptQueue } from "../components/chat/prompt-queue";

const ownerId = "queue-owner";
const serverId = "queue-server";
const promptId = "22222222-2222-4222-8222-222222222222";
beforeEach(() => {
  setClientSession({
    authMode: "accounts",
    csrfToken: "q".repeat(32),
    expiresAt: null,
    serverId,
    user: {
      id: ownerId,
      kind: "account",
      displayName: "Queue",
      email: "queue@example.com",
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
async function fixture() {
  const turn = await createEncryptedChatTurn({
    attachments: [],
    idempotencyKey: "queue-item",
    messageId: "11111111-1111-4111-8111-111111111111",
    promptId,
    mode: "default",
    modelId: "model",
    reasoningEffort: null,
    text: "original",
  });
  return {
    ...turn.queuedPrompt,
    chatId: "chat",
    revision: 8,
    position: 0,
    attachments: [],
    protectedNativeInput: turn.queuedPrompt.protectedContent.envelope,
    nativeAction: "literal" as const,
    executionMethod: "turn/start" as const,
    nativeClientUserMessageId: "native-user-message",
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
  };
}

function receipt(
  operationId: string,
  method: string,
  acceptedItem?: Awaited<ReturnType<typeof fixture>>,
) {
  return {
    found: true,
    revision: 25,
    paused: false,
    items: [],
    claims: [],
    acceptedItem,
    receipt: {
      operationId,
      operationGeneration: "generation",
      activationGeneration: null,
      chatId: "chat",
      threadId: "thread",
      startsExecution: false,
      executionLaneId: null,
      status: "applied",
      method,
      payloadDigest: "a".repeat(64),
      rejectionCode: null,
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:00.000Z",
    },
  };
}

describe("GUI canonical queue API", () => {
  it.each([
    { status: "rejected", label: "Start failed", actionable: true },
    { status: "uncertain", label: "Start unconfirmed", actionable: false },
    { status: "claimed", label: "Preparing", actionable: false },
  ])(
    "projects $status start receipts into queue controls",
    async ({ status, label, actionable }) => {
      const item = await fixture();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            revision: 20,
            items: [item],
            claims: [
              {
                id: "claim",
                chatId: "chat",
                promptId,
                promptRevision: 8,
                status,
                operationId: null,
                operationGeneration: null,
                nativeTurnId: null,
                createdAt: "2026-09-08T00:00:00.000Z",
              },
            ],
          }),
        ),
      );
      const state = await getQueuedPromptState("chat");
      const props = {
        prompts: state.items,
        claims: state.claims,
        disabled: false,
        editingPromptId: null,
        executing: false,
        onDelete: vi.fn(),
        onEdit: vi.fn(),
        onFreeze: vi.fn(),
        onReorder: vi.fn(),
        onSteer: vi.fn(),
      };
      const html = renderToStaticMarkup(createElement(PromptQueue, props));
      expect(html).toContain(label);
      const buttons = html.match(/<button\b[^>]*>/g) ?? [];
      expect(buttons.length).toBeGreaterThan(0);
      expect(buttons.every((button) => button.includes('disabled=""'))).toBe(
        !actionable,
      );
      if (actionable) expect(html).toContain("Retry");
      // A rejected attempt for the previous revision must not label or disable a fresh edit.
      const fresh = renderToStaticMarkup(
        createElement(PromptQueue, {
          ...props,
          prompts: state.items.map((prompt) => ({ ...prompt, revision: 9 })),
        }),
      );
      expect(fresh).not.toContain(label);
      expect(props.onSteer).not.toHaveBeenCalled();
    },
  );

  it("opens retained transfers separately from executable queue items", async () => {
    const item = await fixture();
    const fetch = vi.fn(async () =>
      Response.json({
        revision: 20,
        items: [],
        pendingImports: ["pending", "conflict", "uncertain"].map((status) => ({
          importId: `transfer-${status}`,
          nativeItemId: `native-${status}`,
          status,
          prompt: item,
        })),
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const state = await getQueuedPromptState("chat");
    expect(state.items).toEqual([]);
    expect(state.pendingImports).toEqual(
      ["pending", "conflict", "uncertain"].map((status) =>
        expect.objectContaining({
          importId: `transfer-${status}`,
          status,
          prompt: expect.objectContaining({ text: "original", revision: 8 }),
        }),
      ),
    );
    const html = renderToStaticMarkup(
      createElement(PendingQueueImports, { imports: state.pendingImports }),
    );
    expect(html).toContain('aria-label="Pending queue transfers"');
    expect(html).toContain("Transferring from CLI");
    expect(html).toContain("CLI prompt changed");
    expect(html).toContain("Transfer unconfirmed");
    expect(html).toContain("original");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("draggable");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not continue a prepared edit or recover a receipt under a replacement login", async () => {
    const item = await fixture();
    const fetch = vi.fn(async () => {
      clearClientSession();
      setClientSession({
        authMode: "accounts",
        csrfToken: "r".repeat(32),
        expiresAt: null,
        serverId,
        user: {
          id: ownerId,
          kind: "account",
          displayName: "Queue",
          email: "queue@example.com",
          role: "member",
        },
      });
      return Response.json({ revision: 19, items: [item] });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      updateQueuedPrompt("chat", promptId, {
        text: "stale edit",
        expectedItemRevision: 8,
      }),
    ).rejects.toMatchObject({ code: "client-identity-changed" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("recovers the original accepted edit after a lost response and consumption without sending the edit twice", async () => {
    const original = await fixture();
    let submitted: typeof original | undefined;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        submitted = { ...original, ...body.prompt, revision: 9 };
        throw new TypeError("response lost after commit");
      }
      if (String(_url).includes("/operations/"))
        return Response.json(
          receipt("recover-edit", "thread/queue/update", submitted),
        );
      return Response.json({ revision: 19, items: [original] });
    });
    vi.stubGlobal("fetch", fetch);
    expect(
      await updateQueuedPrompt("chat", promptId, {
        text: "committed edit",
        expectedItemRevision: 8,
        operationId: "recover-edit",
      }),
    ).toMatchObject({ text: "committed edit", revision: 9 });
    expect(
      fetch.mock.calls.filter((call) => call[1]?.method === "PATCH"),
    ).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("recovers removal by receipt even when the item no longer exists", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(String(url), "http://localhost");
      if (init?.method === "DELETE") throw new TypeError("lost removal reply");
      return Response.json(
        receipt(parsed.pathname.split("/").at(-1)!, "thread/queue/delete"),
      );
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      deleteQueuedPrompt(promptId, 8, "chat"),
    ).resolves.toBeUndefined();
    expect(
      fetch.mock.calls.filter((call) => call[1]?.method === "DELETE"),
    ).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "foreign", "unavailable"])(
    "retains uncertainty without replay when receipt recovery is %s",
    async (kind) => {
      const failure = new TypeError("mutation reply lost");
      const fetch = vi.fn().mockRejectedValueOnce(failure);
      if (kind === "unavailable")
        fetch.mockRejectedValueOnce(new TypeError("lookup unavailable"));
      else
        fetch.mockResolvedValueOnce(
          Response.json(
            kind === "missing"
              ? { found: false }
              : receipt("foreign", "thread/queue/reorder"),
          ),
        );
      vi.stubGlobal("fetch", fetch);
      await expect(
        requestQueueMutation({
          chatId: "chat",
          operationId: "operation",
          nativeMethod: "thread/queue/reorder",
          path: "/api/chats/chat/queue/order",
          init: { method: "PATCH", body: "{}" },
        }),
      ).rejects.toBe(failure);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
  it("retains server and item revisions while reading both managed and legacy queues", async () => {
    const item = await fixture();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ revision: 19, items: [item] }))
      .mockResolvedValueOnce(Response.json([item]));
    vi.stubGlobal("fetch", fetch);
    expect(await getQueuedPromptState("chat")).toMatchObject({
      revision: 19,
      items: [{ id: promptId, revision: 8, text: "original" }],
    });
    expect(await getQueuedPromptState("chat")).toMatchObject({
      revision: null,
      items: [{ revision: 8 }],
      pendingImports: [],
      claims: [],
    });
  });

  it("sends the user's observed edit revision despite a newer refresh and never retries the rejected mutation", async () => {
    const item = await fixture();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ revision: 19, items: [item] }))
      .mockResolvedValueOnce(
        Response.json({ error: "The queue item changed." }, { status: 409 }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(
      updateQueuedPrompt("chat", promptId, {
        text: "my edit",
        expectedItemRevision: 7,
        operationId: "stable-edit-operation",
      }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
    const init = fetch.mock.calls[1]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      expectedItemRevision: 7,
      operationId: "stable-edit-operation",
      prompt: {
        nativeClientUserMessageId: "native-user-message",
        protectedNativeInput: item.protectedNativeInput,
      },
    });
    expect(init.body).not.toContain("my edit");
  });

  it("sends observed revisions for removal and ordering without a hidden refresh", async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json({}));
    vi.stubGlobal("fetch", fetch);
    await deleteQueuedPrompt(promptId, 8);
    await reorderQueuedPrompts("chat", [promptId], 19);
    expect(fetch).toHaveBeenCalledTimes(2);
    const url = new URL(String(fetch.mock.calls[0]![0]), "http://localhost");
    expect(url.searchParams.get("expectedItemRevision")).toBe("8");
    expect(url.searchParams.get("operationId")).toMatch(/^[a-f0-9-]{36}$/u);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toMatchObject({
      expectedRevision: 19,
      ids: [promptId],
    });
  });
});
