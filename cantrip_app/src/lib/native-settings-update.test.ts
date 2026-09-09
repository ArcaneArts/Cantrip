import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptNativeSettingsPatch } from "@cantrip/crypto";
import type { NativeSettingsBinding } from "@cantrip/protocol";

vi.mock("./client-encryption", () => ({
  ClientEncryptionError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  clientEncryption: undefined,
}));
vi.mock("./client-session", () => ({
  getClientSessionIdentitySnapshot: () => null,
  clientSessionIdentityMatches: () => false,
}));
vi.mock("./api-client", () => ({ request: vi.fn() }));
import type { ClientEncryptionService } from "./client-encryption";
import { request as apiRequest } from "./api-client";
import {
  prepareNativeSettingsUpdate,
  sendNativeSettingsUpdate,
} from "./native-settings-update";

const binding: NativeSettingsBinding = {
  bindingId: "binding-one",
  chatId: "chat-one",
  threadId: "native-thread-one",
  workerId: "worker-one",
  runtimeGeneration: "runtime-one",
  nativeEpoch: "core-one",
  contextKind: "project",
  projectId: "project-one",
  placementId: "placement-one",
  modelRouteId: "route-one",
  providerAccountId: "provider-account-one",
};
const operationId = "caller-owned-operation";
const patch = { model: "private-model-choice", serviceTier: null };
const makeKey = () => new Uint8Array(32).fill(27);
function fixture() {
  const issued: Uint8Array[] = [];
  const identity = {
    userId: "owner-one",
    serverId: "server-one",
    accountId: "account-one",
    connectionId: "connection-one",
    generation: 1,
    incarnationId: "incarnation-one",
    serverUrl: "http://fixture.invalid",
  };
  let snapshot = {
    status: "ready",
    masterKeyRevision: 3,
    identity: { ownerId: identity.userId, serverId: identity.serverId },
  };
  const componentKey = vi.fn(() => {
    const key = makeKey();
    issued.push(key);
    return key;
  });
  const options = {
    service: {
      getSnapshot: () => snapshot,
      componentKey,
    } as unknown as ClientEncryptionService,
    identity: () => identity,
    identityMatches: vi.fn(() => true),
  };
  return {
    identity,
    issued,
    componentKey,
    options,
    lock: () => {
      snapshot = { ...snapshot, status: "locked" };
    },
    replaceUnlock: () => {
      snapshot = { ...snapshot };
    },
  };
}
const prepare = (source: ReturnType<typeof fixture>) =>
  prepareNativeSettingsUpdate({
    chatId: binding.chatId,
    binding,
    patch,
    operationId,
    options: source.options,
  });
const allCleared = (keys: Uint8Array[]) =>
  keys.every((key) => key.every((value) => value === 0));
beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
});

describe("explicit client native settings update", () => {
  it("encrypts only selected fields with caller operation and binding, clearing the key copy", async () => {
    const source = fixture();
    const request = await prepare(source);
    expect(request.operationId).toBe(operationId);
    expect(request.bindingId).toBe(binding.bindingId);
    expect(Object.keys(request).sort()).toEqual([
      "bindingId",
      "operationId",
      "protectedPatch",
    ]);
    expect(JSON.stringify(request)).not.toContain(patch.model);
    expect(
      await decryptNativeSettingsPatch({
        ownerId: source.identity.userId,
        serverId: source.identity.serverId,
        componentKey: makeKey(),
        keyRevision: 3,
        context: {
          chatId: binding.chatId,
          operationId,
          bindingId: binding.bindingId,
        },
        envelope: request.protectedPatch,
      }),
    ).toEqual(patch);
    expect(source.componentKey).toHaveBeenCalledExactlyOnceWith({
      component: "chat-content",
      identity: { ownerId: "owner-one", serverId: "server-one" },
      keyRevision: 3,
    });
    expect(allCleared(source.issued)).toBe(true);
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it.each(["operationId", "bindingId"] as const)(
    "authenticates %s rather than allowing ciphertext retargeting",
    async (field) => {
      const source = fixture();
      const request = await prepare(source);
      await expect(
        decryptNativeSettingsPatch({
          ownerId: source.identity.userId,
          serverId: source.identity.serverId,
          componentKey: makeKey(),
          keyRevision: 3,
          context: {
            chatId: binding.chatId,
            operationId,
            bindingId: binding.bindingId,
            [field]: "substituted",
          },
          envelope: request.protectedPatch,
        }),
      ).rejects.toThrow();
    },
  );

  it("rejects cross-chat bindings and invalid operation identities before deriving keys", async () => {
    const source = fixture();
    for (const change of [{ chatId: "another-chat" }, { operationId: "" }])
      await expect(
        prepareNativeSettingsUpdate({
          chatId: binding.chatId,
          binding,
          patch,
          operationId,
          options: source.options,
          ...change,
        }),
      ).rejects.toThrow();
    expect(source.issued).toHaveLength(0);
  });

  it.each(["account", "lock", "unlock"])(
    "discards encrypted output after concurrent %s change",
    async (change) => {
      const source = fixture();
      const promise = prepare(source);
      if (change === "account")
        source.options.identityMatches.mockReturnValue(false);
      else if (change === "lock") source.lock();
      else source.replaceUnlock();
      await expect(promise).rejects.toMatchObject({ code: "locked" });
      expect(source.issued).toHaveLength(1);
      expect(allCleared(source.issued)).toBe(true);
      expect(apiRequest).not.toHaveBeenCalled();
    },
  );

  it("does not derive keys when locked or in a different authenticated lifetime", async () => {
    for (const change of ["lock", "account"]) {
      const source = fixture();
      if (change === "lock") source.lock();
      else source.options.identityMatches.mockReturnValue(false);
      await expect(prepare(source)).rejects.toMatchObject({ code: "locked" });
      expect(source.issued).toHaveLength(0);
    }
  });

  it("clears the key copy when encryption rejects an invalid native patch", async () => {
    const source = fixture();
    await expect(
      prepareNativeSettingsUpdate({
        chatId: binding.chatId,
        binding,
        operationId,
        patch: { model: 123 as unknown as string },
        options: source.options,
      }),
    ).rejects.toThrow();
    expect(source.issued).toHaveLength(1);
    expect(allCleared(source.issued)).toBe(true);
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("pins a single opaque request to the supplied identity and preserves queued status", async () => {
    const source = fixture();
    const request = await prepare(source);
    const receipt = {
      operationId,
      submissionId: "native-submission",
      status: "queued",
    };
    vi.mocked(apiRequest).mockResolvedValue(receipt);
    const signal = new AbortController().signal;
    expect(
      await sendNativeSettingsUpdate({
        chatId: binding.chatId,
        identity: source.identity,
        request,
        signal,
      }),
    ).toEqual(receipt);
    expect(apiRequest).toHaveBeenCalledExactlyOnceWith(
      `/api/chats/${binding.chatId}/native-settings/update`,
      { method: "POST", body: JSON.stringify(request), signal },
      { expectedIdentity: source.identity },
    );
  });

  it("rejects unrelated receipts and never retries an uncertain transport failure", async () => {
    const source = fixture();
    const request = await prepare(source);
    const send = () =>
      sendNativeSettingsUpdate({
        chatId: binding.chatId,
        identity: source.identity,
        request,
      });
    vi.mocked(apiRequest).mockResolvedValue({
      operationId: "another-operation",
      submissionId: null,
      status: "requesting",
    });
    await expect(send()).rejects.toThrow("another operation");
    const failure = new Error("Response lost after dispatch");
    vi.mocked(apiRequest).mockReset().mockRejectedValue(failure);
    await expect(send()).rejects.toBe(failure);
    expect(apiRequest).toHaveBeenCalledOnce();
    expect(
      JSON.parse(vi.mocked(apiRequest).mock.calls[0]![1]!.body as string),
    ).toEqual(request);
  });
});
