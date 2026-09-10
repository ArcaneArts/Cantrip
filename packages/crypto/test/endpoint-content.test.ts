import { describe, expect, it } from "vitest";
import {
  ENDPOINT_CONTENT_PROTECTED_BYTES_LIMIT,
  endpointContentOpaqueSchema,
} from "@cantrip/protocol/endpoint-content";
import {
  computerUseRequestSchema,
  computerUseResponseSchema,
} from "@cantrip/protocol/computer-use";

import {
  clearSensitiveBytes,
  decryptEndpointContentPayload,
  deriveComponentKey,
  encryptEndpointContentPayload,
  generateAccountMasterKey,
} from "../src/index.js";

describe("endpoint content encryption", () => {
  it("round-trips the full endpoint byte limit including the AEAD tag", async () => {
    const plaintext = new Uint8Array(
      ENDPOINT_CONTENT_PROTECTED_BYTES_LIMIT,
    ).fill(0xa5);
    const componentKey = new Uint8Array(32).fill(0x37);
    const context = {
      domain: "client-control-content" as const,
      serverId: "https://cantrip.example",
      workerId: "worker-one",
      scopeId: "chat-one",
      operationId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      operation: "input.perform",
      direction: "request" as const,
      sequence: 0,
    };
    const binding = {
      ownerId: "endpoint-owner",
      context,
      keyRevision: 1,
      componentKey,
    };
    let opened: Uint8Array | undefined;
    try {
      const opaque = await encryptEndpointContentPayload({
        ...binding,
        plaintext,
      });
      expect(Buffer.from(opaque.envelope.ciphertext, "base64url").length).toBe(
        plaintext.length + 16,
      );
      expect(
        computerUseRequestSchema.safeParse({
          operationId: context.operationId,
          operation: context.operation,
          protectedContent: opaque,
        }).success,
      ).toBe(true);
      expect(
        computerUseResponseSchema.safeParse({
          operationId: context.operationId,
          protectedContent: opaque,
        }).success,
      ).toBe(true);
      opened = await decryptEndpointContentPayload({ ...binding, opaque });
      expect(Buffer.compare(Buffer.from(opened), Buffer.from(plaintext))).toBe(
        0,
      );
      // A canonical ciphertext just one byte larger must still be rejected.
      const oversized = {
        ...opaque,
        envelope: {
          ...opaque.envelope,
          ciphertext: Buffer.alloc(plaintext.length + 17).toString("base64url"),
        },
      };
      expect(endpointContentOpaqueSchema.safeParse(oversized).success).toBe(
        false,
      );
      await expect(
        encryptEndpointContentPayload({
          ...binding,
          plaintext: new Uint8Array(plaintext.length + 1),
        }),
      ).rejects.toThrow("Protected endpoint content is too large.");
    } finally {
      clearSensitiveBytes(componentKey);
      clearSensitiveBytes(plaintext);
      if (opened) clearSensitiveBytes(opened);
    }
  });

  it("round-trips each domain and authenticates routing context", async () => {
    const ownerId = "endpoint-owner";
    const accountKey = generateAccountMasterKey();
    const plaintext = new TextEncoder().encode("private endpoint content");
    const domains = [
      "run-content",
      "customization-content",
      "tunnel-content",
      "client-control-content",
    ] as const;
    try {
      for (const domain of domains) {
        const componentKey = deriveComponentKey({
          accountMasterKey: accountKey,
          ownerId,
          component: domain,
          keyRevision: 2,
        });
        const context = {
          domain,
          serverId: "https://cantrip.example",
          workerId: "worker-one",
          scopeId: "project-one",
          operationId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
          operation: "foundation.round-trip",
          direction: "request" as const,
          sequence: 0,
        };
        try {
          const opaque = await encryptEndpointContentPayload({
            ownerId,
            context,
            keyRevision: 2,
            componentKey,
            plaintext,
          });
          expect(JSON.stringify(opaque)).not.toContain(
            "private endpoint content",
          );
          await expect(
            decryptEndpointContentPayload({
              ownerId,
              context,
              keyRevision: 2,
              componentKey,
              opaque,
            }),
          ).resolves.toEqual(plaintext);
          await expect(
            decryptEndpointContentPayload({
              ownerId,
              context: { ...context, sequence: 1 },
              keyRevision: 2,
              componentKey,
              opaque,
            }),
          ).rejects.toThrow();
        } finally {
          clearSensitiveBytes(componentKey);
        }
      }
    } finally {
      clearSensitiveBytes(accountKey);
      clearSensitiveBytes(plaintext);
    }
  });
});
