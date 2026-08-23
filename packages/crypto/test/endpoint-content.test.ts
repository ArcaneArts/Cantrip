import { describe, expect, it } from "vitest";

import {
  clearSensitiveBytes,
  decryptEndpointContentPayload,
  deriveComponentKey,
  encryptEndpointContentPayload,
  generateAccountMasterKey,
} from "../src/index.js";

describe("endpoint content encryption", () => {
  it("round-trips each domain and authenticates routing context", async () => {
    const ownerId = "endpoint-owner";
    const accountKey = generateAccountMasterKey();
    const plaintext = new TextEncoder().encode("private endpoint content");
    const domains = [
      "run-content",
      "customization-content",
      "tunnel-content",
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
