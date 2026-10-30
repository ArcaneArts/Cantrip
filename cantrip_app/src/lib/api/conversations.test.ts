import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  open: vi.fn(),
  protect: vi.fn(),
  archived: vi.fn(),
  matches: vi.fn(),
}));
const identity = {
  accountId: "owner",
  connectionId: "connection",
  generation: 1,
  incarnationId: "incarnation",
  serverId: "server",
  serverUrl: null,
  userId: "owner",
};
vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  request: mocks.request,
}));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => identity,
  clientSessionIdentityMatches: mocks.matches,
}));
vi.mock("@/lib/chat-title-encryption", () => ({
  chatTitleEncryption: {
    open: mocks.open,
    protect: mocks.protect,
    openArchived: mocks.archived,
  },
}));
import {
  prepareConversationCreation,
  getConversationCatalog,
  recordConversationUsage,
} from "./conversations";

const at = "2026-10-30T00:00:00.000Z";
function chat(id: string) {
  return {
    id,
    projectId: "project/id",
    contextKind: "project",
    experience: "agent",
    lastUsedAt: at,
    titleProtection: {
      classification: { recordKind: "chat" },
      protectedLabel: {
        formatVersion: 1,
        keyRevision: 1,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    },
    position: 0,
    status: "idle",
    activeWorkerId: "worker",
    activeWorktreeId: "tree",
    placementRevision: 1,
    worktreeMode: "agent-managed",
    modelId: null,
    reasoningEffort: null,
    permissionProfileId: null,
    planMode: "default",
    hasPendingPlanQuestion: false,
    hasUnreadCompletion: false,
    automationPaused: false,
    createdAt: at,
    updatedAt: at,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.matches.mockReturnValue(true);
  mocks.open.mockImplementation(async ({ titleProtection: _, ...item }) => ({
    ...item,
    title: "Decrypted",
  }));
});
it("fetches only a bounded page and preserves server order, precision, and continuation", async () => {
  mocks.request.mockResolvedValue({
    state: "active",
    items: [chat("b"), chat("a")],
    total: 1000,
    nextCursor: "opaque-next",
  });
  const page = await getConversationCatalog("project/id", {
    limit: 25,
    cursor: "cursor/+",
  });
  expect(page.items.map((c) => c.id)).toEqual(["b", "a"]);
  expect(page.total).toBe(1000);
  expect(page.nextCursor).toBe("opaque-next");
  expect(page.items[0]).not.toHaveProperty("titleProtection");
  expect(page.items[0]!.lastUsedAt).toBe(at);
  expect(mocks.open).toHaveBeenCalledTimes(2);
  const [url, , behavior] = mocks.request.mock.calls[0]!;
  const parsed = new URL(url, "https://test.invalid");
  expect(parsed.pathname).toBe("/api/projects/project%2Fid/conversations");
  expect(parsed.searchParams.get("limit")).toBe("25");
  expect(parsed.searchParams.get("cursor")).toBe("cursor/+");
  expect(behavior.expectedIdentity).toEqual(identity);
});
it("rejects a foreign page before decrypting any labels", async () => {
  mocks.request.mockResolvedValue({
    state: "active",
    items: [{ ...chat("a"), projectId: "other" }],
    total: 1,
    nextCursor: null,
  });
  await expect(getConversationCatalog("project/id")).rejects.toThrow(
    "scope mismatch",
  );
  expect(mocks.open).not.toHaveBeenCalled();
});
it("keeps the archive page distinct from the active catalog", async () => {
  mocks.request.mockResolvedValue({
    state: "archived",
    items: [],
    total: 0,
    nextCursor: null,
  });
  await expect(
    getConversationCatalog("project/id", { state: "archived" }),
  ).resolves.toMatchObject({ state: "archived", total: 0 });
  await expect(getConversationCatalog("project/id")).rejects.toThrow(
    "scope mismatch",
  );
});
it("does not publish a decrypted page into a later account session", async () => {
  mocks.request.mockResolvedValue({
    state: "active",
    items: [chat("a")],
    total: 1,
    nextCursor: null,
  });
  mocks.open.mockImplementationOnce(async () => {
    mocks.matches.mockReturnValue(false);
    return { id: "a", title: "Private" };
  });
  await expect(getConversationCatalog("project/id")).rejects.toMatchObject({
    code: "client-identity-changed",
  });
});
it("retains the exact usage operation for retries and rejects a stale account", async () => {
  const usage = {
    clientId: "00000000-0000-4000-8000-000000000001",
    operationId: "00000000-0000-4000-8000-000000000002",
    sequence: 4,
  };
  mocks.request.mockRejectedValueOnce(new TypeError("offline"));
  await expect(
    recordConversationUsage("chat/id", usage, identity),
  ).rejects.toThrow("offline");
  mocks.request.mockResolvedValue({ lastUsedAt: at, applied: false });
  await recordConversationUsage("chat/id", usage, identity);
  expect(mocks.request.mock.calls[0]).toEqual(mocks.request.mock.calls[1]);
  expect(mocks.request.mock.calls[0]![0]).toBe("/api/chats/chat%2Fid/usage");
  mocks.matches.mockReturnValue(false);
  await expect(
    recordConversationUsage("chat/id", usage, identity),
  ).rejects.toMatchObject({ code: "client-identity-changed" });
  expect(mocks.request).toHaveBeenCalledTimes(2);
});

it("retries creation with the same encrypted identity and never requests placement", async () => {
  mocks.protect.mockResolvedValue(chat("seed").titleProtection);
  const create = await prepareConversationCreation(
    "project/id",
    "Private name",
  );
  mocks.request.mockRejectedValueOnce(new TypeError("response lost"));
  await expect(create()).rejects.toThrow("response lost");
  const body = JSON.parse(mocks.request.mock.calls[0]![1].body);
  expect(body).toMatchObject({ attachToTabLayout: false, autoTitle: true });
  expect(JSON.stringify(body)).not.toContain("Private name");
  const { lastUsedAt: _, ...created } = chat(body.id);
  mocks.request.mockResolvedValue(created);
  await expect(create()).resolves.toMatchObject({
    id: body.id,
    title: "Decrypted",
  });
  expect(mocks.request.mock.calls[0]).toEqual(mocks.request.mock.calls[1]);
  expect(mocks.protect).toHaveBeenCalledTimes(1);
  mocks.matches.mockReturnValue(false);
  await expect(create()).rejects.toMatchObject({
    code: "client-identity-changed",
  });
  expect(mocks.request).toHaveBeenCalledTimes(2);
});
