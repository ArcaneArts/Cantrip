import { projectAutomationProtectedPromptSchema } from "@cantrip/protocol/automations";
import { describe, expect, it } from "vitest";

import {
  clearSensitiveBytes,
  decryptProjectAutomationContent,
  decryptWorkflowContent,
  deriveComponentKey,
  encryptProjectAutomationContent,
  encryptWorkflowContent,
  generateAccountMasterKey,
  projectAutomationContentAssociatedData,
  workflowContentAssociatedData,
} from "../src/index.js";

const contentSchema = projectAutomationProtectedPromptSchema;
const context = {
  recordKind: "project-automation" as const,
  recordId: "automation-one",
  field: "prompt" as const,
};

describe("project automation content encryption", () => {
  it("preserves the legacy associated-data contract", () => {
    const input = { ownerId: "automation-owner", context, keyRevision: 2 };
    expect(projectAutomationContentAssociatedData(input)).toEqual(
      workflowContentAssociatedData(input),
    );
    expect(projectAutomationContentAssociatedData(input)).toMatchObject({
      component: "workflow-content",
      table: "workflow:project-automation",
    });
  });

  it("decrypts legacy ciphertext and remains readable by the legacy API", async () => {
    const ownerId = "automation-owner";
    const accountKey = generateAccountMasterKey();
    const componentKey = deriveComponentKey({
      accountMasterKey: accountKey,
      ownerId,
      component: "workflow-content",
      keyRevision: 2,
    });
    const content = { version: 1 as const, prompt: "SENTINEL private prompt" };
    try {
      const legacyEncrypted = await encryptWorkflowContent({
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
          encrypted: legacyEncrypted,
          schema: contentSchema,
        }),
      ).resolves.toEqual(content);

      const encrypted = await encryptProjectAutomationContent({
        ownerId,
        context,
        keyRevision: 2,
        componentKey,
        content,
        schema: contentSchema,
      });
      await expect(
        decryptWorkflowContent({
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
