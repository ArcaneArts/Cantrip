import { describe, expect, it } from "vitest";

import {
  runConfigurationProtectedSecretListSchema,
  runConfigurationSecretListResultSchema,
  runConfigurationSecretProtectionRowId,
  runConfigurationSecretSetRequestSchema,
  runConfigurationSecretSetResultSchema,
  runConfigurationSecretValueContentSchema,
} from "./run-configuration-secrets.js";

const projectId = "f288701f-e4a6-4d08-bd54-eddb41aadbe5";
const operationId = "b455011d-47c5-478a-a74c-3d2635511263";
const timestamp = "2026-08-24T12:00:00.000Z";
const protectedValue = {
  formatVersion: 1 as const,
  keyRevision: 3,
  envelope: {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyRevision: 3,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};

describe("Run configuration secret protocol", () => {
  it("binds protection to an exact project and reference", () => {
    expect(
      runConfigurationSecretProtectionRowId({
        projectId,
        reference: "project/database-url",
      }),
    ).toBe(`["${projectId}","project/database-url"]`);
    expect(() =>
      runConfigurationSecretProtectionRowId({
        projectId,
        reference: "project/../database-url",
      }),
    ).toThrow();
  });

  it("keeps public metadata value-free and requires correlated set results", () => {
    const listed = runConfigurationSecretListResultSchema.parse({
      projectId,
      secrets: [
        {
          reference: "project/database-url",
          available: true,
          revision: 2,
          updatedAt: timestamp,
        },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain("protectedValue");
    expect(() =>
      runConfigurationSecretListResultSchema.parse({
        projectId,
        secrets: [
          {
            reference: "project/database-url",
            available: false,
            revision: 2,
            updatedAt: timestamp,
          },
        ],
      }),
    ).toThrow();

    expect(
      runConfigurationSecretSetRequestSchema.parse({
        operationId,
        reference: "project/database-url",
        protectedValue,
      }),
    ).toMatchObject({ operationId, protectedValue });
    expect(
      runConfigurationSecretSetResultSchema.parse({
        operationId,
        projectId,
        replayed: false,
        secret: {
          reference: "project/database-url",
          available: true,
          revision: 1,
          updatedAt: timestamp,
        },
      }).secret,
    ).not.toHaveProperty("protectedValue");
  });

  it("bounds values and rejects duplicate protected references", () => {
    expect(
      runConfigurationSecretValueContentSchema.parse({
        version: 1,
        value: "secret-plaintext-sentinel",
      }).value,
    ).toBe("secret-plaintext-sentinel");
    expect(() =>
      runConfigurationSecretValueContentSchema.parse({
        version: 1,
        value: "contains\0nul",
      }),
    ).toThrow();
    expect(() =>
      runConfigurationProtectedSecretListSchema.parse([
        { reference: "project/token", revision: 1, protectedValue },
        { reference: "project/token", revision: 2, protectedValue },
      ]),
    ).toThrow();
    expect(() =>
      runConfigurationProtectedSecretListSchema.parse([
        {
          reference: "project/token",
          revision: 1,
          protectedValue: {
            ...protectedValue,
            envelope: {
              ...protectedValue.envelope,
              ciphertext: "A".repeat(90_000),
            },
          },
        },
      ]),
    ).toThrow("byte limit");
  });
});
