import { serializePayloadEnvelope } from "@cantrip/crypto";
import { expect, it } from "vitest";

it("uses the canonical encrypted-envelope encoding in the app", () => {
  expect(
    serializePayloadEnvelope({
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 2,
      nonce: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
    }),
  ).toBe(
    '{"algorithm":"AES-256-GCM","ciphertext":"AAAAAAAAAAAAAAAAAAAAAA","keyRevision":2,"nonce":"AAAAAAAAAAAAAAAA","version":1}',
  );
});
