import { describe, expect, it } from "vitest";

import {
  clearSensitiveBytes,
  decryptRepositoryOperationPayload,
  deriveComponentKey,
  encryptRepositoryOperationPayload,
  generateAccountMasterKey,
} from "../src/index.js";

describe("repository operation encryption", () => {
  it("round-trips content and binds project, worktree, operation, and direction", async () => {
    const ownerId = "repository-owner";
    const accountKey = generateAccountMasterKey();
    const componentKey = deriveComponentKey({
      accountMasterKey: accountKey,
      ownerId,
      component: "repository-content",
      keyRevision: 3,
    });
    const context = {
      serverId: "https://cantrip.example",
      projectId: "project-one",
      worktreeId: "worktree-one",
      operationId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      direction: "request" as const,
    };
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        type: "git.diff",
        arguments: { path: "private/roadmap.md", scope: "unstaged" },
      }),
    );
    try {
      const opaque = await encryptRepositoryOperationPayload({
        ownerId,
        context,
        keyRevision: 3,
        componentKey,
        plaintext,
      });
      expect(JSON.stringify(opaque)).not.toContain("private/roadmap.md");
      await expect(
        decryptRepositoryOperationPayload({
          ownerId,
          context,
          keyRevision: 3,
          componentKey,
          opaque,
        }),
      ).resolves.toEqual(plaintext);
      for (const changed of [
        { ...context, projectId: "project-two" },
        { ...context, worktreeId: "worktree-two" },
        {
          ...context,
          operationId: "9c858901-8a57-4791-81fe-4c455b099bc9",
        },
        { ...context, direction: "response" as const },
      ]) {
        await expect(
          decryptRepositoryOperationPayload({
            ownerId,
            context: changed,
            keyRevision: 3,
            componentKey,
            opaque,
          }),
        ).rejects.toThrow();
      }
      const tampered = structuredClone(opaque);
      tampered.envelope.ciphertext = `${tampered.envelope.ciphertext.slice(0, -1)}A`;
      await expect(
        decryptRepositoryOperationPayload({
          ownerId,
          context,
          keyRevision: 3,
          componentKey,
          opaque: tampered,
        }),
      ).rejects.toThrow();
    } finally {
      clearSensitiveBytes(accountKey);
      clearSensitiveBytes(componentKey);
      clearSensitiveBytes(plaintext);
    }
  });
});
