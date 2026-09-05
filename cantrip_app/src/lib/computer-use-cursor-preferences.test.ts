import { describe, expect, it, vi } from "vitest";
import {
  userSettingsSchema,
  userSettingsUpdateSchema,
} from "@cantrip/protocol";
import type { CuaCursorAppearance } from "@cantrip/protocol/computer-use";
import { cuaCursorPreferenceRecordSchema } from "@cantrip/protocol/computer-use-preferences";
import type {
  ClientSessionContext,
  ClientSessionIdentitySnapshot,
} from "./client-session";
import type {
  ClientEncryptionService,
  ClientEncryptionSnapshot,
} from "./client-encryption";

vi.mock("./api-client", () => ({ request: vi.fn() }));
vi.mock("./client-encryption", () => ({
  clientEncryption: undefined,
  ClientEncryptionError: class extends Error {},
}));
vi.mock("./client-session", () => ({
  getClientSession: () => null,
  getClientSessionIdentitySnapshot: () => null,
  clientSessionIdentityMatches: () => false,
}));
import {
  openEndpointContent,
  protectEndpointContent,
} from "./endpoint-content-encryption";
import { createComputerUseCursorPreferences } from "./computer-use-cursor-preferences";

const appearance: CuaCursorAppearance = {
  version: 1,
  style: "crosshair",
  size: 32,
  color: "#FFFFFFFF",
  label: "Private saved CUA preference label",
  trail: true,
  visible: true,
};

function fixture(ownerId = "owner", serverId = "server") {
  const identity: ClientSessionIdentitySnapshot = {
    accountId: ownerId,
    connectionId: "connection",
    generation: 1,
    incarnationId: "incarnation",
    serverId,
    serverUrl: "https://server.test",
    userId: ownerId,
  };
  const snapshot: ClientEncryptionSnapshot = {
    status: "ready",
    identity: { ownerId, serverId },
    masterKeyRevision: 3,
    clientId: "client",
  };
  const keys: Uint8Array[] = [];
  const service = {
    getSnapshot: () => snapshot,
    componentKey: () => {
      const key = new Uint8Array(32).fill(31);
      keys.push(key);
      return key;
    },
  } as unknown as ClientEncryptionService;
  const options = {
    service,
    session: () =>
      ({ serverId, user: { id: ownerId } }) as ClientSessionContext,
  };
  const preferences = userSettingsSchema.parse({
    theme: "dark",
    highContrast: false,
    proMode: false,
    proModeOpacity: 80,
    sidebarWidth: 288,
    desktopFrameRate: 30,
    desktopStreamQuality: "adaptive",
    defaultModelId: null,
  });
  const send = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === "PATCH")
      Object.assign(
        preferences,
        userSettingsUpdateSchema.parse(JSON.parse(String(init.body))),
      );
    return JSON.parse(
      JSON.stringify({ preferences, providers: [], models: [] }),
    );
  });
  let active = true;
  const dependencies = {
    identity: () => identity,
    matches: () => active,
    encryption: service,
    request: send,
    protect: (<T>(input: Parameters<typeof protectEndpointContent<T>>[0]) =>
      protectEndpointContent({
        ...input,
        options,
      })) as typeof protectEndpointContent,
    open: (<T>(input: Parameters<typeof openEndpointContent<T>>[0]) =>
      openEndpointContent({ ...input, options })) as typeof openEndpointContent,
  };
  return {
    preferences,
    send,
    keys,
    snapshot,
    dependencies,
    deactivate: () => {
      active = false;
    },
    store: () => createComputerUseCursorPreferences(dependencies),
  };
}

describe("protected cursor account preferences", () => {
  it("round-trips all appearance fields through a new client using only ciphertext and clears explicitly", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    expect(await f.store().load(signal)).toBeNull();
    await f.store().save(appearance, signal);
    const patch = f.send.mock.calls.find(
      ([, init]) => init?.method === "PATCH",
    )![1]!;
    expect(String(patch.body)).not.toContain(appearance.label);
    expect(Object.keys(JSON.parse(String(patch.body)))).toEqual([
      "protectedComputerUseCursor",
    ]);
    expect(await f.store().load(signal)).toEqual(appearance);
    expect(f.preferences.theme).toBe("dark");
    expect(f.keys.every((key) => key.every((byte) => byte === 0))).toBe(true);
    await f.store().save(null, signal);
    expect(await f.store().load(signal)).toBeNull();
  });
  it.each(["owner", "server", "operation", "ciphertext", "revision"])(
    "rejects changed %s binding",
    async (change) => {
      const source = fixture();
      const signal = new AbortController().signal;
      await source.store().save(appearance, signal);
      const target = fixture(
        change === "owner" ? "other-owner" : "owner",
        change === "server" ? "other-server" : "server",
      );
      target.preferences.protectedComputerUseCursor = structuredClone(
        source.preferences.protectedComputerUseCursor,
      );
      const record = target.preferences.protectedComputerUseCursor!;
      if (change === "operation") record.operationId = crypto.randomUUID();
      if (change === "revision") record.protectedContent.keyRevision += 1;
      if (change === "ciphertext") {
        const value = record.protectedContent.envelope.ciphertext;
        record.protectedContent.envelope.ciphertext =
          (value[0] === "A" ? "B" : "A") + value.slice(1);
      }
      await expect(target.store().load(signal)).rejects.toThrow();
    },
  );
  it.each(["account", "revision", "stop"])(
    "does not submit a late save after %s changes",
    async (change) => {
      const f = fixture();
      const controller = new AbortController();
      const original = f.dependencies.protect;
      f.dependencies.protect = async (input) => {
        const value = await original(input);
        if (change === "account") f.deactivate();
        if (change === "revision") f.snapshot.masterKeyRevision = 4;
        if (change === "stop") controller.abort();
        return value;
      };
      await expect(
        f.store().save(appearance, controller.signal),
      ).rejects.toThrow();
      expect(f.send).not.toHaveBeenCalled();
    },
  );
  it("validates settings envelope bounds and excludes transient state from the encrypted payload", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    await expect(
      f
        .store()
        .save(
          { ...appearance, targetId: "private-window" } as CuaCursorAppearance,
          signal,
        ),
    ).rejects.toThrow();
    await f.store().save(appearance, signal);
    const record = f.preferences.protectedComputerUseCursor!;
    expect(
      cuaCursorPreferenceRecordSchema.safeParse({
        ...record,
        sessionId: "session",
      }).success,
    ).toBe(false);
    expect(
      userSettingsUpdateSchema.safeParse({
        protectedComputerUseCursor: appearance,
      }).success,
    ).toBe(false);
    expect(
      cuaCursorPreferenceRecordSchema.safeParse({
        ...record,
        protectedContent: {
          ...record.protectedContent,
          domain: "client-control-content",
        },
      }).success,
    ).toBe(false);
    expect(
      cuaCursorPreferenceRecordSchema.safeParse({
        ...record,
        protectedContent: {
          ...record.protectedContent,
          envelope: {
            ...record.protectedContent.envelope,
            ciphertext: "A".repeat(6000),
          },
        },
      }).success,
    ).toBe(false);
  });
});
