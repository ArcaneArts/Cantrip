import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { protectedNativeSettingsSnapshotSchema } from "@cantrip/protocol";
import {
  decryptNativeSettingsSnapshot,
  encryptNativeSettingsSnapshot,
} from "../src/native-settings.js";

// Captured from the original worker implementation using node:crypto, before
// moving encryption into this browser-compatible package. Do not regenerate
// this fixture with the implementation under test.
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/native-settings-v1.json", import.meta.url),
    "utf8",
  ),
);
const snapshot = protectedNativeSettingsSnapshotSchema.parse(fixture.snapshot);
const key = () => new Uint8Array(32).fill(fixture.componentKeyByte);
const material = () => ({
  ownerId: fixture.ownerId as string,
  serverId: fixture.serverId as string,
  componentKey: key(),
  keyRevision: snapshot.protectedContent.keyRevision,
  context: snapshot.context,
});

describe("native settings encryption compatibility", () => {
  it("opens the original worker ciphertext without losing fields or u64 precision", async () => {
    const input = material();
    expect(await decryptNativeSettingsSnapshot({ ...input, snapshot })).toEqual(
      fixture.settings,
    );
    expect(input.componentKey).toEqual(key()); // Caller retains ownership.
  });

  it("preserves the original fingerprint with fresh ciphertext and reordered fields", async () => {
    const input = material();
    const settings = Object.fromEntries(
      Object.entries(fixture.settings).reverse(),
    );
    settings.future = { a: 3, z: [null, true, "fixture"] };
    const encrypted = await encryptNativeSettingsSnapshot({
      ...input,
      settings,
    });
    expect(encrypted.contentFingerprint).toBe(snapshot.contentFingerprint);
    expect(encrypted.protectedContent.nonce).not.toBe(
      snapshot.protectedContent.nonce,
    );
    expect(
      await decryptNativeSettingsSnapshot({ ...input, snapshot: encrypted }),
    ).toEqual(fixture.settings);
    expect(input.componentKey).toEqual(key());
  });

  it("rejects owner, server, key and fingerprint substitution", async () => {
    for (const alteration of [
      { ownerId: "another-owner" },
      { serverId: "another-server" },
      { componentKey: new Uint8Array(32).fill(99) },
      { keyRevision: 2 },
      { snapshot: { ...snapshot, contentFingerprint: "0".repeat(64) } },
    ]) {
      await expect(
        decryptNativeSettingsSnapshot({
          ...material(),
          snapshot,
          ...alteration,
        }),
      ).rejects.toThrow();
    }
  });
});
