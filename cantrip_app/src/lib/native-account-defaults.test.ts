import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decryptNativeAccountDefaults,
  encryptNativeAccountDefaults,
} from "@cantrip/crypto";
import type { ClientEncryptionService } from "./client-encryption";
vi.mock("./client-encryption", () => ({
  ClientEncryptionError: class extends Error {},
  clientEncryption: undefined,
}));
vi.mock("./client-session", () => ({
  clientSessionIdentityMatches: () => false,
}));
vi.mock("./api-client", () => ({ request: vi.fn() }));
import { request as apiRequest } from "./api-client";
import { nativeAccountDefaults } from "./native-account-defaults";
const binding = {
  bindingId: "binding",
  chatId: "chat",
  threadId: "thread",
  workerId: "worker",
  runtimeGeneration: "runtime",
  nativeEpoch: "epoch",
  contextKind: "project" as const,
  projectId: "project",
  placementId: "placement",
  modelRouteId: "route",
  providerAccountId: "account",
};
const identity = {
  userId: "owner",
  serverId: "server",
  accountId: "account",
  connectionId: "connection",
  generation: 1,
  incarnationId: "incarnation",
  serverUrl: "http://fixture.invalid",
};
const context = { chatId: "chat", bindingId: "binding", operationId: "op" };
const makeKey = () => new Uint8Array(32).fill(29);
const value = {
  expectedVersion: "v1",
  values: { model: "private-model", service_tier: null },
};
const result = {
  snapshot: { version: "v2", stored: value.values, effective: value.values },
  write: { status: "ok" as const, version: "v2" },
  verification: "confirmed" as const,
};
function fixture() {
  const keys: Uint8Array[] = [];
  let unlocked = {
    status: "ready",
    masterKeyRevision: 1,
    identity: { ownerId: "owner", serverId: "server" },
  };
  const options = {
    identityMatches: vi.fn(() => true),
    service: {
      getSnapshot: () => unlocked,
      componentKey: () => {
        const key = makeKey();
        keys.push(key);
        return key;
      },
    } as unknown as ClientEncryptionService,
  };
  return {
    options,
    keys,
    lock: () => {
      unlocked = { ...unlocked, status: "locked" };
    },
    run: () =>
      nativeAccountDefaults({
        binding,
        identity,
        operationId: "op",
        write: value,
        options,
      }),
  };
}
beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
});
async function response() {
  return {
    operationId: "op",
    bindingId: "binding",
    protectedResult: await encryptNativeAccountDefaults({
      ownerId: "owner",
      serverId: "server",
      componentKey: makeKey(),
      keyRevision: 1,
      context: { ...context, direction: "response" },
      value: result,
    }),
  };
}
describe("encrypted client account defaults", () => {
  it("protects both directions with source and operation identity and clears keys", async () => {
    const f = fixture();
    vi.mocked(apiRequest).mockResolvedValue(await response());
    expect(await f.run()).toEqual(result);
    const request = JSON.parse(
      vi.mocked(apiRequest).mock.calls[0]![1]!.body as string,
    );
    expect(request).toMatchObject({
      action: "write",
      operationId: "op",
      bindingId: "binding",
    });
    expect(JSON.stringify(request)).not.toContain("private-model");
    expect(
      await decryptNativeAccountDefaults({
        ownerId: "owner",
        serverId: "server",
        componentKey: makeKey(),
        keyRevision: 1,
        context: { ...context, direction: "request" },
        envelope: request.protectedWrite,
      }),
    ).toEqual(value);
    expect(f.keys.every((key) => key.every((byte) => byte === 0))).toBe(true);
  });
  it.each(["bindingId", "operationId"])(
    "rejects a %s response mismatch without retrying",
    async (field) => {
      const f = fixture();
      vi.mocked(apiRequest).mockResolvedValue({
        ...(await response()),
        [field]: "other",
      });
      await expect(f.run()).rejects.toThrow("another operation");
      expect(apiRequest).toHaveBeenCalledOnce();
    },
  );
  it("discards a late encrypted result after locking", async () => {
    const f = fixture();
    vi.mocked(apiRequest).mockImplementation(async () => {
      f.lock();
      return response();
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.keys.every((key) => key.every((byte) => byte === 0))).toBe(true);
  });
  it("does not automatically resubmit an uncertain write", async () => {
    const f = fixture();
    vi.mocked(apiRequest).mockRejectedValue(new Error("lost response"));
    await expect(f.run()).rejects.toThrow("lost response");
    expect(apiRequest).toHaveBeenCalledOnce();
  });
});
