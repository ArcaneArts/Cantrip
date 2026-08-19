import { describe, expect, it } from "vitest";

import {
  encryptedPayloadEnvelopeSchema,
  passwordKdfParametersSchema,
  workerComponentKeyGrantSchema,
} from "../src/encryption.js";

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
});
