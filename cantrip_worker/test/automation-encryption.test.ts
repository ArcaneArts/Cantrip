import {
  clearSensitiveBytes,
  deriveComponentKey,
  encryptProjectAutomationContent,
  generateAccountMasterKey,
} from "@cantrip/crypto";
import {
  projectAutomationProtectedConditionSchema,
  projectAutomationProtectedNameSchema,
  projectAutomationProtectedPromptSchema,
} from "@cantrip/protocol/automations";
import { describe, expect, it } from "vitest";

import { protectProjectAutomationDispatch } from "../src/automation-encryption.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

describe("project automation dispatch encryption", () => {
  it("executes while preserving the legacy workflow-content cryptographic contract", async () => {
    const ownerId = "automation-owner";
    const automationId = "5c993b4c-395d-44bf-90fd-8432ed8f503e";
    const accountKey = generateAccountMasterKey();
    const workflowKey = deriveComponentKey({
      accountMasterKey: accountKey,
      ownerId,
      component: "workflow-content",
      keyRevision: 1,
    });
    const chatKey = deriveComponentKey({
      accountMasterKey: accountKey,
      ownerId,
      component: "chat-content",
      keyRevision: 1,
    });
    const encryptAutomationField = <T>(
      field: "name" | "prompt" | "condition",
      content: T,
      schema: { parse(value: unknown): T },
    ) =>
      encryptProjectAutomationContent({
        ownerId,
        context: {
          recordKind: "project-automation",
          recordId: automationId,
          field,
        },
        keyRevision: 1,
        componentKey: workflowKey,
        content,
        schema,
      });
    const service = {
      ownerId: () => ownerId,
      componentKey: (component: "workflow-content" | "chat-content") => ({
        key: new Uint8Array(
          component === "workflow-content" ? workflowKey : chatKey,
        ),
        keyRevision: 1,
      }),
    } as WorkerEncryptionService;

    try {
      const content = {
        protectedName: await encryptAutomationField(
          "name",
          { version: 1 as const, name: "Nightly review" },
          projectAutomationProtectedNameSchema,
        ),
        protectedPrompt: await encryptAutomationField(
          "prompt",
          { version: 1 as const, prompt: "Review the project" },
          projectAutomationProtectedPromptSchema,
        ),
        protectedCondition: await encryptAutomationField(
          "condition",
          { version: 1 as const, condition: null },
          projectAutomationProtectedConditionSchema,
        ),
      };

      const result = await protectProjectAutomationDispatch({
        automationId,
        content,
        cwd: "/tmp/project",
        repository: null,
        promptId: "26d9cc56-6cc5-4012-b491-9f4bb47dbe8f",
        messageId: "c265fa8a-1553-4b08-b681-fe29b116768e",
        mode: "default",
        modelId: "gpt-5",
        reasoningEffort: null,
        idempotencyKey: "automation-dispatch-one",
        service,
        countOpenIssues: async () => 0,
      });

      expect(result.allowed).toBe(true);
      expect(result.protectedTurn).not.toBeNull();
      expect(JSON.stringify(result)).not.toContain("Review the project");
    } finally {
      clearSensitiveBytes(accountKey);
      clearSensitiveBytes(workflowKey);
      clearSensitiveBytes(chatKey);
    }
  });
});
