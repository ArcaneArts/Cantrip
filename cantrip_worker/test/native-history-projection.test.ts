import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeCommandAdmissionSchema } from "@cantrip/protocol";
import { createNativeCommandWorkerFixture } from "../../cantrip_server/test/native-command-worker-fixture.js";
import * as schema from "../../cantrip_server/src/db/schema.js";
import { persistNativeHistoryAttachments } from "../../cantrip_server/src/db/repository/native-history-attachments.js";
import { NativeHistoryClient } from "../src/native-history-client.js";
import { readNativeHistoryRecovery } from "../src/native-history-recovery.js";
import { restoreNativeHistoryProjectorState } from "../src/native-history-projector-bootstrap.js";
import { reduceNativeHistory } from "../src/native-history-reducer.js";
import { NativeHistorySourceJournal } from "../src/native-history-source-journal.js";
import { NativeHistoryOutbox } from "../src/native-history-outbox.js";
import { NativeHistoryProjection } from "../src/native-history-projection.js";
import { NativeHistoryCapture } from "../src/native-history-capture.js";
import { NativeHistoryObservations } from "../src/codex/native-history-observation.js";
import { parseCodexNativeHistory } from "../src/codex/native-history.js";
import {
  createNativeHistoryProjector,
  nativeHistoryProjectorStateSchema,
} from "../src/native-history-projector.js";
import { openNativeHistoryItemEvidence } from "../src/native-history-item-content.js";
import { createManagedNativeOutputIdentityResolver } from "../src/native-history-output-identity.js";
import { NativeHistoryAttachmentStore } from "../src/native-history-attachment-store.js";
import { createNativeHistoryInputMaterializer } from "../src/native-history-input-materializer.js";
import { AttachmentStore } from "../src/attachment-store.js";
import {
  EncryptedChatEventSealer,
  openEncryptedChatTurn,
  protectChatMessage,
} from "../src/chat-message-encryption.js";
import { openNativeHistoryTurnArchivePage } from "../src/native-history-archive.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

let f: Awaited<ReturnType<typeof createNativeCommandWorkerFixture>>;
let directory: string;
let options: Parameters<typeof NativeHistoryProjection.open>[0];
let projection: NativeHistoryProjection;
let source: NativeHistorySourceJournal;
let outbox: NativeHistoryOutbox;
let client: NativeHistoryClient;
let threadId: string;
let sequence: number;
const service = {
  ownerId: () => f.ownerId,
  serverIdentity: () => f.serverId,
  componentKey: () => ({ key: new Uint8Array(32).fill(63), keyRevision: 1 }),
} as WorkerEncryptionService;
const project =
  vi.fn<Parameters<typeof NativeHistoryProjection.open>[0]["project"]>();
function revisions(value: unknown) {
  return Object.fromEntries(
    nativeHistoryProjectorStateSchema
      .parse(value)
      .items.map((entry) => [entry.identity.itemId, entry.revision]),
  );
}

async function event(id: string, text = "fixture-only projected secret") {
  return source.append({
    kind: "notification",
    generation: "runtime",
    sequence: ++sequence,
    threadId,
    receivedAtMs: Date.now(),
    method: "item/completed",
    params: {
      threadId,
      turnId: "turn",
      item: {
        id,
        type: "agentMessage",
        text,
        nativeExtension: { retained: "outside the UI preview" },
      },
    },
  });
}
async function canonical() {
  return f.repository.nativeHistoryBindings.withBinding(
    f.ownerId,
    f.workerId,
    f.chatId,
    options.bindingId,
    async (tx) => ({
      messages: await tx.select().from(schema.chatMessages),
      receipts: await tx.select().from(schema.nativeHistoryReceipts),
      items: await tx.select().from(schema.nativeHistoryItems),
    }),
  );
}
async function reopen() {
  return NativeHistoryProjection.open({
    ...options,
    outbox: await NativeHistoryOutbox.open({
      directory: path.join(directory, "outbox"),
      chatId: f.chatId,
      bindingId: options.bindingId,
      workerId: f.workerId,
      service,
    }),
    source: await NativeHistorySourceJournal.open({
      directory: path.join(directory, "source"),
      chatId: f.chatId,
      bindingId: options.bindingId,
      workerId: f.workerId,
      threadId,
      service,
    }),
  });
}

beforeEach(async () => {
  project.mockReset();
  sequence = 0;
  directory = await mkdtemp(path.join(tmpdir(), "cantrip-projection-"));
  f = await createNativeCommandWorkerFixture({
    cwd: directory,
    modelBaseUrl: "http://127.0.0.1:1/v1",
  });
  client = new NativeHistoryClient({
    serverUrl: await f.app.listen({ host: "127.0.0.1", port: 0 }),
    workerId: f.workerId,
    token: () => f.token,
  });
  threadId = randomUUID();
  await f.bindThread(threadId);
  const binding = await client.open({
    chatId: f.chatId,
    threadId,
    provenance: { kind: "current" },
  });
  const scope = {
    chatId: f.chatId,
    bindingId: binding.id,
    workerId: f.workerId,
    service,
  };
  source = await NativeHistorySourceJournal.open({
    ...scope,
    directory: path.join(directory, "source"),
    threadId,
  });
  outbox = await NativeHistoryOutbox.open({
    ...scope,
    directory: path.join(directory, "outbox"),
  });
  project.mockImplementation(
    createNativeHistoryProjector({
      binding,
      service,
      client,
      maxItemsPerBatch: 1,
      // These fixtures contain native-only synthetic items, no GUI alias or files.
      context: async () => ({ cwd: directory, mode: "default" }),
      materialize: async () => ({
        attachments: [],
      }),
      associate: async () => ({ kind: "native" }),
    }),
  );
  options = {
    ...scope,
    directory: path.join(directory, "projection"),
    source,
    outbox,
    client,
    project,
  };
  projection = await NativeHistoryProjection.open(options);
}, 60_000);
afterEach(async () => {
  await f?.close();
  await rm(directory, { recursive: true, force: true });
});

describe("durable native history projection transactions", () => {
  it("projects turn-start labels without usage and recovers them through encrypted replay", async () => {
    const runtime = f.modelRuntime;
    const capture = {
      threadId,
      turnId: "turn",
      isRoot: true,
      reasoningEffort: "low",
      selection: {
        status: "resolved",
        workerId: f.workerId,
        providerAccountId: runtime!.provider.accountId,
        providerId: runtime!.provider.id,
        modelId: runtime!.model.id,
        routeId: runtime!.routeId,
      },
    };
    await source.append({
      kind: "notification",
      generation: "runtime",
      sequence: ++sequence,
      threadId,
      receivedAtMs: Date.now(),
      method: "turn/started",
      params: {
        threadId,
        turn: { id: "turn", status: "inProgress" },
        cantripModelAttribution: capture,
      },
    });
    await event("answer");
    await source.append({
      kind: "notification",
      generation: "runtime",
      sequence: ++sequence,
      threadId,
      receivedAtMs: Date.now(),
      method: "turn/completed",
      params: { threadId, turn: { id: "turn", status: "completed" } },
    });
    await projection.drain();
    expect((await canonical()).messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelId: runtime!.model.id,
          appliedReasoningEffort: "low",
          nativeModelAttribution: capture,
        }),
      ]),
    );
    const reopened = await reopen();
    await reopened.drain();
    const archived = await client.archiveTurns({
      chatId: f.chatId,
      bindingId: options.bindingId,
    });
    expect(archived.turns[0]!.turn.modelAttribution).toEqual(capture);
    expect(archived.turns[0]!.turn.usage).toBeUndefined();
    expect((await canonical()).messages).toHaveLength(1);
  });
  it("projects retained native response usage through encrypted delivery and replay without a live usage callback", async () => {
    const usage = {
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
    };
    const snapshot = parseCodexNativeHistory(
      {
        thread: {
          id: threadId,
          status: { type: "idle" },
          turns: [
            {
              id: "turn",
              status: "completed",
              startedAt: 1,
              completedAt: 4,
              items: [],
            },
          ],
        },
        history: {
          version: 1,
          currentTurnId: null,
          currentTurnState: "notLoaded",
          turns: [
            {
              turnId: "turn",
              source: "canonical",
              retention: "complete",
              items: [],
              usage: {
                responses: ["one", "two"].map((responseId) => ({
                  responseId,
                  threadId,
                  sessionId: threadId,
                  rootTurnId: "turn",
                  usage,
                })),
                total: {
                  ...usage,
                  inputTokens: 4,
                  outputTokens: 6,
                  totalTokens: 10,
                },
                conflictingResponseIds: [],
              },
              warnings: [],
              errors: [],
            },
          ],
        },
      },
      threadId,
    );
    const append = () =>
      source.append({
        kind: "snapshot",
        generation: "runtime",
        threadId,
        receivedAtMs: Date.now(),
        id: randomUUID(),
        readBarrierSequence: 0,
        completedSequence: 0,
        snapshot,
      });
    await append();
    await projection.drain();
    const inspect = () =>
      f.repository.nativeHistoryBindings.withBinding(
        f.ownerId,
        f.workerId,
        f.chatId,
        options.bindingId,
        (tx) => tx.select().from(schema.tokenUsageRecords),
      );
    expect(await inspect()).toHaveLength(1);
    expect((await inspect())[0]).toMatchObject({
      inputTokens: 4,
      outputTokens: 6,
      modelId: null,
      usageSemantics: "native-responses-complete-v1",
    });
    const reopened = await reopen();
    await append();
    await reopened.drain();
    expect(await inspect()).toHaveLength(1);
    const archived = await client.archiveTurns({
      chatId: f.chatId,
      bindingId: options.bindingId,
    });
    expect(archived.turns[0]!.turn.usage).toMatchObject({
      complete: true,
      responses: [{ responseId: "one" }, { responseId: "two" }],
    });
  });
  it("preserves an accepted stage prefix across repeated rebases and recovers a lost final reply without recomputing any plan", async () => {
    const binding = await client.open({
      chatId: f.chatId,
      threadId,
      provenance: { kind: "binding", bindingId: options.bindingId },
    });
    const other = { ...binding, id: randomUUID(), workerId: randomUUID() };
    await f.repository.nativeHistoryBindings.withBinding(
      f.ownerId,
      f.workerId,
      f.chatId,
      binding.id,
      async (tx) => {
        const worker = (await tx.select().from(schema.workers)).find(
          (entry) => entry.id === f.workerId,
        )!;
        await tx
          .insert(schema.workers)
          .values({ ...worker, id: other.workerId });
        await tx.insert(schema.nativeHistoryBindings).values({
          ...other,
          ownerId: f.ownerId,
          createdAt: new Date(other.createdAt),
        });
      },
    );
    project.mockImplementation(
      createNativeHistoryProjector({
        binding,
        service,
        client,
        maxItemsPerBatch: 1,
        bootstrap: async () =>
          restoreNativeHistoryProjectorState(
            await readNativeHistoryRecovery({ binding, service, client }),
          ),
        context: async () => ({ cwd: directory, mode: "default" }),
        materialize: async () => ({ attachments: [] }),
        associate: async () => ({ kind: "native" }),
      }),
    );
    options.rebase = (records) => project(records, null);
    projection = await reopen();
    await event("prefix");
    await event("conflict");
    const otherStream = randomUUID();
    let rivals = 0,
      previousDigest: string | null = null,
      lost = false;
    const actualDeliver = client.deliver.bind(client);
    const deliver = vi
      .spyOn(client, "deliver")
      .mockImplementation(async (...args) => {
        const batch = JSON.parse(args[2]);
        const candidate = batch.items.find(
          (item: any) => item.identity.itemId === "conflict",
        );
        if (candidate && rivals < 2) {
          const { evidence: _evidence, ...legacy } = candidate;
          const receipt = await f.repository.nativeHistoryIngestion.ingest(
            f.ownerId,
            {
              workerId: other.workerId,
              chatId: f.chatId,
              bindingId: other.id,
              streamId: otherStream,
              sequence: ++rivals,
              recordId: randomUUID(),
              digest: String(rivals).repeat(64),
              previousDigest,
              batch: { items: [legacy], turns: [] },
            },
          );
          previousDigest = receipt.digest;
          return actualDeliver(...args);
        }
        const receipt = await actualDeliver(...args);
        if (candidate && !lost) {
          lost = true;
          throw new Error("lost final replacement reply");
        }
        return receipt;
      });
    await expect(projection.drain()).rejects.toThrow(
      "lost final replacement reply",
    );
    expect((await projection.checkpoint()).cursor.sequence).toBe(0);
    expect(project).toHaveBeenCalledTimes(3);
    const files = (await readdir(projection.directory)).filter(
      (file) => file.endsWith(".stage.json") || file.endsWith(".rebase.json"),
    );
    expect(files.filter((file) => file.endsWith(".rebase.json"))).toHaveLength(
      2,
    );
    const frozen = await Promise.all(
      files.map(async (file) => ({
        file,
        bytes: await readFile(path.join(projection.directory, file), "utf8"),
      })),
    );
    const after = await canonical();
    expect(after.messages).toHaveLength(2);
    expect(after.receipts).toHaveLength(4); // Accepted prefix, two rivals, final replacement.
    const recovered = await reopen();
    await recovered.drain();
    expect((await recovered.checkpoint()).cursor.sequence).toBe(2);
    expect(revisions((await recovered.checkpoint()).state)).toEqual({
      prefix: 1,
      conflict: 3,
    });
    expect(project).toHaveBeenCalledTimes(3);
    expect((await canonical()).receipts).toEqual(after.receipts);
    expect(
      deliver.mock.calls.filter((call) =>
        JSON.parse(call[2]).items.some(
          (item: any) => item.identity.itemId === "prefix",
        ),
      ),
    ).toHaveLength(1);
    expect(deliver.mock.calls.at(-1)![1]).toEqual(
      deliver.mock.calls.at(-2)![1],
    );
    for (const file of frozen)
      expect(
        await readFile(path.join(projection.directory, file.file), "utf8"),
      ).toBe(file.bytes);
    const originalPlan = frozen
      .filter((entry) => entry.file.endsWith(".rebase.json"))
      .sort((a, b) => a.file.localeCompare(b.file))[0]!;
    await rm(path.join(projection.directory, originalPlan.file));
    await expect(reopen()).rejects.toThrow("rebase chain");
    await writeFile(
      path.join(projection.directory, originalPlan.file),
      originalPlan.bytes,
    );
    expect((await (await reopen()).checkpoint()).cursor.sequence).toBe(2);
  });

  it("projects an inline native image through the input adapter and restores it on replay", async () => {
    const binding = await client.open({
      chatId: f.chatId,
      threadId,
      provenance: { kind: "binding", bindingId: options.bindingId },
    });
    const files = new AttachmentStore(directory);
    project.mockImplementation(
      createNativeHistoryProjector({
        binding,
        service,
        client,
        associate: async () => ({ kind: "native" }),
        context: async () => ({ cwd: directory, mode: "default" }),
        materialize: createNativeHistoryInputMaterializer({
          binding,
          service,
          files,
          directory: path.join(directory, "native-parts"),
          store: new NativeHistoryAttachmentStore({
            binding,
            service,
            attachments: files,
            directory: path.join(directory, "native-media"),
          }),
        }),
      }),
    );
    const observe = () =>
      source.append({
        kind: "notification",
        generation: "runtime",
        sequence: ++sequence,
        threadId,
        receivedAtMs: Date.now(),
        method: "item/completed",
        params: {
          threadId,
          turnId: "turn",
          item: {
            id: "inline-input",
            type: "userMessage",
            content: [{ type: "image", url: "data:image/png;base64,AQID" }],
          },
        },
      });
    await observe();
    await projection.drain();
    const first = (await canonical()).messages[0]!;
    expect(first.attachmentIds).toHaveLength(1);
    const file = files.resolve(
      f.chatId,
      first.attachmentIds[0]!,
      "native-image-1.png",
    );
    expect(await readFile(file)).toEqual(Buffer.from([1, 2, 3]));
    const archived = await client.archive({
      chatId: f.chatId,
      bindingId: binding.id,
    });
    expect(archived.items[0]!.attachments[0]!.id).toBe(first.attachmentIds[0]);
    await rm(file);
    await observe();
    await (await reopen()).drain();
    const restored = await canonical();
    expect(restored.messages).toHaveLength(1);
    expect(restored.items[0]!.revision).toBe(1);
    expect(restored.messages[0]!.protectedContent).toEqual(
      first.protectedContent,
    );
    expect(await readFile(file)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("commits materialized native attachment bytes and stable protected metadata without changing identity on repeated observation", async () => {
    const binding = await client.open({
      chatId: f.chatId,
      threadId,
      provenance: { kind: "binding", bindingId: options.bindingId },
    });
    const files = new AttachmentStore(directory);
    const materializer = new NativeHistoryAttachmentStore({
      directory: path.join(directory, "materialized"),
      binding,
      service,
      attachments: files,
    });
    const bytes = new TextEncoder().encode("PRIVATE_NATIVE_FILE_BYTES");
    let materialized:
      | Awaited<ReturnType<NativeHistoryAttachmentStore["materialize"]>>
      | undefined;
    project.mockImplementation(
      createNativeHistoryProjector({
        binding,
        service,
        client,
        associate: async () => ({ kind: "native" }),
        context: async () => ({ cwd: directory, mode: "default" }),
        materialize: async (item, turn) => {
          // These bytes are supplied by the authorized native-input adapter. The
          // materializer itself never follows the placeholder path in the item.
          materialized = await materializer.materialize({
            identity: {
              threadId,
              turnId: turn.id,
              itemId: item.id,
              component: "user",
              identityKind: item.identityKind,
            },
            partIndex: 1,
            fileName: "private-native.txt",
            mimeType: "text/plain",
            kind: "text",
            bytes,
          });
          return {
            inputParts: new Map([[1, materialized.content]]),
            attachments: [materialized.attachment],
          };
        },
      }),
    );
    const observe = () =>
      source.append({
        kind: "notification",
        generation: "runtime",
        sequence: ++sequence,
        threadId,
        receivedAtMs: Date.now(),
        method: "item/completed",
        params: {
          threadId,
          turnId: "turn",
          item: {
            id: "native-with-file",
            type: "userMessage",
            content: [
              { type: "text", text: "before" },
              { type: "localImage", path: "/must-not-be-read" },
              { type: "text", text: "after" },
            ],
          },
        },
      });
    await observe();
    await projection.drain();
    const first = materialized!;
    const stored = await canonical();
    expect(stored.messages).toHaveLength(1);
    expect(stored.messages[0]!.attachmentIds).toEqual([first.attachment.id]);
    const file = files.resolve(
      f.chatId,
      first.attachment.id,
      "private-native.txt",
    );
    expect(await readFile(file)).toEqual(Buffer.from(bytes));
    await f.repository.nativeHistoryBindings.withBinding(
      f.ownerId,
      f.workerId,
      f.chatId,
      binding.id,
      async (tx) => {
        const rows = await tx.select().from(schema.chatAttachments);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.protectedMetadata).toEqual(
          first.attachment.protectedMetadata,
        );
        expect(JSON.stringify(rows)).not.toContain("private-native.txt");
        const replicas = await tx.select().from(schema.chatAttachmentReplicas);
        expect(replicas).toMatchObject([
          {
            attachmentId: first.attachment.id,
            workerId: f.workerId,
            status: "ready",
          },
        ]);
      },
    );
    const archived = await client.archive({
      chatId: f.chatId,
      bindingId: binding.id,
    });
    expect(archived.items[0]!.attachments).toEqual([first.attachment]);
    const replacement = {
      ...binding,
      id: randomUUID(),
      workerId: randomUUID(),
    };
    await f.repository.nativeHistoryBindings.withBinding(
      f.ownerId,
      f.workerId,
      f.chatId,
      binding.id,
      async (tx) => {
        const worker = (await tx.select().from(schema.workers)).find(
          (row) => row.id === f.workerId,
        );
        await tx
          .insert(schema.workers)
          .values({ ...worker!, id: replacement.workerId });
        // Fixture of an already authorized historical migration binding.
        await tx.insert(schema.nativeHistoryBindings).values({
          ...replacement,
          ownerId: f.ownerId,
          createdAt: new Date(replacement.createdAt),
        });
      },
    );
    const replacementClient = new NativeHistoryClient({
      serverUrl: f.serverUrl,
      workerId: replacement.workerId,
      token: () => f.token,
      fetch: f.fetch,
    });
    const recoveredArchive = await replacementClient.archive({
      chatId: f.chatId,
      bindingId: replacement.id,
    });
    const corruptedClient = new NativeHistoryClient({
      serverUrl: f.serverUrl,
      workerId: replacement.workerId,
      token: () => f.token,
      fetch: async (input, init) => {
        const response = await f.fetch(input, init);
        const page = (await response.json()) as typeof recoveredArchive;
        page.items[0]!.attachments[0]!.chatId = randomUUID();
        return Response.json(page);
      },
    });
    await expect(
      corruptedClient.archive({ chatId: f.chatId, bindingId: replacement.id }),
    ).rejects.toThrow("inconsistent archive page");
    expect(recoveredArchive.items[0]!.attachments).toEqual([first.attachment]);
    const replacementFiles = new AttachmentStore(
      path.join(directory, "replacement"),
    );
    const recoveredFile = await new NativeHistoryAttachmentStore({
      directory: path.join(directory, "replacement-history"),
      binding: replacement,
      service,
      attachments: replacementFiles,
    }).materialize({
      identity: recoveredArchive.items[0]!.identity,
      partIndex: 1,
      fileName: "private-native.txt",
      mimeType: "text/plain",
      kind: "text",
      bytes,
      publishedAttachment: recoveredArchive.items[0]!.attachments[0]!,
    });
    expect(recoveredFile).toEqual(first);
    expect(
      await readFile(
        replacementFiles.resolve(
          f.chatId,
          first.attachment.id,
          "private-native.txt",
        ),
      ),
    ).toEqual(Buffer.from(bytes));
    // Exercise the production attachment transaction after actual byte recovery.
    // This does not claim remote projector checkpoint bootstrap is installed.
    const mapping = (
      await client.resolve({
        chatId: f.chatId,
        bindingId: binding.id,
        items: [
          {
            identity: archived.items[0]!.identity,
            association: { kind: "existing" },
          },
        ],
      })
    )[0]!;
    const message = await protectChatMessage({
      id: mapping.messageId,
      service,
      message: {
        role: "user",
        content: first.content,
        idempotencyKey: mapping.idempotencyKey,
      },
    });
    await f.repository.nativeHistoryBindings.withBinding(
      f.ownerId,
      replacement.workerId,
      f.chatId,
      replacement.id,
      async (tx) => {
        await persistNativeHistoryAttachments(tx, replacement, {
          identity: archived.items[0]!.identity,
          revision: 1,
          state: "completed",
          order: archived.items[0]!.order,
          message,
          attachments: [recoveredFile.attachment],
        });
        const replicas = await tx.select().from(schema.chatAttachmentReplicas);
        expect(replicas.map((replica) => replica.workerId).sort()).toEqual(
          [f.workerId, replacement.workerId].sort(),
        );
        expect(replicas.every((replica) => replica.status === "ready")).toBe(
          true,
        );
        const descriptors = await tx.select().from(schema.chatAttachments);
        expect(descriptors).toHaveLength(1);
        expect(descriptors[0]!.protectedMetadata).toEqual(
          first.attachment.protectedMetadata,
        );
      },
    );
    await rm(file);
    await observe();
    await (await reopen()).drain();
    expect(materialized).toEqual(first);
    expect(await readFile(file)).toEqual(Buffer.from(bytes));
    expect((await canonical()).items[0]!.revision).toBe(1);
    expect((await canonical()).messages).toHaveLength(1);
  });

  it.each([false, true])(
    "shares a fresh output identity before encryption (sealer first=%s)",
    async (sealerFirst) => {
      const binding = await client.open({
        chatId: f.chatId,
        threadId,
        provenance: { kind: "binding", bindingId: options.bindingId },
      });
      project.mockImplementation(
        createNativeHistoryProjector({
          binding,
          service,
          client,
          associate: async () => ({ kind: "output" }),
          context: async () => ({ cwd: directory, mode: "default" }),
          materialize: async () => ({
            attachments: [],
          }),
        }),
      );
      const resolve = vi.fn(client.resolve.bind(client));
      const sealer = new EncryptedChatEventSealer(
        service,
        f.chatId,
        { explanation: null, steps: [], question: null },
        createManagedNativeOutputIdentityResolver({
          client: { open: client.open.bind(client), resolve },
          scope: () => ({
            chatId: binding.chatId,
            threadId: binding.threadId,
            provenance: { kind: "binding", bindingId: binding.id },
          }),
        }),
      );
      const oldMessage = () =>
        sealer.message({
          id: "shared-answer",
          text: "legacy partial",
          phase: "final_answer",
          streaming: true,
          correlation: {
            sourceMethod: "item/agentMessage/delta",
            diagnosticId: null,
            threadId,
            turnId: "turn",
            itemId: "shared-answer",
          },
        });
      const canonicalWrite = async () => {
        await event("shared-answer", "canonical final");
        await projection.drain();
      };
      if (!sealerFirst) await canonicalWrite();
      const [old, concurrent] = await Promise.all([oldMessage(), oldMessage()]);
      expect(old.message.id).toBe(concurrent.message.id);
      expect(resolve).toHaveBeenCalledTimes(1);
      await f.repository.upsertEncryptedMessage(
        f.ownerId,
        f.chatId,
        old.message,
      );
      if (sealerFirst) await canonicalWrite();
      // A later streaming event has the same canonical identity and is returned
      // as the committed final output by the legacy publication route.
      const saved = await f.repository.upsertEncryptedMessage(
        f.ownerId,
        f.chatId,
        (await oldMessage()).message,
      );
      const stored = await canonical();
      expect(stored.messages).toHaveLength(1);
      expect(stored.messages[0]!.id).toBe(old.message.id);
      expect(stored.items[0]!.messageId).toBe(old.message.id);
      expect(saved?.protectedContent).toEqual(
        stored.messages[0]!.protectedContent,
      );
      expect(
        await openEncryptedChatTurn({
          service,
          threadId,
          history: [],
          prompt: {
            ...old.message,
            protectedContent: saved!.protectedContent!,
          },
        }),
      ).toBe("canonical final");
    },
  );

  it("recovers an existing output by native turn over HTTP and updates it after reopening without duplicating the message", async () => {
    const binding = await client.open({
      chatId: f.chatId,
      threadId,
      provenance: { kind: "binding", bindingId: options.bindingId },
    });
    const original = await protectChatMessage({
      id: randomUUID(),
      service,
      message: {
        role: "user",
        content: [{ type: "text", text: "GUI request" }],
        idempotencyKey: "gui-request",
      },
    });
    await f.repository.appendEncryptedMessage(f.ownerId, f.chatId, original);
    const admission = nativeCommandAdmissionSchema.parse({
      workerId: f.workerId,
      operationId: randomUUID(),
      origin: "gui",
      method: "turn/start",
      session: {
        chatId: f.chatId,
        threadId,
        contextKind: "project",
        projectId: f.projectId,
        placementId: binding.worktreeId,
        modelRouteId: binding.modelRouteId,
        providerAccountId: binding.providerAccountId,
        runtimeGeneration: randomUUID(),
        connectionId: "output-recovery-fixture",
      },
      payloadDigest: "a".repeat(64),
      protectedPayload: original.protectedContent.envelope,
      expectedActivationGeneration: null,
      intent: { scope: "thread" },
    });
    const grant = await f.repository.nativeCommands.admit(
      f.ownerId,
      admission,
      { clientMessageId: original.id },
    );
    await f.repository.nativeCommands.dispatch(f.ownerId, {
      workerId: f.workerId,
      operationId: admission.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      payloadDigest: admission.payloadDigest,
      session: admission.session,
    });
    await f.repository.nativeCommands.settle(f.ownerId, {
      workerId: f.workerId,
      operationId: admission.operationId,
      operationGeneration: grant.receipt.operationGeneration,
      status: "applied",
      protectedResult: original.protectedContent.envelope,
      resultDigest: "b".repeat(64),
      rejectionCode: null,
      executionComplete: true,
      reconciliation: {
        nativeTurnId: "turn",
        runtimeGeneration: admission.session.runtimeGeneration!,
      },
    });
    // Recovery of already published outputs requests provenance by native
    // identity; the worker does not have to know the command operation ID.
    const associate = vi.fn(async () => ({ kind: "observed-output" as const }));
    project.mockImplementation(
      createNativeHistoryProjector({
        binding,
        service,
        client,
        associate,
        context: async () => ({ cwd: directory, mode: "default" }),
        materialize: async () => ({
          attachments: [],
        }),
      }),
    );
    await event("answer", "recovered answer");
    await expect(projection.drain()).rejects.toMatchObject({
      code: "output-message-unavailable",
    });
    expect((await projection.checkpoint()).cursor.sequence).toBe(0);
    expect((await canonical()).items).toEqual([]);
    const sealer = new EncryptedChatEventSealer(service, f.chatId, {
      explanation: null,
      steps: [],
      question: null,
    });
    const old = await sealer.message({
      id: "answer",
      text: "old partial answer",
      phase: "final_answer",
      streaming: true,
      correlation: {
        sourceMethod: "item/started",
        diagnosticId: null,
        threadId,
        turnId: "turn",
        itemId: "answer",
      },
    });
    await f.repository.appendEncryptedMessage(f.ownerId, f.chatId, old.message);
    const recovered = await reopen();
    await recovered.drain();
    let stored = await canonical();
    expect(stored.messages).toHaveLength(2);
    expect(stored.items[0]!.messageId).toBe(old.message.id);
    expect(stored.items[0]!.outputOperationId).toBe(admission.operationId);
    associate.mockImplementation(async () => {
      throw new Error("Existing mapping must be reused");
    });
    await event("answer", "final recovered answer");
    await (await reopen()).drain();
    stored = await canonical();
    expect(stored.messages).toHaveLength(2);
    const final = stored.messages.find(
      (message) => message.id === old.message.id,
    )!;
    expect(
      await openEncryptedChatTurn({
        service,
        threadId,
        history: [],
        prompt: {
          ...old.message,
          protectedContent: final.protectedContent!,
        },
      }),
    ).toBe("final recovered answer");
    expect(stored.items[0]!.revision).toBe(2);
    expect(stored.items[0]!.protectedEvidence).not.toBeNull();
  });

  it.each([false, true])(
    "automatically aliases observed native client IDs and preserves original attachments: %s",
    async (withAttachment) => {
      const binding = await client.open({
        chatId: f.chatId,
        threadId,
        provenance: { kind: "binding", bindingId: options.bindingId },
      });
      const originalAttachment = withAttachment
        ? await new NativeHistoryAttachmentStore({
            directory: path.join(directory, "original-gui-attachment"),
            binding,
            service,
            attachments: new AttachmentStore(directory),
          }).materialize({
            identity: {
              threadId,
              turnId: "original",
              itemId: "gui-file",
              identityKind: "canonical",
              component: "user",
            },
            partIndex: 0,
            fileName: "original.txt",
            mimeType: "text/plain",
            kind: "text",
            bytes: new TextEncoder().encode("original GUI attachment bytes"),
          })
        : null;
      if (originalAttachment) {
        const attachment = originalAttachment.attachment;
        await f.repository.nativeHistoryBindings.withBinding(
          f.ownerId,
          f.workerId,
          f.chatId,
          binding.id,
          async (tx) => {
            await tx.insert(schema.chatAttachments).values({
              id: attachment.id,
              chatId: f.chatId,
              workerId: f.workerId,
              protectedMetadata: attachment.protectedMetadata,
              sizeBytes: attachment.sizeBytes,
              status: attachment.status,
              createdAt: new Date(attachment.createdAt),
            });
          },
        );
      }
      const original = await protectChatMessage({
        id: randomUUID(),
        service,
        message: {
          role: "user",
          content: [
            { type: "text", text: "original GUI input" },
            ...(originalAttachment?.content ?? []),
          ],
          idempotencyKey: "original-gui-input",
        },
      });
      await f.repository.appendEncryptedMessage(f.ownerId, f.chatId, original);
      const admission = nativeCommandAdmissionSchema.parse({
        workerId: f.workerId,
        operationId: randomUUID(),
        origin: "gui",
        method: "turn/start",
        session: {
          chatId: f.chatId,
          threadId,
          contextKind: "project",
          projectId: f.projectId,
          placementId: binding.worktreeId,
          modelRouteId: binding.modelRouteId,
          providerAccountId: binding.providerAccountId,
          runtimeGeneration: randomUUID(),
          connectionId: "projection-fixture",
        },
        payloadDigest: "a".repeat(64),
        protectedPayload: original.protectedContent.envelope,
        expectedActivationGeneration: null,
        intent: { scope: "thread" },
      });
      const grant = await f.repository.nativeCommands.admit(
        f.ownerId,
        admission,
        { clientMessageId: original.id },
      );
      expect(grant.receipt.status).toBe("accepted");
      await f.repository.nativeCommands.dispatch(f.ownerId, {
        workerId: f.workerId,
        operationId: admission.operationId,
        operationGeneration: grant.receipt.operationGeneration,
        payloadDigest: admission.payloadDigest,
        session: admission.session,
      });
      const associate = vi.fn(async () => {
        throw new Error(
          "Observed input must use the automatic provenance path",
        );
      });
      const materialize = vi.fn(async () => {
        throw new Error(
          "Preserved GUI input must not read transformed native files",
        );
      });
      project.mockImplementation(
        createNativeHistoryProjector({
          binding,
          service,
          client,
          associate,
          context: async () => ({ cwd: directory, mode: "default" }),
          materialize,
        }),
      );
      const observe = () =>
        source.append({
          kind: "notification",
          generation: "runtime",
          sequence: ++sequence,
          threadId,
          receivedAtMs: Date.now(),
          method: "item/completed",
          params: {
            threadId,
            turnId: "turn",
            item: {
              id: "native-input",
              type: "userMessage",
              clientId: `cantrip:${original.id}`,
              content: [
                { type: "text", text: "transformed native input" },
                { type: "localImage", path: "/must-not-read-transformed-file" },
              ],
            },
          },
        });
      await observe();
      await expect(projection.drain()).rejects.toMatchObject({
        code: "input-provenance-unobserved",
      });
      expect((await projection.checkpoint()).cursor.sequence).toBe(0);
      await f.repository.nativeCommands.settle(f.ownerId, {
        workerId: f.workerId,
        operationId: admission.operationId,
        operationGeneration: grant.receipt.operationGeneration,
        status: "applied",
        protectedResult: original.protectedContent.envelope,
        resultDigest: "b".repeat(64),
        rejectionCode: null,
        executionComplete: false,
        reconciliation: {
          nativeTurnId: "turn",
          runtimeGeneration: admission.session.runtimeGeneration!,
        },
      });
      const recovered = await reopen();
      await recovered.drain();
      expect(associate).not.toHaveBeenCalled();
      const stored = await canonical();
      expect(stored.messages).toHaveLength(1);
      expect(stored.messages[0]!.id).toBe(original.id);
      expect(stored.messages[0]!.protectedContent).toEqual(
        original.protectedContent,
      );
      expect(stored.items[0]!.messageId).toBe(original.id);
      expect((await recovered.checkpoint()).cursor.sequence).toBe(1);
      expect(materialize).not.toHaveBeenCalled();
      expect(stored.messages[0]!.attachmentIds).toEqual(
        original.classification.attachmentIds,
      );
      await observe();
      await (await reopen()).drain();
      const replayed = await canonical();
      expect(replayed.messages).toHaveLength(1);
      expect(replayed.items[0]!.revision).toBe(1);
      expect(replayed.messages[0]!.protectedContent).toEqual(
        original.protectedContent,
      );
      expect(materialize).not.toHaveBeenCalled();
      await f.repository.nativeHistoryBindings.withBinding(
        f.ownerId,
        f.workerId,
        f.chatId,
        binding.id,
        async (tx) => {
          const descriptors = await tx.select().from(schema.chatAttachments);
          expect(descriptors).toHaveLength(withAttachment ? 1 : 0);
          if (originalAttachment)
            expect(descriptors[0]!.protectedMetadata).toEqual(
              originalAttachment.attachment.protectedMetadata,
            );
          // Referencing the existing GUI attachment does not invent a verified
          // local replica for this history reader.
          expect(await tx.select().from(schema.chatAttachmentReplicas)).toEqual(
            [],
          );
        },
      );
    },
  );

  it("resolves a page of native items together and recovers a lost reservation response before staging", async () => {
    const binding = await client.open({
      chatId: f.chatId,
      threadId,
      provenance: { kind: "binding", bindingId: options.bindingId },
    });
    project.mockImplementation(
      createNativeHistoryProjector({
        binding,
        service,
        client,
        context: async () => ({ cwd: directory, mode: "default" }),
        materialize: async () => ({
          attachments: [],
        }),
        associate: async () => ({ kind: "native" }),
      }),
    );
    await event("first");
    await event("second");
    await event("third");
    const actualResolve = client.resolve.bind(client);
    const resolve = vi
      .spyOn(client, "resolve")
      .mockImplementationOnce(async (...args) => {
        await actualResolve(...args);
        throw new Error("lost reservation response");
      });
    await expect(projection.drain()).rejects.toThrow(
      "lost reservation response",
    );
    const reserved = (await canonical()).items;
    expect(reserved).toHaveLength(3);
    expect(reserved.every((item) => item.revision === 0)).toBe(true);
    expect((await canonical()).messages).toHaveLength(0);
    expect((await projection.checkpoint()).cursor.sequence).toBe(0);
    expect(
      (await readdir(projection.directory)).filter((file) =>
        file.endsWith(".stage.json"),
      ),
    ).toHaveLength(0);
    const recovered = await reopen();
    await recovered.drain();
    expect(resolve).toHaveBeenCalledTimes(2); // One batched reservation per attempt.
    expect(
      resolve.mock.calls.every(([request]) => request.items.length === 3),
    ).toBe(true);
    expect(
      (await canonical()).items.map((item) => item.messageId).sort(),
    ).toEqual(reserved.map((item) => item.messageId).sort());
    expect((await canonical()).messages).toHaveLength(3);
    expect((await canonical()).receipts).toHaveLength(1);
  });

  it("checkpoints repeated evidence without reserving IDs or resealing unchanged content", async () => {
    await event("same");
    const resolve = vi.spyOn(client, "resolve");
    await projection.drain();
    const first = (await canonical()).items[0]!;
    const second = await event("same");
    const recovered = await reopen();
    await recovered.drain();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect((await canonical()).items[0]!.protectedEvidence).toEqual(
      first.protectedEvidence,
    );
    expect((await canonical()).items[0]!.revision).toBe(1);
    expect((await recovered.checkpoint()).cursor.recordId).toBe(
      second.recordId,
    );
    const state = nativeHistoryProjectorStateSchema.parse(
      (await recovered.checkpoint()).state,
    );
    expect(state.source.turns[0]!.items[0]!.origin.sequence).toBe(2);
    expect((await canonical()).receipts).toHaveLength(2);
  });

  it("projects live items and terminal aggregates independently, retaining unresolved evidence across reopen", async () => {
    const initialSettings = {
      model: "private-captured-model",
      modelProvider: "private-captured-provider",
      reasoningEffort: null,
      effectiveReasoningEffort: "high",
      serviceTier: "default",
      effectiveServiceTier: null,
      collaborationMode: "plan",
    };
    const append = (method: string, params: Record<string, unknown>) =>
      source.append({
        kind: "notification",
        generation: "runtime",
        sequence: ++sequence,
        threadId,
        receivedAtMs: Date.now(),
        method,
        params: { threadId, turnId: "turn", ...params },
      });
    await append("turn/started", {
      initialSettings,
      turn: {
        id: "turn",
        status: "inProgress",
        startedAt: 1788000000,
        items: [],
      },
    });
    await append("item/started", {
      item: { id: "answer", type: "agentMessage", text: "" },
    });
    await append("item/agentMessage/delta", {
      itemId: "answer",
      delta: "retained ",
    });
    await append("item/started", {
      item: {
        id: "late-tool",
        type: "futureTool",
        extension: { retained: true },
      },
    });
    await append("future/scopedEvidence", {
      privateWarning: "unknown native detail",
    });
    await projection.drain();
    const initial = await canonical();
    expect(
      JSON.stringify(
        await client.archiveTurns({
          chatId: f.chatId,
          bindingId: options.bindingId,
        }),
      ),
    ).not.toContain("private-captured");
    expect(initial.items).toHaveLength(2);
    expect(initial.items.every((item) => item.state === "started")).toBe(true);
    const reopened = await reopen();
    await append("thread/settings/updated", {
      threadSettings: { ...initialSettings, model: "later-unrelated-default" },
    });
    await append("item/agentMessage/delta", {
      itemId: "answer",
      delta: "answer",
    });
    await append("item/completed", {
      item: { id: "answer", type: "agentMessage", text: "retained answer" },
    });
    await append("turn/completed", {
      turn: {
        id: "turn",
        status: "completed",
        completedAt: 1788000002,
        durationMs: 1750,
        items: [],
      },
    });
    await reopened.drain();
    const stored = await canonical();
    expect(stored.items.find((item) => item.itemId === "answer")!.state).toBe(
      "completed",
    );
    expect(
      stored.items.find((item) => item.itemId === "late-tool")!.state,
    ).toBe("started");
    const recoveredTurns = await openNativeHistoryTurnArchivePage({
      service,
      page: await client.archiveTurns({
        chatId: f.chatId,
        bindingId: options.bindingId,
      }),
    });
    expect(recoveredTurns.turns[0]).toMatchObject({
      turn: {
        status: "completed",
        startedAtMs: 1788000000000,
        completedAtMs: 1788000002000,
      },
      source: {
        version: 2,
        reducedTurn: {
          body: { status: "completed", durationMs: 1750 },
          terminalNotification: "completed",
          metadata: { initialSettings },
        },
        evidence: expect.arrayContaining([
          expect.objectContaining({
            method: "future/scopedEvidence",
            params: expect.objectContaining({
              privateWarning: "unknown native detail",
            }),
          }),
        ]),
      },
    });
    const state = nativeHistoryProjectorStateSchema.parse(
      (await reopened.checkpoint()).state,
    );
    expect(
      state.source.turns[0]!.items.find((item) => item.id === "answer")!.body
        .text,
    ).toBe("retained answer");
    expect(state.source.turns[0]!.metadata?.initialSettings).toEqual(
      initialSettings,
    );
    const recovery = await readNativeHistoryRecovery({
      binding: recoveredTurns.binding,
      service,
      client,
    });
    // Another binding's larger revision does not outweigh an actual completion.
    const older = structuredClone(recovery.turns[0]!);
    older.bindingId = randomUUID();
    older.turn.revision += 100;
    older.turn.status = "interrupted";
    older.turn.completedAtMs = null;
    const olderSource = older.source as {
      reducedTurn: {
        terminalNotification?: string;
        body: Record<string, unknown>;
      };
    };
    delete olderSource.reducedTurn.terminalNotification;
    olderSource.reducedTurn.body.status = "interrupted";
    olderSource.reducedTurn.body.completedAt = null;
    olderSource.reducedTurn.body.durationMs = 99999;
    olderSource.reducedTurn.body.error = { message: "stale snapshot failure" };
    const bootstrapped = restoreNativeHistoryProjectorState({
      ...recovery,
      turns: [older, ...recovery.turns],
    });
    expect(bootstrapped.source.turns[0]).toMatchObject({
      body: { status: "completed", durationMs: 1750, completedAt: 1788000002 },
      terminalNotification: "completed",
    });
    expect(bootstrapped.source.turns[0]!.body.error).toBeUndefined();
    olderSource.reducedTurn.terminalNotification = "interrupted";
    const disputed = restoreNativeHistoryProjectorState({
      ...recovery,
      turns: [older, ...recovery.turns],
    });
    expect(disputed.source.turns[0]!.body.status).toBeUndefined();
    expect(disputed.source.turns[0]!.terminalNotification).toBeUndefined();
    const lateStop = reduceNativeHistory(
      bootstrapped.source,
      [
        {
          recordId: randomUUID(),
          sequence: 1,
          frame: {
            kind: "notification",
            generation: "replacement",
            sequence: 1,
            receivedAtMs: Date.now(),
            threadId,
            method: "turn/completed",
            params: {
              threadId,
              turn: { id: "turn", status: "interrupted", items: [] },
            },
          },
        },
      ],
      threadId,
    );
    expect(lateStop.turns[0]!.body.status).toBe("completed");
    const afterReconnect = await reopen();
    await afterReconnect.drain();
    expect(
      nativeHistoryProjectorStateSchema.parse(
        (await afterReconnect.checkpoint()).state,
      ).source.turns[0]!.metadata?.initialSettings,
    ).toEqual(initialSettings);
    expect(
      JSON.stringify(
        await client.archiveTurns({
          chatId: f.chatId,
          bindingId: options.bindingId,
        }),
      ),
    ).not.toContain("private-captured");
    expect(stored.messages).toHaveLength(2);
    expect(f.phases).toHaveLength(0);
  });

  it("recovers a partially committed stage after complete outbox loss without reencrypting or resending its accepted prefix", async () => {
    await event("one");
    const second = await event("two");
    const deliver = client.deliver.bind(client);
    const calls = vi.spyOn(client, "deliver");
    calls.mockImplementationOnce(async (...args) => {
      await deliver(...args);
      throw new Error("lost prefix ACK before outbox loss");
    });
    await expect(projection.drain()).rejects.toThrow("lost prefix ACK");
    const before = await canonical();
    expect(before.receipts).toHaveLength(1);
    expect((await projection.checkpoint()).cursor.sequence).toBe(0);
    const stagePath = path.join(
      projection.directory,
      "0000000000000001.stage.json",
    );
    const stage = await readFile(stagePath, "utf8");
    const streamId = outbox.streamId;
    await rm(outbox.directory, { recursive: true });
    const binding = await client.open({
      chatId: f.chatId,
      threadId,
      provenance: { kind: "binding", bindingId: options.bindingId },
    });
    const recoveredOutbox = await NativeHistoryOutbox.open({
      directory: path.join(directory, "outbox"),
      workerId: f.workerId,
      chatId: f.chatId,
      bindingId: options.bindingId,
      service,
      recover: () => readNativeHistoryRecovery({ binding, service, client }),
    });
    expect(recoveredOutbox.streamId).toBe(streamId);
    const recovered = await NativeHistoryProjection.open({
      ...options,
      outbox: recoveredOutbox,
    });
    await recovered.drain();
    expect(project).toHaveBeenCalledTimes(1);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(calls.mock.calls[1]![1].recordId).not.toBe(
      calls.mock.calls[0]![1].recordId,
    );
    expect(calls.mock.calls[1]![1].sequence).toBe(2);
    expect(await readFile(stagePath, "utf8")).toBe(stage);
    expect((await recovered.checkpoint()).cursor).toEqual({
      sequence: second.sequence,
      recordId: second.recordId,
    });
    const after = await canonical();
    expect(after.messages).toHaveLength(2);
    expect(after.receipts).toHaveLength(2);
    expect(
      after.messages.find((message) => message.id === before.messages[0]!.id)!
        .protectedContent,
    ).toEqual(before.messages[0]!.protectedContent);
    expect(await recoveredOutbox.pending()).toEqual([]);
    const again = await NativeHistoryProjection.open({
      ...options,
      outbox: await NativeHistoryOutbox.open({
        directory: path.join(directory, "outbox"),
        workerId: f.workerId,
        chatId: f.chatId,
        bindingId: options.bindingId,
        service,
      }),
    });
    expect(await again.checkpoint()).toEqual(await recovered.checkpoint());
  });

  it("recovers exact ciphertext after a lost real canonical ACK without reducing the source twice", async () => {
    const first = await event("one");
    const deliver = client.deliver.bind(client);
    const calls = vi.spyOn(client, "deliver");
    calls.mockImplementationOnce(async (...args) => {
      await deliver(...args);
      throw new Error("lost committed response");
    });
    await expect(projection.drain()).rejects.toThrow("lost committed response");
    expect((await canonical()).messages).toHaveLength(1);
    expect(await projection.checkpoint()).toEqual({
      cursor: { sequence: 0, recordId: null },
      state: null,
    });
    const stagePath = path.join(
      projection.directory,
      "0000000000000001.stage.json",
    );
    const savedStage = await readFile(stagePath, "utf8");
    expect(savedStage).not.toContain("fixture-only projected secret");
    expect(savedStage).not.toContain('"one"');
    const recovered = await reopen();
    await recovered.drain();
    expect(project).toHaveBeenCalledTimes(1);
    expect(calls.mock.calls[1]).toEqual(calls.mock.calls[0]);
    expect(await readFile(stagePath, "utf8")).toBe(savedStage);
    expect((await recovered.checkpoint()).cursor).toEqual({
      sequence: first.sequence,
      recordId: first.recordId,
    });
    expect(revisions((await recovered.checkpoint()).state)).toEqual({ one: 1 });
    const stored = await canonical();
    expect(stored.messages).toHaveLength(1);
    expect(stored.receipts).toHaveLength(1);
    const [record] = await outbox.pending();
    expect(record).toBeUndefined();
    const sent = JSON.parse(calls.mock.calls[0]![2]);
    expect(stored.items[0]!.protectedEvidence).toEqual(sent.items[0].evidence);
    const evidence = await openNativeHistoryItemEvidence({
      service,
      binding: {
        id: options.bindingId,
        chatId: f.chatId,
        workerId: f.workerId,
        threadId,
      },
      identity: sent.items[0].identity,
      evidence: stored.items[0]!.protectedEvidence!,
    });
    expect(evidence.body.nativeExtension).toEqual({
      retained: "outside the UI preview",
    });
    expect(evidence.body.text).toBe("fixture-only projected secret");
    const saved = (await f.repository.getEncryptedMessageByIdempotencyKey(
      f.ownerId,
      f.chatId,
      sent.items[0].message.idempotencyKey,
    ))!;
    expect(saved.id).toBe(sent.items[0].message.id);
    expect(
      await openEncryptedChatTurn({
        history: [],
        prompt: {
          ...sent.items[0].message,
          protectedContent: saved.protectedContent,
          classification: {
            role: saved.role,
            mode: saved.mode,
            attachmentIds: saved.attachmentIds,
          },
        },
        service,
        threadId,
      }),
    ).toBe("fixture-only projected secret");
  });

  it("does not advance state after only part of a multi-batch stage commits", async () => {
    await event("one");
    const last = await event("two");
    const deliver = client.deliver.bind(client);
    const calls = vi.spyOn(client, "deliver");
    calls
      .mockImplementationOnce(deliver)
      .mockRejectedValueOnce(new Error("server unavailable"));
    await expect(projection.drain()).rejects.toThrow("server unavailable");
    expect((await canonical()).messages).toHaveLength(1);
    expect((await projection.checkpoint()).cursor.sequence).toBe(0);
    const recovered = await reopen();
    await recovered.drain();
    expect(project).toHaveBeenCalledTimes(1);
    expect(calls).toHaveBeenCalledTimes(3); // First committed batch was not sent again.
    expect(calls.mock.calls[2]).toEqual(calls.mock.calls[1]);
    expect((await recovered.checkpoint()).cursor).toEqual({
      sequence: last.sequence,
      recordId: last.recordId,
    });
    expect(revisions((await recovered.checkpoint()).state)).toEqual({
      one: 1,
      two: 1,
    });
    expect((await canonical()).messages).toHaveLength(2);
  });

  it("repairs a failed local checkpoint after canonical ACK, then assigns the next revision from recovered state", async () => {
    const resolve = vi.spyOn(client, "resolve");
    await event("one");
    const obstruction = path.join(
      projection.directory,
      "0000000000000001.commit.json",
    );
    // Install the obstruction after actual delivery, immediately before the
    // local checkpoint write. No earlier successful state is fabricated.
    const actualDeliver = client.deliver.bind(client);
    const calls = vi
      .spyOn(client, "deliver")
      .mockImplementationOnce(async (...args) => {
        const receipt = await actualDeliver(...args);
        await mkdir(obstruction);
        return receipt;
      });
    await expect(projection.drain()).rejects.toThrow();
    expect((await canonical()).receipts).toHaveLength(1);
    await rm(obstruction, { recursive: true });
    const recovered = await reopen();
    await recovered.drain();
    expect(calls).toHaveBeenCalledTimes(1);
    const second = await event("one", "updated fixture answer");
    await recovered.drain();
    expect(project).toHaveBeenCalledTimes(2);
    expect(revisions(project.mock.calls[1]![1])).toEqual({ one: 1 });
    expect(revisions((await recovered.checkpoint()).state)).toEqual({ one: 2 });
    expect((await recovered.checkpoint()).cursor.recordId).toBe(
      second.recordId,
    );
    expect((await canonical()).messages).toHaveLength(1);
    expect(JSON.parse(calls.mock.calls[1]![2]).items[0].revision).toBe(2);
    expect(
      resolve.mock.calls.map(([request]) => request.items[0]!.association.kind),
    ).toEqual(["native", "existing"]);
  });

  it("serializes separate handles, commits empty reductions, and rejects a missing source identity", async () => {
    project.mockResolvedValue({
      state: { retained: "private state" },
      batches: [],
    });
    await event("unprojected-type");
    const other = await reopen();
    await Promise.all([projection.drain(), other.drain()]);
    expect(project).toHaveBeenCalledTimes(1);
    expect((await canonical()).messages).toHaveLength(0);
    expect((await canonical()).receipts).toHaveLength(1);
    expect((await projection.checkpoint()).cursor.sequence).toBe(1);
    const replacement = await NativeHistorySourceJournal.open({
      directory: path.join(directory, "different-source"),
      workerId: f.workerId,
      chatId: f.chatId,
      bindingId: options.bindingId,
      threadId,
      service,
    });
    await expect(
      NativeHistoryProjection.open({ ...options, source: replacement }),
    ).rejects.toThrow("different source or outbox");
    await expect(
      NativeHistoryProjection.open({ ...options, chatId: randomUUID() }),
    ).rejects.toThrow("exact binding");
    const stages = await readdir(projection.directory);
    expect(stages.filter((file) => file.endsWith(".stage.json"))).toHaveLength(
      1,
    );
    await rm(path.join(projection.directory, "projection.json"));
    await expect(reopen()).rejects.toThrow("lost its identity");
  });

  it("retries canonical delivery automatically from capture while the native source and UI remain idle", async () => {
    const observations = new NativeHistoryObservations();
    observations.replace("captured-runtime");
    const errors = vi.fn();
    const capture = new NativeHistoryCapture({
      runtime: {
        observeNativeHistory: (id, observer) =>
          observations.subscribe(id, observer, async () =>
            parseCodexNativeHistory(
              { thread: { id, status: { type: "idle" }, turns: [] } },
              id,
            ),
          ),
      },
      threadId,
      journal: source,
      onPersisted: () => projection.drain(),
      onError: errors,
      retryDelayMs: 10,
      maxRetryDelayMs: 20,
      snapshotDelayMs: 0,
    });
    try {
      await capture.flush();
      const actualDeliver = client.deliver.bind(client);
      const deliver = vi
        .spyOn(client, "deliver")
        .mockImplementationOnce(async (...args) => {
          await actualDeliver(...args);
          throw new Error("lost response while UI stays connected");
        });
      observations.notification("item/completed", {
        threadId,
        turnId: "turn",
        item: {
          id: "automatic",
          type: "agentMessage",
          text: "automatic fixture answer",
        },
      });
      await capture.flush();
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "lost response while UI stays connected",
        }),
        "notify",
      );
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(deliver.mock.calls[1]).toEqual(deliver.mock.calls[0]);
      expect(project).toHaveBeenCalledTimes(2); // Initial snapshot + one item, no retry reduction.
      expect(revisions((await projection.checkpoint()).state)).toEqual({
        automatic: 1,
      });
      expect((await projection.checkpoint()).cursor.sequence).toBe(2);
      expect((await canonical()).messages).toHaveLength(1);
      expect((await canonical()).receipts).toHaveLength(2);
      expect(f.phases).toHaveLength(0);
    } finally {
      capture.stop();
    }
  });
});
