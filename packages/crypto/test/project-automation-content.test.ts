import { projectAutomationProtectedPromptSchema } from "@cantrip/protocol/automations";
import { describe, expect, it } from "vitest";

import {
  clearSensitiveBytes,
  decryptProjectAutomationContent,
  deriveComponentKey,
  encryptProjectAutomationContent,
  generateAccountMasterKey,
  projectAutomationContentAssociatedData,
} from "../src/index.js";

const contentSchema = projectAutomationProtectedPromptSchema;
const context = {
  recordKind: "project-automation" as const,
  recordId: "automation-one",
  field: "prompt" as const,
};

const frozenLegacyCiphertext = {
  formatVersion: 1 as const,
  keyRevision: 2,
  envelope: {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyRevision: 2,
    nonce: "svrMjq2VjFfwhPPZ",
    ciphertext:
      "R4qknmjizre5DY_KRkfqL4K6dYVTLbeQox0PQg9FI__fRWiOogYheU-Ii3PuK7pJcQfcAayXME9E5mHzqBYWHA",
  },
};

function legacyFixtureAccountMasterKey() {
  return Uint8Array.from({ length: 32 }, (_, index) => index);
}

describe("project automation content encryption", () => {
  it("preserves the legacy associated-data contract", () => {
    expect(
      projectAutomationContentAssociatedData({
        ownerId: "automation-owner",
        context,
        keyRevision: 2,
      }),
    ).toMatchObject({
      component: "workflow-content",
      table: "workflow:project-automation",
      rowId: "automation-one",
      field: "prompt",
      formatVersion: 1,
      keyRevision: 2,
    });
  });

  it("decrypts ciphertext produced by the removed legacy workflow API", async () => {
    const ownerId = "automation-owner";
    const accountKey = legacyFixtureAccountMasterKey();
    const componentKey = deriveComponentKey({
      accountMasterKey: accountKey,
      ownerId,
      component: "workflow-content",
      keyRevision: 2,
    });
    try {
      await expect(
        decryptProjectAutomationContent({
          ownerId,
          context,
          keyRevision: 2,
          componentKey,
          encrypted: frozenLegacyCiphertext,
          schema: contentSchema,
        }),
      ).resolves.toEqual({
        version: 1,
        prompt: "SENTINEL private prompt",
      });
    } finally {
      clearSensitiveBytes(accountKey);
      clearSensitiveBytes(componentKey);
    }
  });

  it("round-trips new Project Automation ciphertext", async () => {
    const ownerId = "automation-owner";
    const accountKey = legacyFixtureAccountMasterKey();
    const componentKey = deriveComponentKey({
      accountMasterKey: accountKey,
      ownerId,
      component: "workflow-content",
      keyRevision: 2,
    });
    const content = { version: 1 as const, prompt: "SENTINEL private prompt" };
    try {
      const encrypted = await encryptProjectAutomationContent({
        ownerId,
        context,
        keyRevision: 2,
        componentKey,
        content,
        schema: contentSchema,
      });
      await expect(
        decryptProjectAutomationContent({
          ownerId,
          context,
          keyRevision: 2,
          componentKey,
          encrypted,
          schema: contentSchema,
        }),
      ).resolves.toEqual(content);
      expect(JSON.stringify(encrypted)).not.toContain("SENTINEL");
    } finally {
      clearSensitiveBytes(accountKey);
      clearSensitiveBytes(componentKey);
    }
  });

  it("binds ciphertext to the automation record and field", async () => {
    const ownerId = "automation-owner";
    const accountKey = generateAccountMasterKey();
    const componentKey = deriveComponentKey({
      accountMasterKey: accountKey,
      ownerId,
      component: "workflow-content",
      keyRevision: 2,
    });
    try {
      const encrypted = await encryptProjectAutomationContent({
        ownerId,
        context,
        keyRevision: 2,
        componentKey,
        content: { version: 1 as const, prompt: "private prompt" },
        schema: contentSchema,
      });
      await expect(
        decryptProjectAutomationContent({
          ownerId,
          context: { ...context, recordId: "automation-two" },
          keyRevision: 2,
          componentKey,
          encrypted,
          schema: contentSchema,
        }),
      ).rejects.toThrow();
    } finally {
      clearSensitiveBytes(accountKey);
      clearSensitiveBytes(componentKey);
    }
  });
});
