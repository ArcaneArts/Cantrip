import { describe, expect, it } from "vitest";

import {
  encryptedPrivateDisplayLabelSchema,
  privateDisplayLabelOpaqueSchema,
  privateDisplayLabelProtectedContentSchema,
  privateDisplayLabelRecordKindSchema,
} from "../src/private-labels.js";

const encrypted = {
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

describe("private display-label encryption contracts", () => {
  it("defines every protected label kind in one opaque wire shape", () => {
    expect(privateDisplayLabelRecordKindSchema.options).toEqual([
      "project",
      "chat",
      "terminal",
      "explorer",
      "code-tab",
      "browser",
      "remote-surface",
      "project-view",
      "tab-group",
    ]);
    const opaque = privateDisplayLabelOpaqueSchema.parse({
      classification: { recordKind: "project" },
      protectedLabel: encrypted,
    });
    expect(opaque).not.toHaveProperty("label");
    expect(opaque.protectedLabel.envelope.ciphertext).toBe(
      encrypted.envelope.ciphertext,
    );
  });

  it("keeps decrypted content strict and distinct from server-visible data", () => {
    const content = privateDisplayLabelProtectedContentSchema.parse({
      version: 1,
      classification: { recordKind: "chat" },
      label: "Private planning chat",
    });
    expect(content.label).toBe("Private planning chat");
    expect(
      privateDisplayLabelProtectedContentSchema.safeParse({
        ...content,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      privateDisplayLabelOpaqueSchema.safeParse({
        classification: content.classification,
        protectedLabel: encrypted,
        label: content.label,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown versions, revision disagreement, and oversized envelopes", () => {
    expect(
      encryptedPrivateDisplayLabelSchema.safeParse({
        ...encrypted,
        formatVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      encryptedPrivateDisplayLabelSchema.safeParse({
        ...encrypted,
        keyRevision: 4,
      }).success,
    ).toBe(false);
    expect(
      encryptedPrivateDisplayLabelSchema.safeParse({
        ...encrypted,
        envelope: {
          ...encrypted.envelope,
          ciphertext: "A".repeat(6_000),
        },
      }).success,
    ).toBe(false);
  });
});
