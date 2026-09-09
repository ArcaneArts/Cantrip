import { describe, expect, it } from "vitest";
import type { NativeSettingsSnapshotContext } from "@cantrip/protocol";
import {
  protectNativeSettingsSnapshot,
  openNativeSettingsSnapshot,
} from "../src/native-settings-content.js";
import { nativeThreadSettings } from "./fixtures/native-thread-settings.js";

const context: NativeSettingsSnapshotContext = {
  chatId: "chat",
  workerId: "worker",
  threadId: "thread",
  runtimeGeneration: "runtime",
  settingsVersion: { epoch: "core", revision: "9007199254740993" },
};
const keys = new Map([
  [1, Buffer.alloc(32, 31)],
  [2, Buffer.alloc(32, 71)],
]);
function service(owner = "owner", server = "server", currentRevision = 1) {
  return {
    ownerId: () => owner,
    serverIdentity: () => server,
    componentKey: (_scope: string, revision = currentRevision) => {
      const key = keys.get(revision);
      if (!key) throw new Error("Key unavailable");
      return { keyRevision: revision, key: Buffer.from(key) };
    },
  };
}
function selection() {
  return nativeThreadSettings({
    settingsVersion: context.settingsVersion,
    collaborationMode: {
      mode: "plan",
      settings: {
        model: "private-model",
        reasoning_effort: "high",
        developer_instructions: "private-native-instructions",
      },
    },
    futureSettings: {
      nested: ["keep", null, { secret: "private-value" }],
      enabled: true,
    },
  });
}
const seal = (settings = selection()) =>
  protectNativeSettingsSnapshot({ service: service(), context, settings });

describe("protected native settings state", () => {
  it("preserves complete settings without publishing instructions or native fields", async () => {
    const snapshot = await seal();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("private-");
    expect(serialized).not.toContain("collaborationMode");
    expect(serialized).not.toContain("futureSettings");
    expect(
      await openNativeSettingsSnapshot({
        service: service(),
        context,
        snapshot,
      }),
    ).toEqual(selection());
  });

  it("fingerprints equivalent read/notification objects despite order and fresh ciphertext", async () => {
    const settings = selection();
    const reordered = Object.fromEntries(Object.entries(settings).reverse());
    reordered.futureSettings = {
      enabled: true,
      nested: ["keep", null, { secret: "private-value" }],
    };
    reordered.multiAgentMode = undefined; // The native optional value is omitted on the wire.
    const withoutOptional = { ...settings, multiAgentMode: undefined };
    const first = await protectNativeSettingsSnapshot({
      service: service(),
      context,
      settings: withoutOptional,
    });
    const second = await protectNativeSettingsSnapshot({
      service: service(),
      context,
      settings: reordered,
    });
    expect(first.contentFingerprint).toBe(second.contentFingerprint);
    expect(first.protectedContent.nonce).not.toBe(
      second.protectedContent.nonce,
    );
    const changed = await seal({ ...settings, serviceTier: "priority" });
    expect(changed.contentFingerprint).not.toBe(
      (await seal(settings)).contentFingerprint,
    );
  });

  it.each(["chatId", "workerId", "threadId", "runtimeGeneration"] as const)(
    "rejects %s substitution even when public metadata is rewritten",
    async (key) => {
      const snapshot = await seal();
      const other = { ...context, [key]: "other" };
      await expect(
        openNativeSettingsSnapshot({
          service: service(),
          context: other,
          snapshot,
        }),
      ).rejects.toThrow();
      await expect(
        openNativeSettingsSnapshot({
          service: service(),
          context: other,
          snapshot: { ...snapshot, context: other },
        }),
      ).rejects.toThrow();
    },
  );

  it.each(["epoch", "revision"] as const)(
    "authenticates native %s",
    async (key) => {
      const snapshot = await seal();
      const other = {
        ...context,
        settingsVersion: {
          ...context.settingsVersion,
          [key]: key === "epoch" ? "other" : "9007199254740994",
        },
      };
      await expect(
        openNativeSettingsSnapshot({
          service: service(),
          context: other,
          snapshot: { ...snapshot, context: other },
        }),
      ).rejects.toThrow();
      await expect(
        protectNativeSettingsSnapshot({
          service: service(),
          context: other,
          settings: selection(),
        }),
      ).rejects.toThrow("declared version");
    },
  );

  it("scopes encryption and fingerprints to owner, server and key revision", async () => {
    const snapshot = await seal();
    for (const alternate of [service("other"), service("owner", "other")]) {
      await expect(
        openNativeSettingsSnapshot({ service: alternate, context, snapshot }),
      ).rejects.toThrow();
      expect(
        (
          await protectNativeSettingsSnapshot({
            service: alternate,
            context,
            settings: selection(),
          })
        ).contentFingerprint,
      ).not.toBe(snapshot.contentFingerprint);
    }
    const rotated = service("owner", "server", 2);
    expect(
      await openNativeSettingsSnapshot({ service: rotated, context, snapshot }),
    ).toEqual(selection());
    const replacement = await protectNativeSettingsSnapshot({
      service: rotated,
      context,
      settings: selection(),
    });
    expect(replacement.protectedContent.keyRevision).toBe(2);
    expect(replacement.contentFingerprint).not.toBe(
      snapshot.contentFingerprint,
    );
    expect(
      await openNativeSettingsSnapshot({
        service: rotated,
        context,
        snapshot: replacement,
      }),
    ).toEqual(selection());
  });

  it("rejects fingerprint changes and unversioned snapshots", async () => {
    const snapshot = await seal();
    await expect(
      openNativeSettingsSnapshot({
        service: service(),
        context,
        snapshot: { ...snapshot, contentFingerprint: "0".repeat(64) },
      }),
    ).rejects.toThrow("fingerprint");
    await expect(
      protectNativeSettingsSnapshot({
        service: service(),
        context,
        settings: nativeThreadSettings(),
      }),
    ).rejects.toThrow("declared version");
  });
});
