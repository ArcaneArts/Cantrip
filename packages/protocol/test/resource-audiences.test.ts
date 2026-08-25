import {
  encryptedMcpServerCreateSchema,
  encryptedMcpServerUpdateSchema,
  resourceAudienceSchema,
  skillAudienceUpdateSchema,
} from "../src/index.js";
import {
  encryptedPolicyCreateSchema,
  encryptedPolicyUpdateSchema,
} from "../src/policies.js";
import { describe, expect, it } from "vitest";

const protectedContent = {
  formatVersion: 1 as const,
  keyRevision: 1,
  envelope: {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyRevision: 1,
    nonce: "A".repeat(16),
    ciphertext: "A".repeat(43),
  },
};
const opaqueKey = Buffer.alloc(32, 19).toString("base64url");

describe("resource audiences", () => {
  it("accepts IDE, Chat, and Both while defaulting new records to IDE", () => {
    expect(resourceAudienceSchema.options).toEqual(["ide", "chat", "both"]);
    expect(
      encryptedMcpServerCreateSchema.parse({
        id: crypto.randomUUID(),
        enabled: true,
        workerId: null,
        nameBlindIndex: opaqueKey,
        protectedConfiguration: protectedContent,
      }).audience,
    ).toBe("ide");
    expect(
      encryptedPolicyCreateSchema.parse({
        id: crypto.randomUUID(),
        content: {
          keyBlindIndex: opaqueKey,
          protectedSummary: protectedContent,
          protectedBody: protectedContent,
        },
        enabled: true,
        mandatory: false,
        templateKey: null,
      }).audience,
    ).toBe("ide");
  });

  it("does not overwrite audience when an older update omits it", () => {
    expect(
      encryptedMcpServerUpdateSchema.parse({
        enabled: true,
        workerId: null,
        nameBlindIndex: opaqueKey,
        protectedConfiguration: protectedContent,
      }),
    ).not.toHaveProperty("audience");
    expect(
      encryptedPolicyUpdateSchema.parse({ rowVersion: 1, enabled: false }),
    ).not.toHaveProperty("audience");
  });

  it("validates opaque Skill audience metadata", () => {
    expect(
      skillAudienceUpdateSchema.parse({
        workerId: "worker-a",
        providerId: "provider-a",
        audienceKey: opaqueKey,
        audience: "both",
      }),
    ).toMatchObject({ audience: "both" });
  });
});
