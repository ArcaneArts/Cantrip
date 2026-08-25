import {
  chatRelocationContextPayloadSchema,
  type PrivateDisplayLabelOpaque,
  type WorkerCommand,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { exportCanonicalChat } from "../src/project-exports/service.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

describe("project export relay", () => {
  it("uploads canonical encrypted histories in bounded chunks", async () => {
    const commands: WorkerCommand[] = [];
    const bridge = {
      isConnected: () => true,
      request: async (_workerId: string, command: WorkerCommand) => {
        commands.push(command);
        if (command.type === "project.export.chat.begin") {
          return { status: "upload" };
        }
        if (command.type === "project.export.chat.chunk") {
          return { accepted: true };
        }
        if (command.type === "project.export.chat.complete") {
          return {
            chatId: command.chatId,
            threadId: "codex-thread-one",
            destinationLabel: "~/.codex",
            messageCount: 1,
            reused: false,
          };
        }
        throw new Error(`Unexpected command ${command.type}.`);
      },
    } as unknown as WorkerCommandBus;
    const payload = chatRelocationContextPayloadSchema.parse({
      version: 1,
      kind: "visible",
      messages: [
        {
          sequence: 1,
          role: "user",
          mode: "default",
          reasoningEffort: null,
          content: [{ type: "text", text: "x".repeat(600_000) }],
          createdAt: "2026-08-25T00:00:00.000Z",
        },
      ],
      attachments: [],
    });

    await expect(
      exportCanonicalChat({
        bridge,
        operationId: "00000000-0000-4000-8000-000000000001",
        target: { kind: "codex-local" },
        workerId: "worker-one",
        chatId: "chat-one",
        cwd: "/workspace/project",
        titleProtection: {} as PrivateDisplayLabelOpaque,
        payload,
      }),
    ).resolves.toMatchObject({ threadId: "codex-thread-one" });

    const chunks = commands.filter(
      (
        command,
      ): command is Extract<
        WorkerCommand,
        { type: "project.export.chat.chunk" }
      > => command.type === "project.export.chat.chunk",
    );
    expect(chunks).toHaveLength(3);
    expect(chunks.map(({ chunkIndex }) => chunkIndex)).toEqual([0, 1, 2]);
    expect(
      chunks.every(
        ({ data }) => Buffer.from(data, "base64").byteLength <= 256 * 1_024,
      ),
    ).toBe(true);
    expect(commands[0]).toMatchObject({
      type: "project.export.chat.begin",
      cwd: "/workspace/project",
      target: { kind: "codex-local" },
    });
  });

  it("reuses an already completed operation without uploading bytes", async () => {
    const commands: WorkerCommand[] = [];
    const bridge = {
      isConnected: () => true,
      request: async (_workerId: string, command: WorkerCommand) => {
        commands.push(command);
        return {
          status: "exported",
          chatId: "chat-one",
          threadId: "existing-thread",
          destinationLabel: "~/.codex",
          messageCount: 0,
          reused: true,
        };
      },
    } as unknown as WorkerCommandBus;

    const result = await exportCanonicalChat({
      bridge,
      operationId: "00000000-0000-4000-8000-000000000001",
      target: { kind: "codex-local" },
      workerId: "worker-one",
      chatId: "chat-one",
      cwd: "/workspace/project",
      titleProtection: {} as PrivateDisplayLabelOpaque,
      payload: chatRelocationContextPayloadSchema.parse({
        version: 1,
        kind: "visible",
        messages: [],
        attachments: [],
      }),
    });

    expect(result).toMatchObject({ threadId: "existing-thread", reused: true });
    expect(commands).toHaveLength(1);
  });
});
