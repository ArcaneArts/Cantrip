import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeCommandWorkerFixture } from "../../cantrip_server/test/native-command-worker-fixture.js";
import * as schema from "../../cantrip_server/src/db/schema.js";
import { ManagedNativeHistorySources } from "../src/managed-native-history-sources.js";
import { ManagedNativeHistoryProjection } from "../src/managed-native-history-projection.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";
import { decryptChatMessageProtectedContent } from "@cantrip/crypto";
import { AttachmentStore } from "../src/attachment-store.js";
import { openWorkerAttachment } from "../src/attachment-encryption.js";
import { createNativeHistoryProjectorAdapters } from "../src/native-history-projector-adapters.js";
import { NativeHistoryClient } from "../src/native-history-client.js";
import { NativeHistorySourceJournal } from "../src/native-history-source-journal.js";
import { NativeHistoryOutbox } from "../src/native-history-outbox.js";
import { NativeHistoryProjection } from "../src/native-history-projection.js";
import { nativeHistoryProjectorStateSchema } from "../src/native-history-projector.js";
import { NativeHistoryObservations } from "../src/codex/native-history-observation.js";
import { parseCodexNativeHistory } from "../src/codex/native-history.js";

let f: Awaited<ReturnType<typeof createNativeCommandWorkerFixture>>;
let directory: string;
let client: NativeHistoryClient;
let sources: ManagedNativeHistorySources;
let threadId: string;
let generation: string;
let observations: NativeHistoryObservations;
const pumps: ManagedNativeHistoryProjection[] = [];
const errors = vi.fn();
const reads = vi.fn();
const service = {
  ownerId: () => f.ownerId,
  serverIdentity: () => f.serverId,
  componentKey: () => ({ key: new Uint8Array(32).fill(47), keyRevision: 1 }),
};
const runtime = {
  get transportGeneration() {
    return generation;
  },
  observeNativeHistory(
    id: string,
    observer: Parameters<NativeHistoryObservations["subscribe"]>[1],
  ) {
    return observations.subscribe(id, observer, async () => {
      reads();
      return parseCodexNativeHistory(
        { thread: { id, status: { type: "idle" }, turns: [] } },
        id,
      );
    });
  },
};
const bind = () => sources.bind({ runtime, chatId: f.chatId, threadId });
const event = (itemId: string) =>
  observations.notification("item/completed", {
    threadId,
    turnId: "turn",
    item: { type: "agentMessage", id: itemId, text: "fixture-only secret" },
  });
async function journal() {
  const binding = await client.open({
    chatId: f.chatId,
    threadId,
    provenance: { kind: "current" },
  });
  return NativeHistorySourceJournal.open({
    directory,
    workerId: f.workerId,
    chatId: f.chatId,
    threadId,
    bindingId: binding.id,
    service,
  });
}
async function counts() {
  const binding = await client.open({
    chatId: f.chatId,
    threadId,
    provenance: { kind: "current" },
  });
  return f.repository.nativeHistoryBindings.withBinding(
    f.ownerId,
    f.workerId,
    f.chatId,
    binding.id,
    async (tx) => ({
      commands: (await tx.select().from(schema.nativeCommands)).length,
      receipts: (await tx.select().from(schema.nativeHistoryReceipts)).length,
      bindings: (await tx.select().from(schema.nativeHistoryBindings)).length,
    }),
  );
}

beforeEach(async () => {
  errors.mockClear();
  reads.mockClear();
  directory = await mkdtemp(path.join(tmpdir(), "cantrip-managed-history-"));
  f = await createNativeCommandWorkerFixture({
    cwd: directory,
    modelBaseUrl: "http://127.0.0.1:1/v1",
  });
  client = new NativeHistoryClient({
    serverUrl: await f.app.listen({ host: "127.0.0.1", port: 0 }),
    workerId: f.workerId,
    token: () => f.token,
  });
  generation = "transport-1";
  threadId = randomUUID();
  observations = new NativeHistoryObservations();
  observations.replace(generation);
  sources = new ManagedNativeHistorySources({
    directory,
    workerId: f.workerId,
    client,
    service,
    retryDelayMs: 10,
    maxRetryDelayMs: 20,
    snapshotDelayMs: 0,
    onError: errors,
  });
}, 60_000);

afterEach(async () => {
  sources?.stop();
  await Promise.all(pumps.splice(0).map((pump) => pump.stop()));
  vi.restoreAllMocks();
  await f?.close();
  await rm(directory, { recursive: true, force: true });
});

describe("production managed history source ownership", () => {
  const adapters = async () => ({
    context: async () => ({ cwd: directory, mode: "default" as const }),
    materialize: async () => ({ attachments: [] }),
    associate: async () => ({ kind: "output" as const }),
  });
  function pump(
    projector: ConstructorParameters<
      typeof ManagedNativeHistoryProjection
    >[0]["projector"] = adapters,
    sourceDirectory?: string,
  ) {
    const result = new ManagedNativeHistoryProjection({
      directory: path.join(directory, "canonical"),
      workerId: f.workerId,
      service: service as unknown as WorkerEncryptionService,
      client,
      projector,
      sourceDirectory,
      onRecoveryError: (error, key) =>
        errors(error, { phase: "recovery", key }),
      retryDelayMs: 10,
      maxRetryDelayMs: 20,
      onError: errors,
    });
    pumps.push(result);
    return result;
  }
  function connectProjection(projection: ManagedNativeHistoryProjection) {
    sources.stop();
    sources = new ManagedNativeHistorySources({
      directory,
      workerId: f.workerId,
      service,
      client,
      retryDelayMs: 10,
      maxRetryDelayMs: 20,
      snapshotDelayMs: 0,
      onPersisted: (saved, scope) => projection.wake(saved, scope),
      onError: errors,
    });
  }

  it.each(["item/completed", "item/started"])(
    "automatically rebases a real concurrent revision conflict and reuses its plan across failures: %s",
    async (candidateMethod) => {
      await f.bindThread(threadId);
      const saved = await journal();
      await saved.append({
        kind: "notification",
        threadId,
        generation,
        sequence: 1,
        receivedAtMs: 1,
        method: "fixture/early-warning",
        params: { threadId, warning: "unmaterialized early evidence" },
      });
      const binding = await client.open({
        chatId: f.chatId,
        threadId,
        provenance: { kind: "binding", bindingId: saved.scope.bindingId },
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
          );
          await tx
            .insert(schema.workers)
            .values({ ...worker!, id: other.workerId });
          await tx.insert(schema.nativeHistoryBindings).values({
            ...other,
            ownerId: f.ownerId,
            createdAt: new Date(other.createdAt),
          });
        },
      );
      const archive = vi.spyOn(client, "archive");
      const projection = pump();
      projection.wake(saved, {
        chatId: f.chatId,
        threadId,
        bindingId: binding.id,
      });
      await projection.flush();
      const actualDeliver = client.deliver.bind(client);
      const deliver = vi
        .spyOn(client, "deliver")
        .mockImplementationOnce(async (...args) => {
          const batch = JSON.parse(args[2]);
          expect(batch.items).toHaveLength(1);
          // A competing historical producer wins after bootstrap. Its legacy
          // candidate omits evidence, so its digest differs from the pending batch.
          await f.repository.nativeHistoryIngestion.ingest(f.ownerId, {
            workerId: other.workerId,
            chatId: f.chatId,
            bindingId: other.id,
            streamId: randomUUID(),
            sequence: 1,
            recordId: randomUUID(),
            digest: "a".repeat(64),
            previousDigest: null,
            batch: {
              items: batch.items.map(
                ({ evidence: _evidence, ...item }: any) => ({
                  ...item,
                  revision: 5,
                  state: "completed",
                }),
              ),
              turns: [],
            },
          });
          return actualDeliver(...args);
        })
        .mockImplementation(actualDeliver);
      let planPath = "",
        frozenPlan = "";
      const actualReplace = NativeHistoryOutbox.prototype.replaceRejected;
      const replace = vi
        .spyOn(NativeHistoryOutbox.prototype, "replaceRejected")
        .mockImplementationOnce(async function () {
          const root = path.join(directory, "canonical", "projection");
          const [lane] = await readdir(root);
          const folder = path.join(root, lane!);
          const plans = (await readdir(folder)).filter((name) =>
            name.endsWith(".rebase.json"),
          );
          expect(plans).toHaveLength(1);
          planPath = path.join(folder, plans[0]!);
          frozenPlan = await readFile(planPath, "utf8");
          throw new Error("fixture failure before replacement");
        })
        .mockImplementationOnce(async function (...args) {
          await actualReplace.apply(this, args);
          throw new Error("fixture failure after replacement");
        })
        .mockImplementation(actualReplace);
      await saved.append({
        kind: "notification",
        threadId,
        generation,
        sequence: 2,
        receivedAtMs: 2,
        method: candidateMethod,
        params: {
          threadId,
          turnId: "turn",
          item: { id: "answer", type: "agentMessage", text: "retained answer" },
        },
      });
      projection.wake(saved, {
        chatId: f.chatId,
        threadId,
        bindingId: binding.id,
      });
      await projection.close();
      expect(replace).toHaveBeenCalledTimes(3);
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(
        JSON.parse(deliver.mock.calls[0]![2]).items[0].expectedRevision,
      ).toBe(0);
      const repaired = JSON.parse(deliver.mock.calls[1]![2]);
      if (candidateMethod === "item/completed") {
        expect(repaired.items[0]).toMatchObject({
          revision: 6,
          expectedRevision: 5,
        });
      } else {
        expect(repaired.items).toEqual([]);
      }
      expect(archive).toHaveBeenCalledTimes(2);
      expect(await readFile(planPath, "utf8")).toBe(frozenPlan);
      expect(errors.mock.calls.map(([error]) => error.message)).toEqual([
        "fixture failure before replacement",
        "fixture failure after replacement",
      ]);
      expect(await counts()).toMatchObject({ commands: 0, receipts: 3 });
      const outbox = await NativeHistoryOutbox.open({
        directory: path.join(directory, "canonical", "outbox"),
        workerId: f.workerId,
        chatId: f.chatId,
        bindingId: binding.id,
        service,
      });
      const recovered = await NativeHistoryProjection.open({
        directory: path.join(directory, "canonical", "projection"),
        workerId: f.workerId,
        chatId: f.chatId,
        bindingId: binding.id,
        service,
        source: saved,
        outbox,
        client,
        project: async () => {
          throw new Error("read-only checkpoint must not project");
        },
      });
      const checkpoint = await recovered.checkpoint();
      expect(checkpoint.cursor.sequence).toBe(2);
      expect(
        nativeHistoryProjectorStateSchema.parse(checkpoint.state).source
          .evidence,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "fixture/early-warning",
            params: { threadId, warning: "unmaterialized early evidence" },
          }),
        ]),
      );
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it("shares one archive read for fresh outbox and projector recovery without rereading on later pages or restart", async () => {
    await f.bindThread(threadId);
    const saved = await journal();
    const scope = {
      chatId: f.chatId,
      threadId,
      bindingId: saved.scope.bindingId,
    };
    const archive = vi.spyOn(client, "archive");
    const turns = vi.spyOn(client, "archiveTurns");
    const batches = vi.spyOn(client, "archiveBatches");
    const append = (sequence: number) =>
      saved.append({
        kind: "notification",
        threadId,
        generation,
        sequence,
        receivedAtMs: sequence,
        method: "item/completed",
        params: {
          threadId,
          turnId: "turn",
          item: {
            id: `item-${sequence}`,
            type: "agentMessage",
            text: "answer",
          },
        },
      });
    const projection = pump();
    await append(1);
    projection.wake(saved, scope);
    await projection.flush();
    expect(archive).toHaveBeenCalledTimes(1);
    expect(turns).toHaveBeenCalledTimes(1);
    expect(batches).toHaveBeenCalledTimes(1);
    await append(2);
    projection.wake(saved, scope);
    await projection.close();
    const replacement = pump();
    await append(3);
    replacement.wake(saved, scope);
    await replacement.close();
    expect(archive).toHaveBeenCalledTimes(1);
    expect(turns).toHaveBeenCalledTimes(1);
    expect(batches).toHaveBeenCalledTimes(1);
    expect(await counts()).toMatchObject({ commands: 0, receipts: 3 });
    expect(errors).not.toHaveBeenCalled();
  });

  it("releases initialization recovery when the source is empty and reads fresh history for its first observation", async () => {
    await f.bindThread(threadId);
    const saved = await journal();
    const scope = {
      chatId: f.chatId,
      threadId,
      bindingId: saved.scope.bindingId,
    };
    const archive = vi.spyOn(client, "archive");
    const projection = pump();
    projection.wake(saved, scope);
    await projection.flush();
    expect(archive).toHaveBeenCalledTimes(1);
    expect(await counts()).toMatchObject({ commands: 0, receipts: 0 });
    await saved.append({
      kind: "notification",
      threadId,
      generation,
      sequence: 1,
      receivedAtMs: 1,
      method: "item/completed",
      params: {
        threadId,
        turnId: "turn",
        item: { id: "later", type: "agentMessage", text: "later answer" },
      },
    });
    projection.wake(saved, scope);
    await projection.close();
    expect(archive).toHaveBeenCalledTimes(2);
    expect(await counts()).toMatchObject({ commands: 0, receipts: 1 });
    expect(errors).not.toHaveBeenCalled();
  });

  it("discards failed initialization reads and refetches after an unstaged projection failure", async () => {
    await f.bindThread(threadId);
    const saved = await journal();
    await saved.append({
      kind: "notification",
      threadId,
      generation,
      sequence: 1,
      receivedAtMs: 1,
      method: "item/completed",
      params: {
        threadId,
        turnId: "turn",
        item: { id: "answer", type: "agentMessage", text: "retained answer" },
      },
    });
    const archive = vi
      .spyOn(client, "archive")
      .mockRejectedValueOnce(new Error("temporary archive failure"));
    const turns = vi.spyOn(client, "archiveTurns");
    const batches = vi.spyOn(client, "archiveBatches");
    const original = await adapters();
    const context = vi
      .fn(original.context)
      .mockRejectedValueOnce(new Error("temporary presentation failure"));
    const projection = pump(async () => ({ ...original, context }));
    projection.wake(saved, {
      chatId: f.chatId,
      threadId,
      bindingId: saved.scope.bindingId,
    });
    await projection.close();
    expect(archive).toHaveBeenCalledTimes(3);
    expect(turns).toHaveBeenCalledTimes(2);
    expect(batches).toHaveBeenCalledTimes(2);
    expect(context).toHaveBeenCalledTimes(2);
    expect(errors.mock.calls.map(([error]) => error.message)).toEqual([
      "temporary archive failure",
      "temporary presentation failure",
    ]);
    expect(await counts()).toMatchObject({ commands: 0, receipts: 1 });
  });

  it("projects a page before its retained context using real adapters and preserves the original relative image after restart", async () => {
    await f.bindThread(threadId);
    const saved = await journal();
    const originalCwd = path.join(directory, "original");
    const currentCwd = path.join(directory, "current");
    await Promise.all([mkdir(originalCwd), mkdir(currentCwd)]);
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(path.join(originalCwd, "note.png"), bytes);
    await writeFile(
      path.join(currentCwd, "note.png"),
      "wrong current-directory bytes",
    );
    const items = [
      {
        type: "userMessage",
        id: "input",
        content: [{ type: "localImage", path: "note.png" }],
      },
      {
        type: "agentMessage",
        id: "answer",
        text: "original plan answer",
        phase: "final_answer",
      },
    ];
    for (let sequence = 1; sequence <= 128; sequence++)
      await saved.append({
        kind: "notification",
        threadId,
        generation,
        sequence,
        receivedAtMs: sequence,
        method: sequence <= 2 ? "item/completed" : "fixture/retained-evidence",
        params: {
          threadId,
          turnId: "turn",
          ...(sequence <= 2
            ? { item: items[sequence - 1] }
            : { observation: sequence }),
        },
      });
    const snap = {
      kind: "snapshot" as const,
      threadId,
      generation,
      id: randomUUID(),
      readBarrierSequence: 128,
      completedSequence: 128,
      receivedAtMs: 129,
      snapshot: parseCodexNativeHistory(
        {
          thread: {
            id: threadId,
            cwd: currentCwd,
            status: { type: "idle" },
            turns: [{ id: "turn", status: "completed", items }],
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
                contexts: [
                  {
                    cwd: originalCwd,
                    model: "original-model",
                    collaborationMode: "plan",
                    reasoningEffort: "high",
                    rootTurnId: "turn",
                  },
                ],
                items: items.map((item) => ({
                  itemId: item.id,
                  state: "completed",
                  startedAtMs: null,
                  completedAtMs: null,
                })),
                usage: null,
                warnings: [],
                errors: [],
              },
            ],
          },
        },
        threadId,
      ),
    };
    await saved.append(snap);
    expect(await saved.head()).toMatchObject({ sequence: 129 });
    const files = new AttachmentStore(directory);
    const create: ConstructorParameters<
      typeof ManagedNativeHistoryProjection
    >[0]["projector"] = async (binding, signal, source) =>
      createNativeHistoryProjectorAdapters({
        binding,
        source,
        signal,
        service: service as unknown as WorkerEncryptionService,
        directory: path.join(directory, "adapters"),
        attachments: files,
      });
    const projection = pump(create);
    const scope = {
      chatId: f.chatId,
      threadId,
      bindingId: saved.scope.bindingId,
    };
    projection.wake(saved, scope);
    await projection.flush();
    const rows = () =>
      f.repository.nativeHistoryBindings.withBinding(
        f.ownerId,
        f.workerId,
        f.chatId,
        scope.bindingId,
        async (tx) => ({
          messages: await tx.select().from(schema.chatMessages),
          items: await tx.select().from(schema.nativeHistoryItems),
          commands: await tx.select().from(schema.nativeCommands),
          receipts: await tx.select().from(schema.nativeHistoryReceipts),
        }),
      );
    const first = await rows();
    expect(first.messages).toHaveLength(2);
    expect(first.messages.every((message) => message.mode === "plan")).toBe(
      true,
    );
    expect(first.commands).toEqual([]);
    expect(first.receipts).toHaveLength(2);
    const archive = await client.archive({
      chatId: f.chatId,
      bindingId: scope.bindingId,
    });
    const descriptor = archive.items.find(
      (item) => item.identity.component === "user",
    )!.attachments[0]!;
    const attachment = await openWorkerAttachment(
      descriptor,
      service as unknown as WorkerEncryptionService,
    );
    expect(
      await readFile(
        files.resolve(f.chatId, attachment.id, attachment.fileName),
      ),
    ).toEqual(bytes);
    const answer = first.messages.find(
      (message) => message.role === "assistant",
    )!;
    const opened = await decryptChatMessageProtectedContent({
      ownerId: f.ownerId,
      messageId: answer.id,
      componentKey: new Uint8Array(32).fill(47),
      keyRevision: 1,
      encrypted: answer.protectedContent!,
      publicClassification: {
        role: answer.role,
        mode: answer.mode,
        attachmentIds: answer.attachmentIds,
      },
    });
    expect(opened.content).toMatchObject([
      { type: "text", text: "original plan answer" },
    ]);
    await projection.close();
    await rm(path.join(originalCwd, "note.png"));
    await saved.append({ ...snap, id: randomUUID() });
    const replacement = pump(create, directory);
    await replacement.flush();
    expect((await rows()).messages.map((message) => message.id).sort()).toEqual(
      first.messages.map((message) => message.id).sort(),
    );
    expect(
      (
        await client.archive({ chatId: f.chatId, bindingId: scope.bindingId })
      ).items.find((item) => item.identity.component === "user")!.attachments,
    ).toEqual([descriptor]);
    expect(errors).not.toHaveBeenCalled();
  }, 30_000);

  it("recovers unopened journals without native observation and retries a damaged sibling without duplicating healthy work", async () => {
    await f.bindThread(threadId);
    const saved = await journal();
    await saved.append({
      kind: "notification",
      threadId,
      generation,
      sequence: 1,
      receivedAtMs: 1,
      method: "item/completed",
      params: {
        threadId,
        turnId: "turn",
        item: {
          type: "agentMessage",
          id: "recovered",
          text: "durable startup answer",
        },
      },
    });
    const damaged = path.join(directory, "f".repeat(64));
    await mkdir(damaged);
    await writeFile(
      path.join(damaged, "source.json"),
      "damaged fixture manifest",
    );
    const create = vi.fn(adapters);
    const projection = pump(create, directory);
    const rows = () =>
      f.repository.nativeHistoryBindings.withBinding(
        f.ownerId,
        f.workerId,
        f.chatId,
        saved.scope.bindingId,
        async (tx) => ({
          messages: await tx.select().from(schema.chatMessages),
          commands: await tx.select().from(schema.nativeCommands),
        }),
      );
    await expect
      .poll(async () => (await rows()).messages.length, { timeout: 5000 })
      .toBe(1);
    expect(
      errors.mock.calls.some(([, scope]) => scope.phase === "recovery"),
    ).toBe(true);
    expect(reads).not.toHaveBeenCalled();
    expect((await rows()).commands).toEqual([]);
    await rm(damaged, { recursive: true });
    await projection.close();
    expect(create).toHaveBeenCalledTimes(1);
    expect((await rows()).messages).toHaveLength(1);
  });

  it("awaits an in-flight startup scan before finishing worker shutdown", async () => {
    await f.bindThread(threadId);
    await journal();
    let arrived!: () => void;
    const entered = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actualRecover = NativeHistorySourceJournal.recover;
    vi.spyOn(NativeHistorySourceJournal, "recover").mockImplementationOnce(
      async function* (input) {
        arrived();
        await held;
        yield* actualRecover(input);
      },
    );
    const projection = pump(adapters, directory);
    await entered;
    const flush = projection.flush();
    const rejection = expect(flush).rejects.toThrow("stopped");
    let stopped = false;
    const stop = projection.stop().then(() => {
      stopped = true;
    });
    try {
      await rejection;
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
    } finally {
      release();
      await stop;
    }
    expect(stopped).toBe(true);
    expect(errors).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
  });

  it("projects persisted observations after native retirement and retries a lost commit acknowledgment without input", async () => {
    await f.bindThread(threadId);
    const create = vi
      .fn(adapters)
      .mockRejectedValueOnce(
        new Error("context store temporarily unavailable"),
      );
    const projection = pump(create);
    connectProjection(projection);
    const actualDeliver = client.deliver.bind(client);
    const deliver = vi
      .spyOn(client, "deliver")
      .mockImplementationOnce(async (...args) => {
        await actualDeliver(...args);
        throw new Error("lost canonical acknowledgment");
      })
      .mockImplementation(actualDeliver);
    bind();
    event("first");
    event("second");
    await sources.close();
    const readsBeforeRetry = reads.mock.calls.length;
    await projection.flush();
    expect(create).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(errors.mock.calls.map(([error]) => error.message)).toEqual(
      expect.arrayContaining([
        "context store temporarily unavailable",
        "lost canonical acknowledgment",
      ]),
    );
    const saved = await journal();
    const scope = {
      chatId: f.chatId,
      threadId,
      bindingId: saved.scope.bindingId,
    };
    const result = await f.repository.nativeHistoryBindings.withBinding(
      f.ownerId,
      f.workerId,
      f.chatId,
      scope.bindingId,
      async (tx) => ({
        messages: await tx.select().from(schema.chatMessages),
        items: await tx.select().from(schema.nativeHistoryItems),
        commands: await tx.select().from(schema.nativeCommands),
        receipts: await tx.select().from(schema.nativeHistoryReceipts),
      }),
    );
    expect(result.messages).toHaveLength(2);
    expect(result.items.every((item) => item.revision === 1)).toBe(true);
    expect(result.commands).toEqual([]);
    expect(
      new Set(result.receipts.map((receipt) => receipt.recordId)).size,
    ).toBe(result.receipts.length);
    expect(reads).toHaveBeenCalledTimes(readsBeforeRetry);
    projection.wake(saved, scope);
    projection.wake(await journal(), scope);
    await projection.flush();
    expect(create).toHaveBeenCalledTimes(2);
    const replacementSource = await NativeHistorySourceJournal.open({
      directory: path.join(directory, "replaced-source"),
      ...saved.scope,
      service,
    });
    expect(() => projection.wake(replacementSource, scope)).toThrow(
      "source identity changed",
    );
    expect(() =>
      projection.wake(saved, { ...scope, chatId: "wrong-chat" }),
    ).toThrow("another source binding");
    await projection.close();
    expect(() => projection.wake(saved, scope)).toThrow("closing");
  });

  it("aborts only projection transport at worker shutdown and replays the durable stage without a live runtime", async () => {
    await f.bindThread(threadId);
    const projection = pump();
    connectProjection(projection);
    let received!: () => void;
    const committed = new Promise<void>((resolve) => {
      received = resolve;
    });
    const actualDeliver = client.deliver.bind(client);
    let pendingSignal: AbortSignal | undefined;
    vi.spyOn(client, "deliver")
      .mockImplementationOnce(async (...args) => {
        await actualDeliver(...args);
        pendingSignal = args[3];
        received();
        return new Promise((_resolve, reject) => {
          if (pendingSignal!.aborted) reject(pendingSignal!.reason);
          else
            pendingSignal!.addEventListener(
              "abort",
              () => reject(pendingSignal!.reason),
              { once: true },
            );
        });
      })
      .mockImplementation(actualDeliver);
    bind();
    event("survives-worker-stop");
    await sources.close();
    await committed;
    const before = await counts();
    const flush = expect(projection.flush()).rejects.toThrow(
      "stopped before confirming",
    );
    await projection.stop();
    await flush;
    expect(pendingSignal?.aborted).toBe(true);
    const saved = await journal();
    const recovered = pump();
    recovered.wake(saved, {
      chatId: f.chatId,
      threadId,
      bindingId: saved.scope.bindingId,
    });
    await recovered.flush();
    const result = await f.repository.nativeHistoryBindings.withBinding(
      f.ownerId,
      f.workerId,
      f.chatId,
      saved.scope.bindingId,
      async (tx) => ({
        messages: await tx.select().from(schema.chatMessages),
        commands: await tx.select().from(schema.nativeCommands),
        receipts: await tx.select().from(schema.nativeHistoryReceipts),
      }),
    );
    expect(result.messages).toHaveLength(1);
    expect(result.commands).toEqual([]);
    expect(result.receipts.length).toBeGreaterThanOrEqual(before.receipts);
    const sent = vi.mocked(client.deliver).mock.calls;
    expect(sent[1]![1]).toEqual(sent[0]![1]);
    expect(sent[1]![2]).toBe(sent[0]![2]);
    await recovered.close();
  });

  it("subscribes immediately, retries the actual unbound response and reuses one capture across views", async () => {
    const capture = bind();
    event("before-canonical-binding");
    expect(bind()).toBe(capture);
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect(errors.mock.calls[0]![0]).toMatchObject({
      code: "thread-not-bound",
    });
    expect(capture.pendingRecords).toBeGreaterThan(0);
    await f.bindThread(threadId);
    await sources.flush();
    const saved = await (await journal()).read();
    expect(
      saved.filter(({ frame }) => frame.kind === "notification"),
    ).toHaveLength(1);
    expect(
      saved.some(
        ({ frame }) =>
          frame.kind === "notification" &&
          frame.params.item &&
          (frame.params.item as any).id === "before-canonical-binding",
      ),
    ).toBe(true);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(await counts()).toEqual({ commands: 0, receipts: 0, bindings: 1 });
    await sources.close();
    expect(capture.signal.aborted).toBe(true);
  });

  it("drains a retired transport after disk repair and keeps replacement events in the same journal", async () => {
    await f.bindThread(threadId);
    const oldCapture = bind();
    await sources.flush();
    const oldJournal = await journal();
    const obstruction = path.join(
      oldJournal.directory,
      "0000000000000002.source.json",
    );
    await mkdir(obstruction);
    event("old-tail");
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    generation = "transport-2";
    observations.replace(generation);
    const replacement = bind();
    expect(replacement).not.toBe(oldCapture);
    expect(oldCapture.signal.aborted).toBe(true);
    event("new-tail");
    await rm(obstruction, { recursive: true });
    await sources.flush();
    const saved = (await (await journal()).read()).filter(
      ({ frame }) => frame.kind === "notification",
    );
    expect(
      saved
        .map(({ frame }) => [frame.generation, (frame as any).params.item.id])
        .sort(),
    ).toEqual([
      ["transport-1", "old-tail"],
      ["transport-2", "new-tail"],
    ]);
    expect((await counts()).bindings).toBe(1);
    expect(replacement.pendingRecords).toBe(0);
    expect(bind()).toBe(replacement);
  });

  it("a retired source retains historical ownership after the current native thread changes", async () => {
    await f.bindThread(threadId);
    bind();
    await sources.flush();
    const first = await journal();
    await f.bindThread(randomUUID());
    generation = "transport-2";
    observations.replace(generation);
    bind();
    event("historical-tail");
    await sources.close();
    const saved = await first.read();
    expect(
      saved.some(
        ({ frame }) =>
          frame.kind === "notification" &&
          (frame.params.item as any).id === "historical-tail",
      ),
    ).toBe(true);
    expect(() => bind()).toThrow("stopped");
  });

  it("final teardown aborts a held binding request and reports unsaved frames without claiming consumption", async () => {
    let requestSignal: AbortSignal | undefined;
    const held = new Promise<never>((_resolve, reject) => {
      vi.spyOn(client, "open").mockImplementation(async (_input, signal) => {
        requestSignal = signal;
        signal!.addEventListener("abort", () => reject(signal!.reason), {
          once: true,
        });
        return held;
      });
    });
    const capture = bind();
    event("not-yet-saved");
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    const closing = sources.close();
    const rejectedClose = expect(closing).rejects.toThrow("stopped");
    const pending = sources.stop();
    expect(pending).toEqual([
      { chatId: f.chatId, threadId, pendingRecords: capture.pendingRecords },
    ]);
    expect(pending[0]!.pendingRecords).toBeGreaterThan(0);
    expect(requestSignal!.aborted).toBe(true);
    await expect(capture.flush()).rejects.toThrow("stopped");
    await rejectedClose;
    expect(f.phases).toHaveLength(0);
    expect(f.receipts.size).toBe(0);
    expect(await readdir(directory)).toEqual([]);
  });

  it("retries a timed-out binding attempt without retiring the native observation", async () => {
    await f.bindThread(threadId);
    sources.stop();
    const actualOpen = client.open.bind(client);
    const open = vi.spyOn(client, "open");
    open
      .mockImplementationOnce(
        (_input, signal) =>
          new Promise((_resolve, reject) => {
            signal!.addEventListener("abort", () => reject(signal!.reason), {
              once: true,
            });
          }),
      )
      .mockImplementation(actualOpen);
    sources = new ManagedNativeHistorySources({
      directory,
      workerId: f.workerId,
      client,
      service,
      bindingTimeoutMs: 40,
      retryDelayMs: 10,
      maxRetryDelayMs: 20,
      snapshotDelayMs: 0,
      onError: errors,
    });
    const capture = bind();
    event("during-timeout");
    await sources.flush();
    expect(
      errors.mock.calls.some(([error]) => error.name === "TimeoutError"),
    ).toBe(true);
    expect(open.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(capture.signal.aborted).toBe(false);
    expect(
      (await (await journal()).read()).filter(
        ({ frame }) => frame.kind === "notification",
      ),
    ).toHaveLength(1);
    expect(reads).toHaveBeenCalledTimes(1);
  });
});
