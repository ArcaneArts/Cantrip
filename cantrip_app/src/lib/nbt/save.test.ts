import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { JAVA_NBT, NbtTag, encodeNbtPayload } from "@cantrip/nbt";
import {
  NbtDocumentClient,
  installNbtDocumentWorker,
  type NbtDocumentRequest,
  type NbtDocumentResponse,
  type NbtMessageEndpoint,
} from "@cantrip/nbt/document";
import type { BinaryWriteRequest } from "@cantrip/protocol/surface-stream";
import { BinaryFileWrites } from "../../../../cantrip_worker/src/binary-file-writes";
import { readExplorerBinaryFile } from "../../../../cantrip_worker/src/explorer";
import { openProtectedBinarySource } from "@/lib/binary-file-source";
import { NbtSaveController } from "./save";
import { NbtViewSession } from "./session-registry";
function pair() {
  const main = new Set<(event: MessageEvent<NbtDocumentResponse>) => void>(),
    worker = new Set<(event: MessageEvent<NbtDocumentRequest>) => void>();
  function end<In, Out>(
    own: Set<(event: MessageEvent<In>) => void>,
    other: Set<(event: MessageEvent<Out>) => void>,
  ): NbtMessageEndpoint<In, Out> {
    return {
      postMessage(message, transfer) {
        const copy = structuredClone(message, { transfer });
        queueMicrotask(() => {
          for (const listener of other)
            listener({ data: copy } as MessageEvent<Out>);
        });
      },
      addEventListener(_type, listener) {
        own.add(listener);
      },
      removeEventListener(_type, listener) {
        own.delete(listener);
      },
    };
  }
  return { main: end(main, worker), worker: end(worker, main) };
}
async function fixture(durable = false) {
  const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-nbt-save-client-"),
    ),
    filename = path.join(directory, "file.nbt"),
    parts = [];
  for await (const part of encodeNbtPayload(
    {
      name: "",
      tag: {
        type: NbtTag.Compound,
        value: [
          {
            name: "array",
            tag: {
              type: NbtTag.ByteArray,
              length: 2 * 256 * 1024 + 1234,
              value: new Uint8Array(2 * 256 * 1024 + 1234).fill(42),
            },
          },
          { name: "long", tag: { type: NbtTag.Long, value: 1n } },
        ],
      },
    },
    JAVA_NBT,
  ))
    parts.push(part);
  const original = Buffer.concat(parts);
  await writeFile(filename, original);
  const recovery = durable
    ? {
        id: randomUUID(),
        key: await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      }
    : undefined;
  const source = await openProtectedBinarySource(
    "file.nbt",
    (offset, limit, version) =>
      readExplorerBinaryFile(directory, "file.nbt", offset, limit, version),
  );
  let endpoints = pair(),
    dispose = installNbtDocumentWorker(endpoints.worker),
    client = await NbtDocumentClient.open(endpoints.main, source, {
      binding: randomUUID(),
      version: source.version,
      format: JAVA_NBT,
      recovery,
    });
  const until = Date.now() + 5000;
  while (client.getSnapshot()?.state !== "complete") {
    if (Date.now() > until) throw new Error("Document startup timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const root = client.getSnapshot()!.root!,
    long = (await client.rows(root)).find((row) => row.name === "long")!.node
      .id;
  await client.edit([{ type: "value", id: long, value: "9007199254740993" }]);
  const backend = new BinaryFileWrites(path.join(directory, "worker"), {
      ownerId: () => "owner",
      componentKey: () => ({
        key: new Uint8Array(32).fill(17),
        keyRevision: 1,
      }),
    }),
    context = {
      serverId: "server",
      surfaceKind: "file-document" as const,
      surfaceId: "document",
      root: directory,
    };
  return {
    get client() {
      return client;
    },
    long,
    original,
    filename,
    backend,
    context,
    async reopen() {
      await client.close();
      await dispose();
      endpoints = pair();
      dispose = installNbtDocumentWorker(endpoints.worker);
      client = await NbtDocumentClient.open(endpoints.main, null, {
        binding: randomUUID(),
        version: source.version,
        format: JAVA_NBT,
        recovery,
      });
    },
    async close() {
      await client.close();
      await dispose();
      await backend.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
it("resumes a frozen upload after a chunk acknowledgement is lost and commits the matching bytes", async () => {
  const f = await fixture();
  let dropped = false;
  const requests: BinaryWriteRequest[] = [],
    transport = async (request: BinaryWriteRequest) => {
      requests.push(request);
      const result = await f.backend.execute(f.context, request);
      if (request.type === "explorer.binary.write.chunk" && !dropped) {
        dropped = true;
        throw new Error("Disconnected after chunk acknowledgement");
      }
      return result;
    },
    controller = new NbtSaveController(f.client, "file.nbt", transport);
  try {
    await expect(controller.save()).rejects.toThrow("Disconnected");
    expect(await readFile(f.filename)).toEqual(f.original);
    expect(f.client.getEditSnapshot()).toMatchObject({
      dirty: true,
      saving: false,
      uncertain: false,
    });
    expect(f.client.getEditSnapshot()?.pendingSaveId).toBeTruthy();
    const receipt = await controller.save(),
      bytes = await readFile(f.filename);
    expect(receipt).toMatchObject({
      state: "committed",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(f.client.getEditSnapshot()).toMatchObject({
      dirty: false,
      saving: false,
      uncertain: false,
    });
    const chunks = requests.filter(
      (request) => request.type === "explorer.binary.write.chunk",
    );
    expect(chunks.map((request) => request.offset)).toEqual([
      0,
      256 * 1024,
      512 * 1024,
    ]);
    expect(new Set(requests.map((request) => request.uploadId)).size).toBe(1);
  } finally {
    await f.close();
  }
}, 30_000);
it("reconciles a lost commit response instead of failing a successfully saved document", async () => {
  const f = await fixture();
  let dropped = false;
  const transport = async (request: BinaryWriteRequest) => {
      const result = await f.backend.execute(f.context, request);
      if (request.type === "explorer.binary.write.commit" && !dropped) {
        dropped = true;
        throw new Error("Commit reply lost");
      }
      return result;
    },
    controller = new NbtSaveController(f.client, "file.nbt", transport);
  try {
    expect(await controller.save()).toMatchObject({ state: "committed" });
    expect(f.client.getEditSnapshot()?.dirty).toBe(false);
  } finally {
    await f.close();
  }
}, 30_000);
it("keeps a committed but unacknowledged snapshot retryable until the receipt becomes reachable", async () => {
  const f = await fixture();
  let disconnected = false,
    reconnected = false;
  const serialize = vi.spyOn(f.client, "serialize"),
    transport = async (request: BinaryWriteRequest) => {
      if (disconnected && !reconnected) throw new Error("Offline");
      const result = await f.backend.execute(f.context, request);
      if (request.type === "explorer.binary.write.commit") {
        disconnected = true;
        throw new Error("Offline");
      }
      return result;
    },
    controller = new NbtSaveController(f.client, "file.nbt", transport);
  try {
    await expect(controller.save()).rejects.toThrow("Offline");
    expect(f.client.getEditSnapshot()).toMatchObject({
      dirty: true,
      uncertain: true,
      saving: false,
    });
    expect(await readFile(f.filename)).not.toEqual(f.original);
    reconnected = true;
    expect(await controller.save()).toMatchObject({ state: "committed" });
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(f.client.getEditSnapshot()).toMatchObject({
      dirty: false,
      uncertain: false,
    });
  } finally {
    await f.close();
  }
}, 30_000);
it("leaves edits made during a save dirty after its frozen snapshot is acknowledged", async () => {
  const f = await fixture(),
    transport = async (request: BinaryWriteRequest) => {
      if (request.type === "explorer.binary.write.commit")
        await f.client.edit([{ type: "value", id: f.long, value: "7" }]);
      return f.backend.execute(f.context, request);
    },
    controller = new NbtSaveController(f.client, "file.nbt", transport);
  try {
    await controller.save();
    expect(f.client.getEditSnapshot()?.dirty).toBe(true);
    expect((await f.client.describe(f.long)).value).toBe(7n);
    await f.client.undo();
    expect(f.client.getEditSnapshot()?.dirty).toBe(false);
  } finally {
    await f.close();
  }
}, 30_000);
it("Save As creates a new file, reconciles a lost reply, and retains the original draft/version", async () => {
  const f = await fixture(),
    version = f.client.getEditSnapshot()!.version;
  const original = await readFile(f.filename);
  const session = new NbtViewSession(f.client);
  let dropped = false;
  try {
    await f.client.edit([
      { type: "value", id: f.long, value: "987654321012345678" },
    ]);
    await session.saveAs("copy.nbt", async (request) => {
      const receipt = await f.backend.execute(f.context, request);
      if (request.type === "explorer.binary.write.commit" && !dropped) {
        dropped = true;
        throw new Error("lost copy acknowledgement");
      }
      return receipt;
    });
    expect(dropped).toBe(true);
    expect(f.client.getEditSnapshot()).toMatchObject({
      dirty: true,
      version,
      pendingSaveId: undefined,
    });
    expect(await readFile(f.filename)).toEqual(original);
    expect(
      (await readFile(path.join(path.dirname(f.filename), "copy.nbt"))).length,
    ).toBe(original.length);
    await expect(
      session.saveAs("copy.nbt", (request) =>
        f.backend.execute(f.context, request),
      ),
    ).rejects.toThrow();
    expect(f.client.getEditSnapshot()?.dirty).toBe(true);
  } finally {
    await f.close();
  }
}, 30_000);
it("resumes an interrupted Save As at its original destination without requiring an original-file transport", async () => {
  const f = await fixture(),
    session = new NbtViewSession(f.client);
  let dropped = false;
  try {
    await expect(
      session.saveAs("chosen-copy.nbt", async (request) => {
        const result = await f.backend.execute(f.context, request);
        if (request.type === "explorer.binary.write.chunk" && !dropped) {
          dropped = true;
          throw new Error("Lost copy chunk reply");
        }
        return result;
      }),
    ).rejects.toThrow("Lost copy chunk");
    expect(session.pendingCopyPath).toBe("chosen-copy.nbt");
    const receipt = await session.resumeCopy();
    expect(receipt.path).toBe("chosen-copy.nbt");
    expect(receipt.state).toBe("committed");
    expect(session.pendingCopyPath).toBeUndefined();
    expect(f.client.getEditSnapshot()).toMatchObject({
      dirty: true,
      pendingSaveId: undefined,
    });
    expect(await readFile(f.filename)).toEqual(f.original);
  } finally {
    await f.close();
  }
}, 30_000);
it("reconciles a committed save after the renderer reloads without serializing a new stream", async () => {
  const f = await fixture(true);
  let offline = false;
  const transport = async (request: BinaryWriteRequest) => {
    if (offline) throw new Error("Offline");
    const receipt = await f.backend.execute(f.context, request);
    if (request.type === "explorer.binary.write.commit") {
      offline = true;
      throw new Error("Offline");
    }
    return receipt;
  };
  try {
    const controller = new NbtSaveController(f.client, "file.nbt", transport);
    await expect(controller.save()).rejects.toThrow("Offline");
    const pending = f.client.getEditSnapshot()!.pendingSave!;
    expect(pending.metadata?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    await f.reopen();
    expect(f.client.getEditSnapshot()).toMatchObject({
      pendingSaveId: pending.id,
      uncertain: true,
      saving: false,
    });
    const serialize = vi.spyOn(f.client, "serialize"),
      restored = new NbtSaveController(f.client, "file.nbt", (request) =>
        f.backend.execute(f.context, request),
      );
    expect(await restored.save()).toMatchObject({
      state: "committed",
      uploadId: pending.id,
      sha256: pending.metadata!.sha256,
    });
    expect(serialize).not.toHaveBeenCalled();
    expect(f.client.getEditSnapshot()).toMatchObject({
      dirty: false,
      pendingSaveId: undefined,
      uncertain: false,
    });
  } finally {
    await f.close();
  }
}, 30_000);
it("cancels a partial compressed upload after reload before starting a fresh upload", async () => {
  const f = await fixture(true);
  let dropped = false;
  try {
    const controller = new NbtSaveController(
      f.client,
      "file.nbt",
      async (request) => {
        const receipt = await f.backend.execute(f.context, request);
        if (request.type === "explorer.binary.write.chunk" && !dropped) {
          dropped = true;
          throw new Error("Disconnected");
        }
        return receipt;
      },
    );
    await expect(controller.save()).rejects.toThrow("Disconnected");
    const pending = f.client.getEditSnapshot()!.pendingSave!;
    expect(pending.metadata).toBeUndefined();
    await f.reopen();
    const restored = new NbtSaveController(f.client, "file.nbt", (request) =>
      f.backend.execute(f.context, request),
    );
    const receipt = await restored.save();
    expect(receipt.state).toBe("committed");
    expect(receipt.uploadId).not.toBe(pending.id);
    expect(
      await f.backend.execute(f.context, {
        type: "explorer.binary.write.status",
        path: "file.nbt",
        uploadId: pending.id,
      }),
    ).toMatchObject({ state: "aborted" });
    expect(f.client.getEditSnapshot()?.dirty).toBe(false);
    expect((await f.client.describe(f.long)).value).toBe(9007199254740993n);
  } finally {
    await f.close();
  }
}, 30_000);
it("recovers the Save As destination and leaves the original dirty when its committed receipt is reconciled", async () => {
  const f = await fixture(true);
  let offline = false;
  try {
    const session = new NbtViewSession(f.client);
    await expect(
      session.saveAs("recovered-copy.nbt", async (request) => {
        if (offline) throw new Error("Offline");
        const receipt = await f.backend.execute(f.context, request);
        if (request.type === "explorer.binary.write.commit") {
          offline = true;
          throw new Error("Offline");
        }
        return receipt;
      }),
    ).rejects.toThrow("Offline");
    await f.reopen();
    const restored = new NbtViewSession(f.client);
    restored.setTransportResolver(async (path) => {
      expect(path).toBe("recovered-copy.nbt");
      return (request) => f.backend.execute(f.context, request);
    });
    expect(restored.pendingCopyPath).toBe("recovered-copy.nbt");
    expect(await restored.resumeCopy()).toMatchObject({
      state: "committed",
      path: "recovered-copy.nbt",
    });
    expect(restored.pendingCopyPath).toBeUndefined();
    expect(f.client.getEditSnapshot()).toMatchObject({
      dirty: true,
      uncertain: false,
      pendingSaveId: undefined,
    });
    expect(await readFile(f.filename)).toEqual(f.original);
  } finally {
    await f.close();
  }
}, 30_000);
it("retries after reload when the previous renderer never reached upload begin", async () => {
  const f = await fixture(true);
  try {
    const original = new NbtSaveController(f.client, "file.nbt", async () => {
      throw new Error("Offline before begin");
    });
    await expect(original.save()).rejects.toThrow("Offline before begin");
    const id = f.client.getEditSnapshot()!.pendingSaveId!;
    await f.reopen();
    const restored = new NbtSaveController(f.client, "file.nbt", (request) =>
      f.backend.execute(f.context, request),
    );
    expect(await restored.save()).toMatchObject({ state: "committed" });
    expect(
      await f.backend.execute(f.context, {
        type: "explorer.binary.write.status",
        path: "file.nbt",
        uploadId: id,
      }),
    ).toMatchObject({ state: "aborted" });
    expect(f.client.getEditSnapshot()?.dirty).toBe(false);
  } finally {
    await f.close();
  }
}, 30_000);
