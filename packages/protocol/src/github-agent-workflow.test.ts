import { describe, expect, it } from "vitest";

import {
  encryptedChatCreateSchema,
  encryptedTaskCreateSchema,
  githubAgentWorkflowContextSchema,
} from "./index.js";

const titleProtection = {
  classification: { recordKind: "chat" as const },
  protectedLabel: {
    formatVersion: 1 as const,
    keyRevision: 1,
    envelope: {
      version: 1 as const,
      algorithm: "AES-256-GCM" as const,
      keyRevision: 1,
      nonce: "A".repeat(16),
      ciphertext: "A".repeat(22),
    },
  },
};

describe("GitHub agent workflow contracts", () => {
  it("accepts only compatible item and workflow intent combinations", () => {
    expect(
      githubAgentWorkflowContextSchema.parse({
        kind: "issue",
        number: 42,
        intent: "start-work",
        headSha: "a".repeat(40),
      }),
    ).toMatchObject({ kind: "issue", intent: "start-work" });
    expect(() =>
      githubAgentWorkflowContextSchema.parse({
        kind: "issue",
        number: 42,
        intent: "fix-checks",
        headSha: "a".repeat(40),
      }),
    ).toThrow();
    expect(() =>
      githubAgentWorkflowContextSchema.parse({
        kind: "pull-request",
        number: 9,
        intent: "start-work",
        headSha: "a".repeat(40),
      }),
    ).toThrow();
  });

  it("persists bindings on agent chats without adding them to task creation", () => {
    expect(
      encryptedChatCreateSchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
        titleProtection,
        worktreeId: "worktree-1",
        worktreeMode: "pinned",
        githubAgentContext: {
          kind: "pull-request",
          number: 9,
          intent: "address-review",
          headSha: "b".repeat(40),
        },
      }).githubAgentContext,
    ).toMatchObject({ number: 9, intent: "address-review" });

    const taskResult = encryptedTaskCreateSchema.safeParse({
      chatId: "22222222-2222-4222-8222-222222222222",
      titleProtection,
      worktreeId: "worktree-1",
      githubAgentContext: {
        kind: "issue",
        number: 42,
        intent: "start-work",
        headSha: "c".repeat(40),
      },
      task: {
        classification: {
          state: "draft",
          stableStateBeforeFailure: null,
          activeOperationKind: null,
          planAuthorship: "agent",
          planningRound: 0,
          hasPlan: false,
          hasQuestions: false,
          hasFinalPlan: false,
          hasGoalPrompt: false,
          lastError: null,
        },
        protectedContent: {},
      },
    });
    expect(taskResult.success).toBe(false);
    if (taskResult.success)
      throw new Error("Expected task validation to fail.");
    expect(taskResult.error.issues).toContainEqual(
      expect.objectContaining({
        code: "unrecognized_keys",
        keys: ["githubAgentContext"],
      }),
    );
  });
});
