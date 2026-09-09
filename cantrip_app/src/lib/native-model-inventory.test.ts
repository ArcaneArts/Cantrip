import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api-client", () => ({ request: vi.fn() }));
import { request } from "./api-client";
import {
  nativeChatModelInventoryQueryKey,
  readNativeChatModelInventory,
} from "./native-model-inventory";

const identity = {
  userId: "owner-one",
  serverId: "server-one",
  accountId: "account-one",
  connectionId: "connection-one",
  generation: 1,
  incarnationId: "incarnation-one",
  serverUrl: "http://fixture.invalid",
};
const inventory = {
  bindingId: "binding-one",
  workerId: "worker-one",
  providerId: "provider-one",
  providerAccountId: "provider-account-one",
  providerKind: "chatgpt",
  models: [
    {
      id: "logical-one",
      routeId: "route-one",
      name: "native-one",
      reasoningEffort: null,
    },
  ],
};
beforeEach(() => {
  vi.mocked(request).mockReset();
});

describe("client bound native model inventory", () => {
  it("pins a read to the authenticated lifetime and returns exact native route identities", async () => {
    vi.mocked(request).mockResolvedValue(inventory);
    const signal = new AbortController().signal;
    expect(
      await readNativeChatModelInventory({
        chatId: "chat/one",
        bindingId: inventory.bindingId,
        identity,
        signal,
      }),
    ).toEqual(inventory);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "/api/chats/chat%2Fone/native-settings/models?bindingId=binding-one",
      { signal },
      { expectedIdentity: identity },
    );
    expect(
      nativeChatModelInventoryQueryKey(
        "chat/one",
        inventory.bindingId,
        identity,
      ),
    ).toEqual([
      "native-model-inventory",
      "chat/one",
      inventory.bindingId,
      identity,
    ]);
  });
  it("rejects another source and never refreshes or retries a failed read", async () => {
    vi.mocked(request).mockResolvedValue({
      ...inventory,
      bindingId: "replaced",
    });
    const read = () =>
      readNativeChatModelInventory({
        chatId: "chat-one",
        bindingId: inventory.bindingId,
        identity,
      });
    await expect(read()).rejects.toThrow("another settings source");
    vi.mocked(request).mockReset();
    const failure = new Error("Selected source moved");
    vi.mocked(request).mockRejectedValue(failure);
    await expect(read()).rejects.toBe(failure);
    expect(request).toHaveBeenCalledOnce();
  });
});
