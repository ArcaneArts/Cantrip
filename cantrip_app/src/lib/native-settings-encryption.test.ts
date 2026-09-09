import legacyJson from "../../../packages/crypto/test/fixtures/native-settings-v1.json?raw";
import { describe, expect, it, vi } from "vitest";
import { nativeSettingsStateSchema } from "@cantrip/protocol";

// Exercise the real shared AEAD without opening a native keystore or profile.
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
import type { ClientEncryptionService } from "./client-encryption";
import { openNativeSettingsState } from "./native-settings-encryption";

const legacy = JSON.parse(legacyJson);
function state() {
  return nativeSettingsStateSchema.parse({
    chatId: legacy.context.chatId,
    revision: "5",
    desiredRevision: "0",
    desired: null,
    desiredStatus: null,
    pending: [],
    binding: {
      chatId: legacy.context.chatId,
      workerId: legacy.context.workerId,
      threadId: legacy.context.threadId,
      runtimeGeneration: legacy.context.runtimeGeneration,
      nativeEpoch: legacy.context.settingsVersion.epoch,
      bindingId: "fixture-binding",
      contextKind: "standalone",
      projectId: null,
      placementId: "fixture-placement",
      modelRouteId: null,
      providerAccountId: null,
    },
    effective: legacy.snapshot,
  });
}
function fixture() {
  const issued: Uint8Array[] = [];
  const identity = {
    userId: legacy.ownerId as string,
    serverId: legacy.serverId as string,
    accountId: "fixture-account",
    connectionId: "fixture-connection",
    generation: 1,
    incarnationId: "fixture-incarnation",
    serverUrl: "http://fixture.invalid",
  };
  let snapshot = {
    status: "ready",
    masterKeyRevision: 2,
    identity: { ownerId: identity.userId, serverId: identity.serverId },
  };
  const componentKey = vi.fn(() => {
    const key = new Uint8Array(32).fill(legacy.componentKeyByte);
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
    options,
    componentKey,
    issued,
    lock: () => {
      snapshot = { ...snapshot, status: "locked" };
    },
  };
}
const allCleared = (keys: Uint8Array[]) =>
  keys.every((key) => key.every((byte) => byte === 0));

describe("client native settings", () => {
  it("reads the legacy worker snapshot after key rotation and clears its key copy", async () => {
    const source = fixture();
    expect(
      await openNativeSettingsState({
        chatId: legacy.context.chatId,
        state: state(),
        options: source.options,
      }),
    ).toEqual(legacy.settings);
    expect(source.componentKey).toHaveBeenCalledWith({
      component: "chat-content",
      identity: { ownerId: legacy.ownerId, serverId: legacy.serverId },
      keyRevision: 1,
    });
    expect(source.issued).toHaveLength(1);
    expect(allCleared(source.issued)).toBe(true);
  });

  it.each([
    "chatId",
    "workerId",
    "threadId",
    "runtimeGeneration",
    "nativeEpoch",
  ] as const)("rejects a substituted binding %s", async (field) => {
    const source = fixture();
    const value = state();
    value.binding![field] = "other";
    await expect(
      openNativeSettingsState({
        chatId: legacy.context.chatId,
        state: value,
        options: source.options,
      }),
    ).rejects.toThrow();
    expect(allCleared(source.issued)).toBe(true);
  });

  it("requires the caller's chat and never opens an unbound snapshot", async () => {
    const source = fixture();
    for (const input of [
      { chatId: "other", state: state() },
      { chatId: legacy.context.chatId, state: { ...state(), binding: null } },
    ])
      await expect(
        openNativeSettingsState({ ...input, options: source.options }),
      ).rejects.toThrow();
    expect(source.issued).toHaveLength(0);
  });

  it("discards decryption after a concurrent account change or encryption lock", async () => {
    for (const change of ["account", "lock"]) {
      const source = fixture();
      const result = openNativeSettingsState({
        chatId: legacy.context.chatId,
        state: state(),
        options: source.options,
      });
      if (change === "account")
        source.options.identityMatches.mockReturnValue(false);
      else source.lock();
      await expect(result).rejects.toMatchObject({ code: "locked" });
      expect(source.issued).toHaveLength(1);
      expect(allCleared(source.issued)).toBe(true);
    }
  });

  it("does not derive a key while locked and returns null for an absent selection", async () => {
    const source = fixture();
    source.lock();
    await expect(
      openNativeSettingsState({
        chatId: legacy.context.chatId,
        state: state(),
        options: source.options,
      }),
    ).rejects.toMatchObject({ code: "locked" });
    expect(
      await openNativeSettingsState({
        chatId: legacy.context.chatId,
        state: { ...state(), effective: null },
        options: source.options,
      }),
    ).toBeNull();
    expect(source.issued).toHaveLength(0);
  });
});
