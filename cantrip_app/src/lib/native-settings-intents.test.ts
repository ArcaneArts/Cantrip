import { describe, expect, it, vi } from "vitest";
import { deriveFieldKey, encryptPayload } from "@cantrip/crypto";
import type {
  NativeSettingsBinding,
  NativeSettingsState,
} from "@cantrip/protocol";
vi.mock("./client-encryption", () => ({
  clientEncryption: undefined,
  ClientEncryptionError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("./client-session", () => ({
  clientSessionIdentityMatches: () => false,
  getClientSessionIdentitySnapshot: () => null,
}));
import type { ClientEncryptionService } from "./client-encryption";
import { openNativeSettingsIntents } from "./native-settings-intents";
const binding: NativeSettingsBinding = {
  bindingId: "binding",
  chatId: "chat",
  workerId: "worker",
  threadId: "thread",
  runtimeGeneration: "runtime",
  nativeEpoch: "epoch",
  contextKind: "project",
  projectId: "project",
  placementId: "placement",
  modelRouteId: "route",
  providerAccountId: "account",
};
function fixture() {
  const identity = {
    userId: "owner",
    serverId: "server",
    accountId: "account",
    connectionId: "connection",
    generation: 1,
    incarnationId: "incarnation",
    serverUrl: null,
  };
  let snapshot = {
    status: "ready",
    identity: { ownerId: "owner", serverId: "server" },
    masterKeyRevision: 2,
  };
  const keys: Uint8Array[] = [];
  const options = {
    service: {
      getSnapshot: () => snapshot,
      componentKey: () => {
        const key = new Uint8Array(32).fill(19);
        keys.push(key);
        return key;
      },
    } as unknown as ClientEncryptionService,
    identity: () => identity,
    identityMatches: vi.fn(() => true),
  };
  return {
    options,
    keys,
    lock: () => {
      snapshot = { ...snapshot, status: "locked" };
    },
  };
}
async function state(
  extra: Record<string, unknown> = {},
): Promise<NativeSettingsState> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(["server", "chat", "operation"])),
  );
  const associatedData = {
    ownerId: "owner",
    component: "chat-content" as const,
    table: "native-command-admission",
    field: "request",
    rowId: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
    formatVersion: 1 as const,
    keyRevision: 2,
  };
  const key = deriveFieldKey({
    componentKey: new Uint8Array(32).fill(19),
    ...associatedData,
  });
  const envelope = await encryptPayload({
    key,
    associatedData,
    plaintext: new TextEncoder().encode(
      JSON.stringify({
        method: "thread/settings/update",
        params: {
          threadId: "thread",
          model: "private-choice",
          effort: null,
          serviceTier: null,
          ...extra,
        },
      }),
    ),
  });
  key.fill(0);
  const intent = {
    operationId: "operation",
    operationGeneration: "generation",
    origin: "gui" as const,
    source: {
      workerId: "worker",
      threadId: "thread",
      runtimeGeneration: "runtime",
    },
    protectedContent: envelope,
    payloadDigest: "a".repeat(64),
  };
  return {
    chatId: "chat",
    revision: "1",
    desiredRevision: "1",
    binding,
    effective: null,
    desired: intent,
    desiredStatus: "dispatched",
    pending: [
      {
        intent,
        status: "dispatched",
        bindingId: "binding",
        desiredRevision: "1",
      },
    ],
  };
}
describe("mounted native settings intent decryption", () => {
  it("retains full admitted TUI collaboration intent and gives it model/effort precedence", async () => {
    const collaborationMode = {
      mode: "plan",
      settings: {
        model: "tui-model",
        reasoning_effort: "high",
        developer_instructions: null,
      },
    };
    const value = await state({
      model: "ignored",
      effort: "low",
      collaborationMode,
    });
    value.pending[0]!.intent.origin = "terminal";
    const opened = await openNativeSettingsIntents({
      chatId: "chat",
      state: value,
      options: fixture().options,
    });
    expect(opened[0]!.patch).toMatchObject({
      collaborationMode,
      collaborationModeKind: "plan",
      model: "tui-model",
      effort: "high",
    });
  });

  it("opens the admitted frame, preserves null choices, and clears owned key copies", async () => {
    const source = fixture();
    expect(
      await openNativeSettingsIntents({
        chatId: "chat",
        state: await state(),
        options: source.options,
      }),
    ).toEqual([
      {
        operationId: "operation",
        status: "dispatched",
        pending: true,
        patch: { model: "private-choice", effort: null, serviceTier: null },
      },
    ]);
    expect(source.keys).toHaveLength(1);
    expect(source.keys[0]!.every((byte) => byte === 0)).toBe(true);
  });
  it("never labels an older binding's intent pending on the replacement source", async () => {
    const value = await state();
    value.binding = {
      ...binding,
      bindingId: "replacement",
      nativeEpoch: "replacement",
    };
    const result = await openNativeSettingsIntents({
      chatId: "chat",
      state: value,
      options: fixture().options,
    });
    expect(result.every((entry) => !entry.pending)).toBe(true);
  });
  it("rejects lock or identity changes during decrypt and clears keys", async () => {
    for (const change of ["lock", "identity"]) {
      const source = fixture();
      const pending = openNativeSettingsIntents({
        chatId: "chat",
        state: await state(),
        options: source.options,
      });
      if (change === "lock") source.lock();
      else source.options.identityMatches.mockReturnValue(false);
      await expect(pending).rejects.toThrow("session changed");
      expect(source.keys[0]!.every((byte) => byte === 0)).toBe(true);
    }
  });
  it("authenticates operation identity and does not expose another runtime's desired frame", async () => {
    const value = await state();
    value.pending[0]!.intent = {
      ...value.pending[0]!.intent,
      operationId: "substitution",
    };
    value.desired = null;
    await expect(
      openNativeSettingsIntents({
        chatId: "chat",
        state: value,
        options: fixture().options,
      }),
    ).rejects.toThrow();
    const other = await state();
    other.binding = { ...binding, runtimeGeneration: "other" };
    expect(
      await openNativeSettingsIntents({
        chatId: "chat",
        state: other,
        options: fixture().options,
      }),
    ).toEqual([]);
  });
});
