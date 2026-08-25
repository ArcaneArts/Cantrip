import { describe, expect, it } from "vitest";

import {
  PROJECT_EXPORT_MAX_CHATS,
  projectExportCreateSchema,
  workerCommandSchema,
} from "../src/index.js";

const titleProtection = {
  classification: { recordKind: "chat" as const },
  protectedLabel: {
    formatVersion: 1 as const,
    keyRevision: 1,
    envelope: {
      version: 1 as const,
      algorithm: "AES-256-GCM" as const,
      keyRevision: 1,
      nonce: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
    },
  },
};

describe("project export contracts", () => {
  it("accepts bounded, unique Codex export selections", () => {
    const input = projectExportCreateSchema.parse({
      operationId: "00000000-0000-4000-8000-000000000001",
      target: { kind: "codex-local" },
      worktreeId: "worktree-one",
      chatIds: Array.from(
        { length: PROJECT_EXPORT_MAX_CHATS },
        (_, index) => `chat-${index}`,
      ),
    });

    expect(input.chatIds).toHaveLength(PROJECT_EXPORT_MAX_CHATS);
    expect(
      projectExportCreateSchema.safeParse({
        ...input,
        chatIds: ["chat-one", "chat-one"],
      }).success,
    ).toBe(false);
  });

  it("keeps transcript bytes and chat titles opaque in worker commands", () => {
    const command = workerCommandSchema.parse({
      type: "project.export.chat.begin",
      operationId: "00000000-0000-4000-8000-000000000001",
      target: { kind: "codex-local" },
      chatId: "chat-one",
      cwd: "/workspace/project",
      titleProtection,
      transcriptSha256: "a".repeat(64),
      sizeBytes: 128,
    });

    expect(command).not.toHaveProperty("title");
    expect(command).not.toHaveProperty("messages");
    expect(command.titleProtection.classification.recordKind).toBe("chat");
  });
});
