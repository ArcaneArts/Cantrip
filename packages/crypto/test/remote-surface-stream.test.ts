import { describe, expect, it } from "vitest";

import {
  clearSensitiveBytes,
  decryptRemoteSurfaceStreamPayload,
  deriveComponentKey,
  encryptRemoteSurfaceStreamPayload,
  generateAccountMasterKey,
} from "../src/index.js";

describe("Remote Surface stream encryption", () => {
  it("round-trips binary content and binds attachment, direction, channel, and sequence", async () => {
    const ownerId = "remote-surface-owner";
    const accountKey = generateAccountMasterKey();
    const componentKey = deriveComponentKey({
      accountMasterKey: accountKey,
      ownerId,
      component: "surface-private-state",
      keyRevision: 4,
    });
    const context = {
      serverId: "https://cantrip.example",
      surfaceKind: "desktop" as const,
      surfaceId: "desktop-one",
      attachmentId: "attachment-one",
      direction: "worker-to-client" as const,
      channel: "frame" as const,
      sequence: 8,
    };
    const plaintext = new TextEncoder().encode(
      "private remote desktop frame bytes",
    );
    try {
      const protectedPayload = await encryptRemoteSurfaceStreamPayload({
        ownerId,
        context,
        keyRevision: 4,
        componentKey,
        plaintext,
      });
      expect(new TextDecoder().decode(protectedPayload)).not.toContain(
        "private remote desktop frame bytes",
      );
      await expect(
        decryptRemoteSurfaceStreamPayload({
          ownerId,
          context,
          keyRevision: 4,
          componentKey,
          protectedPayload,
        }),
      ).resolves.toEqual(plaintext);
      const tamperedPayload = protectedPayload.slice();
      tamperedPayload[tamperedPayload.byteLength - 1] ^= 1;
      await expect(
        decryptRemoteSurfaceStreamPayload({
          ownerId,
          context,
          keyRevision: 4,
          componentKey,
          protectedPayload: tamperedPayload,
        }),
      ).rejects.toThrow();
      for (const changed of [
        { ...context, attachmentId: "attachment-two" },
        { ...context, direction: "client-to-worker" as const },
        { ...context, channel: "control" as const },
        { ...context, sequence: 9 },
      ]) {
        await expect(
          decryptRemoteSurfaceStreamPayload({
            ownerId,
            context: changed,
            keyRevision: 4,
            componentKey,
            protectedPayload,
          }),
        ).rejects.toThrow();
      }
    } finally {
      clearSensitiveBytes(accountKey);
      clearSensitiveBytes(componentKey);
      clearSensitiveBytes(plaintext);
    }
  });
});
