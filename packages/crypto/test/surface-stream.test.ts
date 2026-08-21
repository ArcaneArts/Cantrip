import { describe, expect, it } from "vitest";

import {
  clearSensitiveBytes,
  decryptSurfaceStreamPayload,
  deriveComponentKey,
  encryptSurfaceStreamPayload,
  generateAccountMasterKey,
} from "../src/index.js";

describe("surface stream encryption", () => {
  it("round-trips content and binds the operation, direction, and sequence", async () => {
    const ownerId = "surface-stream-owner";
    const accountKey = generateAccountMasterKey();
    const componentKey = deriveComponentKey({
      accountMasterKey: accountKey,
      ownerId,
      component: "surface-private-state",
      keyRevision: 3,
    });
    const context = {
      serverId: "https://cantrip.example",
      surfaceKind: "terminal" as const,
      surfaceId: "terminal-one",
      operationId: "operation-one",
      direction: "output" as const,
      sequence: 4,
    };
    const plaintext = new TextEncoder().encode("private terminal output");
    try {
      const opaque = await encryptSurfaceStreamPayload({
        ownerId,
        context,
        keyRevision: 3,
        componentKey,
        plaintext,
      });
      await expect(
        decryptSurfaceStreamPayload({
          ownerId,
          context,
          keyRevision: 3,
          componentKey,
          opaque,
        }),
      ).resolves.toEqual(plaintext);
      for (const changed of [
        { ...context, operationId: "operation-two" },
        { ...context, direction: "input" as const },
        { ...context, sequence: 5 },
      ]) {
        await expect(
          decryptSurfaceStreamPayload({
            ownerId,
            context: changed,
            keyRevision: 3,
            componentKey,
            opaque,
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
