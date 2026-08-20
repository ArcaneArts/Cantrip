import { describe, expect, it } from "vitest";

import {
  encryptedGithubProjectCreateSchema,
  encryptedManagedFolderProjectCreateSchema,
  projectWireSummarySchema,
} from "../src/index.js";
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

  it("keeps project display names out of create requests and wire summaries", () => {
    const id = "019fe8aa-a7a3-7404-8a96-d3be7f0fb338";
    const nameProtection = {
      classification: { recordKind: "project" as const },
      protectedLabel: encrypted,
    };

    expect(
      encryptedGithubProjectCreateSchema.safeParse({
        id,
        nameProtection,
        workerId: "worker-one",
        repositoryId: "repository-one",
        nameWithOwner: "ArcaneArts/Cantrip",
        url: "https://github.com/ArcaneArts/Cantrip",
        name: "Private project name",
      }).success,
    ).toBe(false);
    expect(
      encryptedManagedFolderProjectCreateSchema.safeParse({
        id,
        nameProtection,
        workerId: "worker-one",
        name: "Private project name",
      }).success,
    ).toBe(false);

    const wire = projectWireSummarySchema.parse({
      id,
      nameProtection,
      position: 0,
      setupStatus: "ready",
      setupError: null,
      worktreePolicy: "agent-managed",
      preferredWorkerId: null,
      github: {
        repositoryId: "repository-one",
        nameWithOwner: "ArcaneArts/Cantrip",
        url: "https://github.com/ArcaneArts/Cantrip",
      },
      source: null,
      createdAt: "2026-08-18T12:00:00.000Z",
      updatedAt: "2026-08-18T12:00:00.000Z",
    });
    expect(wire).not.toHaveProperty("name");
    expect(
      projectWireSummarySchema.safeParse({
        ...wire,
        nameProtection: {
          ...nameProtection,
          classification: { recordKind: "chat" },
        },
      }).success,
    ).toBe(false);
  });
});
