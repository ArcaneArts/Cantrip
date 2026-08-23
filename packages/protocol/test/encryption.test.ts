import { describe, expect, it } from "vitest";

import {
  encryptedPayloadEnvelopeSchema,
  passwordKdfParametersSchema,
  workerComponentKeyGrantSchema,
  workerEncryptionBootstrapResultSchema,
  workerEncryptionRefreshRequestSchema,
  workerEncryptionRefreshResultSchema,
} from "../src/encryption.js";
import { workerCommandSchema } from "../src/index.js";

describe("encryption protocol", () => {
  it("accepts the versioned payload and KDF formats", () => {
    expect(
      encryptedPayloadEnvelopeSchema.parse({
        version: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      }),
    ).toBeTruthy();
    expect(
      passwordKdfParametersSchema.parse({
        algorithm: "Argon2id",
        version: 19,
        context: "cantrip:e2ee:password-kek:v1",
        memoryKiB: 65_536,
        iterations: 3,
        parallelism: 1,
        outputBytes: 32,
        salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    ).toBeTruthy();
  });

  it("rejects unknown versions and Account Master Key worker grants", () => {
    expect(() =>
      encryptedPayloadEnvelopeSchema.parse({
        version: 2,
        algorithm: "AES-256-GCM",
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      }),
    ).toThrow();
    expect(() =>
      encryptedPayloadEnvelopeSchema.parse({
        version: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAB",
      }),
    ).toThrow(/canonical/iu);
    expect(() =>
      workerComponentKeyGrantSchema.parse({
        version: 1,
        purpose: "worker-component-key",
        workerId: "worker-1",
        component: "account-master-key",
        keyRevision: 1,
        envelope: {},
      }),
    ).toThrow();
  });

  it("bounds scoped worker refresh commands and opaque readiness results", () => {
    const request = {
      component: "task-content" as const,
      keyRevision: 3,
    };
    expect(workerEncryptionRefreshRequestSchema.parse(request)).toEqual(
      request,
    );
    expect(
      workerCommandSchema.parse({
        type: "worker.encryption.refresh",
        ...request,
      }),
    ).toEqual({ type: "worker.encryption.refresh", ...request });
    expect(
      workerEncryptionRefreshResultSchema.parse({
        ...request,
        status: {
          supported: true,
          state: "ready",
          principalId: "11111111-1111-4111-8111-111111111111",
          grants: [request],
          lastSyncedAt: "2026-08-19T12:00:00.000Z",
          error: null,
        },
      }).status.grants,
    ).toEqual([request]);
    expect(
      workerEncryptionRefreshRequestSchema.safeParse({
        component: "account-master-key",
        keyRevision: 3,
      }).success,
    ).toBe(false);
  });

  it("requires a logical server UUID in worker bootstrap results", () => {
    expect(
      workerEncryptionBootstrapResultSchema.shape.serverId.parse(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ),
    ).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(
      workerEncryptionBootstrapResultSchema.shape.serverId.safeParse(
        "https://cantrip.test",
      ).success,
    ).toBe(false);
  });
});
