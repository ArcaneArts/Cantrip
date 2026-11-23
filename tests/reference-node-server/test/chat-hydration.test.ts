import {
  chatRelocationContextPayloadSchema,
  type WorkerCommand,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  CANONICAL_CHAT_HYDRATION_TIMEOUT_MS,
  hydrateCanonicalChat,
} from "../src/chats/hydration.js";
import type { ModelRuntime } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const runtime: ModelRuntime = {
  routeId: "route-one",
  model: {
    id: "model-one",
    profileName: "Test model",
    routeId: "route-one",
    name: "gpt-test",
    reasoningEffort: null,
    providerModelId: null,
    catalog: null,
  },
  provider: {
    id: "provider-one",
    name: "Test provider",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    protectedApiKey: null,
    accountId: null,
    credentialHomeKey: null,
    weeklyUsageReservePercent: 0,
  },
};

describe("canonical chat hydration", () => {
  it("uploads large canonical histories in bounded chunks", async () => {
    const commands: WorkerCommand[] = [];
    let digest = "";
    let completeTimeout: number | null | undefined;
    const bridge = {
      isConnected: () => true,
      request: async (
        _workerId: string,
        command: WorkerCommand,
        options?: { timeoutMs?: number | null },
      ) => {
        commands.push(command);
        if (command.type === "chat.relocation.hydration.begin") {
          digest = command.transcriptSha256;
          return { status: "upload" };
        }
        if (command.type === "chat.relocation.hydration.chunk") {
          return { accepted: true };
        }
        if (command.type === "chat.relocation.hydration.complete") {
          completeTimeout = options?.timeoutMs;
          return {
            snapshotId: command.snapshotId,
            transcriptSha256: digest,
            threadId: "managed-large-thread",
            reused: false,
          };
        }
        throw new Error(`Unexpected command ${command.type}.`);
      },
    } as unknown as WorkerCommandBus;
    const payload = chatRelocationContextPayloadSchema.parse({
      version: 1,
      messages: [
        {
          sequence: 1,
          role: "user",
          mode: "default",
          reasoningEffort: null,
          content: [{ type: "text", text: "x".repeat(600_000) }],
          createdAt: "2026-08-15T00:00:00.000Z",
        },
      ],
      attachments: [],
    });

    await expect(
      hydrateCanonicalChat({
        bridge,
        chatId: "chat-one",
        cwd: "/workspace/project",
        mcpServers: [],
        payload,
        permissionProfileId: "workspace-write",
        planMode: "default",
        runtime,
        snapshotId: "00000000-0000-4000-8000-000000000001",
        workerId: "worker-one",
      }),
    ).resolves.toMatchObject({ threadId: "managed-large-thread" });

    const chunks = commands.filter(
      (
        command,
      ): command is Extract<
        WorkerCommand,
        { type: "chat.relocation.hydration.chunk" }
      > => command.type === "chat.relocation.hydration.chunk",
    );
    expect(chunks).toHaveLength(3);
    expect(
      chunks.every(
        (command) =>
          Buffer.from(command.data, "base64").byteLength <= 256 * 1_024,
      ),
    ).toBe(true);
    expect(chunks.map(({ chunkIndex }) => chunkIndex)).toEqual([0, 1, 2]);
    expect(completeTimeout).toBe(CANONICAL_CHAT_HYDRATION_TIMEOUT_MS);
  });
});
