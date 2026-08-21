import { projectAutomationProtectedPromptSchema } from "@cantrip/protocol/automations";
import { describe, expect, it } from "vitest";

import {
  clearSensitiveBytes,
  decryptWorkflowContent,
  deriveComponentKey,
  encryptWorkflowContent,
  generateAccountMasterKey,
} from "../src/index.js";

const contentSchema = projectAutomationProtectedPromptSchema;

describe("workflow content encryption", () => {
  it("binds protected content to its record and field", async () => {
    const ownerId = "workflow-owner";
    const accountKey = generateAccountMasterKey();
    const componentKey = deriveComponentKey({
      accountMasterKey: accountKey,
      ownerId,
      component: "workflow-content",
      keyRevision: 2,
    });
    const context = {
      recordKind: "project-automation" as const,
      recordId: "automation-one",
      field: "prompt" as const,
    };
    try {
      const encrypted = await encryptWorkflowContent({
        ownerId,
        context,
        keyRevision: 2,
        componentKey,
        content: { version: 1 as const, prompt: "SENTINEL private prompt" },
        schema: contentSchema,
      });
      expect(JSON.stringify(encrypted)).not.toContain("SENTINEL");
      await expect(
        decryptWorkflowContent({
          ownerId,
          context,
          keyRevision: 2,
          componentKey,
          encrypted,
          schema: contentSchema,
        }),
      ).resolves.toEqual({ version: 1, prompt: "SENTINEL private prompt" });
      await expect(
        decryptWorkflowContent({
          ownerId,
          context: { ...context, recordId: "automation-two" },
          keyRevision: 2,
          componentKey,
          encrypted,
          schema: contentSchema,
        }),
      ).rejects.toThrow();
      await expect(
        decryptWorkflowContent({
          ownerId,
          context: { ...context, field: "name" },
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
