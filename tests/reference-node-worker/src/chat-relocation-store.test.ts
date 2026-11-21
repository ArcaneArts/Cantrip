import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  chatRelocationContextPayloadSchema,
  workerCommandSchema,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { ChatRelocationHydrationStore } from "./chat-relocation-store.js";
import { relocationResponseItems } from "./codex/app-server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-chat-relocation-store-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

describe("chat relocation hydration store", () => {
  it("verifies bounded uploads and reuses completed hydration across restarts", async () => {
    const dataDirectory = await temporaryDirectory();
    const snapshotId = "11111111-1111-4111-8111-111111111111";
    const payload = chatRelocationContextPayloadSchema.parse({
      version: 1,
      messages: [
        {
          sequence: 1,
          role: "user",
          mode: "plan",
          content: [{ type: "text", text: "Use $migration safely." }],
          createdAt: "2026-08-12T00:00:00.000Z",
        },
        {
          sequence: 2,
          role: "assistant",
          mode: "default",
          content: [{ type: "text", text: "Understood." }],
          createdAt: "2026-08-12T00:00:01.000Z",
        },
      ],
      attachments: [],
    });
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const command = workerCommandSchema.parse({
      type: "chat.relocation.hydration.begin",
      chatId: "chat-one",
      snapshotId,
      transcriptSha256: digest,
      sizeBytes: bytes.byteLength,
      cwd: "/workspace/project",
      requiredSkillNames: ["migration"],
      planMode: "plan",
      model: {
        id: "model-one",
        routeId: "route-one",
        name: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
      provider: {
        id: "provider-one",
        name: "Provider",
        kind: "openai-compatible",
        baseUrl: "https://example.com/v1",
        apiKey: "secret",
      },
      permissionProfileId: ":workspace",
      mcpServers: [],
    });
    if (command.type !== "chat.relocation.hydration.begin") {
      throw new Error("Unexpected command type.");
    }

    const store = new ChatRelocationHydrationStore(dataDirectory);
    expect(await store.begin(command)).toEqual({ status: "upload" });
    await store.append(snapshotId, 0, bytes.subarray(0, 20));
    await store.append(snapshotId, 1, bytes.subarray(20));
    expect((await store.completeUpload(snapshotId)).payload).toEqual(payload);
    await store.markHydrating(snapshotId, digest, "thread-abandoned");

    const recovered = new ChatRelocationHydrationStore(dataDirectory);
    expect(await recovered.begin(command)).toEqual({ status: "upload" });
    await recovered.append(snapshotId, 0, bytes);
    const resumed = await recovered.completeUpload(snapshotId);
    expect(resumed.abandonedThreadId).toBe("thread-abandoned");
    await recovered.markHydrated(snapshotId, digest, "thread-ready");

    const replay = new ChatRelocationHydrationStore(dataDirectory);
    expect(await replay.begin(command)).toEqual({
      status: "hydrated",
      threadId: "thread-ready",
    });
    await expect(
      replay.begin({ ...command, transcriptSha256: "f".repeat(64) }),
    ).rejects.toThrow(/different transcript/iu);
  });

  it("maps canonical roles and plan metadata to model-visible response items", () => {
    const payload = chatRelocationContextPayloadSchema.parse({
      version: 1,
      messages: [
        {
          sequence: 1,
          role: "system",
          mode: "default",
          content: [{ type: "text", text: "System context" }],
          createdAt: "2026-08-12T00:00:00.000Z",
        },
        {
          sequence: 2,
          role: "assistant",
          mode: "plan",
          content: [{ type: "text", text: "A plan" }],
          createdAt: "2026-08-12T00:00:01.000Z",
        },
      ],
      attachments: [],
    });
    expect(relocationResponseItems(payload)).toEqual([
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "System context" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "[Cantrip plan mode]\nA plan" }],
      },
    ]);
  });
});
