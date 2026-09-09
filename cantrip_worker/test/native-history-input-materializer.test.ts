import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeHistoryBinding } from "@cantrip/protocol";
import { AttachmentStore } from "../src/attachment-store.js";
import { NativeHistoryAttachmentStore } from "../src/native-history-attachment-store.js";
import { createNativeHistoryInputMaterializer } from "../src/native-history-input-materializer.js";
import {
  nativeHistoryStateSchema,
  nativeHistoryStateItemSchema,
} from "../src/native-history-state.js";
import { renderNativeHistoryItem } from "../src/native-history-render.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

let directory: string;
let files: AttachmentStore;
let binding: NativeHistoryBinding;
const service = {
  ownerId: () => "fixture-owner",
  serverIdentity: () => "fixture-server",
  componentKey: () => ({ key: new Uint8Array(32).fill(38), keyRevision: 1 }),
} as unknown as WorkerEncryptionService;
const turn = nativeHistoryStateSchema.shape.turns.element
  .omit({ items: true })
  .parse({
    id: "turn",
    ordinal: 0,
    revision: 1,
    body: {},
    metadata: null,
    origin: { generation: "runtime", kind: "notification", sequence: 1 },
    conflicts: [],
  });
const item = (content: unknown[]) =>
  nativeHistoryStateItemSchema.parse({
    id: "input",
    identityKind: "canonical",
    revision: 1,
    ordinal: 0,
    body: { type: "userMessage", content },
    lifecycle: "completed",
    completeBody: true,
    startedAtMs: null,
    completedAtMs: null,
    origin: { generation: "runtime", kind: "notification", sequence: 1 },
    conflicts: [],
  });
const materializer = () =>
  createNativeHistoryInputMaterializer({
    directory: path.join(directory, "parts"),
    binding,
    service,
    files,
    store: new NativeHistoryAttachmentStore({
      directory: path.join(directory, "metadata"),
      binding,
      service,
      attachments: files,
    }),
  });
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "cantrip-native-media-"));
  files = new AttachmentStore(directory);
  binding = {
    id: randomUUID(),
    chatId: randomUUID(),
    workerId: randomUUID(),
    threadId: randomUUID(),
    projectId: randomUUID(),
    worktreeId: randomUUID(),
    modelRouteId: null,
    providerAccountId: null,
    createdFromOperationId: null,
    createdAt: new Date().toISOString(),
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe("native input materialization", () => {
  it("preserves inline image/audio positions and structured references without fetching remote media", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No fetch expected"));
    const input = item([
      { type: "text", text: "before" },
      { type: "image", url: "data:image/png;base64,AQID" },
      { type: "audio", url: "data:audio/wav;base64,BAUG" },
      { type: "skill", name: "Example", path: "/not-read/SKILL.md" },
      { type: "mention", name: "Example app", path: "app://fixture" },
      { type: "image", url: "https://example.invalid/not-fetched.png" },
      { type: "text", text: "after" },
    ]);
    const result = await materializer()(input, turn, { cwd: directory });
    expect(result.attachments).toHaveLength(2);
    expect([...result.inputParts.keys()]).toEqual([1, 2, 3, 4]);
    expect(await materializer()(input, turn, { cwd: directory })).toEqual(
      result,
    );
    const rendered = renderNativeHistoryItem(input, {
      ...result,
      threadId: binding.threadId,
      turnId: turn.id,
      cwd: directory,
      mode: "default",
    })[0]!;
    expect(rendered.message.content.map((part) => part.type)).toEqual([
      "text",
      "attachment",
      "attachment",
      "text",
      "text",
      "activity",
      "text",
    ]);
    expect(rendered.unresolved).toEqual([{ kind: "image", index: 5 }]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("freezes local input bytes, survives source edits, and refuses a changed source when the retained copy is lost", async () => {
    const sourcePath = path.join(directory, "picture.png");
    const bytes = Buffer.from([1, 2, 3, 4]);
    await writeFile(sourcePath, bytes);
    const input = item([{ type: "localImage", path: "picture.png" }]);
    const [first, concurrent] = await Promise.all([
      materializer()(input, turn, { cwd: directory }),
      materializer()(input, turn, { cwd: directory }),
    ]);
    expect(concurrent).toEqual(first);
    await writeFile(sourcePath, "different content");
    expect(await materializer()(input, turn, { cwd: directory })).toEqual(
      first,
    );
    // Native snapshots may serialize the same fields in a different order.
    const reordered = item([{ path: "picture.png", type: "localImage" }]);
    expect(await materializer()(reordered, turn, { cwd: directory })).toEqual(
      first,
    );
    const file = files.resolve(
      binding.chatId,
      first.attachments[0]!.id,
      "picture.png",
    );
    expect(await readFile(file)).toEqual(bytes);
    await rm(file);
    await expect(
      materializer()(input, turn, { cwd: directory }),
    ).rejects.toThrow("source file changed");
    await writeFile(sourcePath, bytes);
    expect(await materializer()(input, turn, { cwd: directory })).toEqual(
      first,
    );
    expect(await readFile(file)).toEqual(bytes);
    await rm(sourcePath);
    expect(await materializer()(input, turn, { cwd: directory })).toEqual(
      first,
    );
  });

  it("rejects malformed inline media and reports actual local file failures without reading assistant paths", async () => {
    for (const url of [
      "data:image/png;base64,!!!!",
      "data:image/png;base64,AB==",
      "data:text/plain;base64,AQID",
    ])
      await expect(
        materializer()(item([{ type: "image", url }]), turn, {
          cwd: directory,
        }),
      ).rejects.toThrow("Native inline media");
    await expect(
      materializer()(
        item([{ type: "localAudio", path: "missing.wav" }]),
        turn,
        { cwd: directory },
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      materializer()(item([{ type: "localImage", path: directory }]), turn, {
        cwd: directory,
      }),
    ).rejects.toThrow("regular file");
    const assistant = item([{ type: "localImage", path: "missing.png" }]);
    assistant.body.type = "agentMessage";
    expect(await materializer()(assistant, turn, { cwd: directory })).toEqual({
      inputParts: new Map(),
      attachments: [],
    });
  });
});
