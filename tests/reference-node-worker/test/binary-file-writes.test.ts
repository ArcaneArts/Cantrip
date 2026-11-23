import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  symlink,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  BinaryFileWrites,
  type BinaryWriteContext,
} from "../src/binary-file-writes.js";
import { BinaryWriteStorage } from "../src/binary-write-storage.js";
import { readExplorerBinaryFile } from "../src/explorer.js";
import {
  BINARY_WRITE_CHUNK_BYTES,
  type BinaryWriteRequest,
} from "@cantrip/protocol/surface-stream";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-binary-write-test-"),
    ),
    root = path.join(directory, "project"),
    data = path.join(directory, "worker"),
    key = new Uint8Array(randomBytes(32));
  await mkdir(root);
  await writeFile(path.join(root, "file.nbt"), "original bytes");
  const keys = {
      ownerId: () => "owner",
      componentKey: () => ({ key: key.slice(), keyRevision: 1 }),
    },
    create = () => new BinaryFileWrites(data, keys),
    writer = create(),
    context: BinaryWriteContext = {
      serverId: "server",
      surfaceKind: "file-document",
      surfaceId: "document",
      root,
    };
  cleanups.push(async () => {
    await writer.dispose();
    key.fill(0);
    await rm(directory, { recursive: true, force: true });
  });
  const send = (request: BinaryWriteRequest, target = writer) =>
    target.execute(context, request);
  return { directory, root, data, writer, context, send, create };
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function version(root: string, name = "file.nbt") {
  return (await readExplorerBinaryFile(root, name, 0, 1)).version;
}
async function upload(
  f: Awaited<ReturnType<typeof fixture>>,
  bytes: Buffer,
  name = "file.nbt",
  expected: string | null | undefined = undefined,
  id = randomUUID(),
) {
  const before =
    expected === undefined ? await version(f.root, name) : expected;
  await f.send({
    type: "explorer.binary.write.begin",
    path: name,
    uploadId: id,
    version: before,
  });
  for (
    let at = 0;
    at < bytes.length || at === 0;
    at += BINARY_WRITE_CHUNK_BYTES
  ) {
    const part = bytes.subarray(at, at + BINARY_WRITE_CHUNK_BYTES);
    await f.send({
      type: "explorer.binary.write.chunk",
      path: name,
      uploadId: id,
      offset: at,
      data: part.toString("base64"),
      final: at + part.length === bytes.length,
    });
    if (at + part.length === bytes.length) break;
  }
  return {
    id,
    sha: digest(bytes),
    commit: () =>
      f.send({
        type: "explorer.binary.write.commit",
        path: name,
        uploadId: id,
        size: bytes.length,
        sha256: digest(bytes),
      }),
  };
}
it("publishes verified staged bytes atomically and retains an encrypted durable receipt across worker recreation", async () => {
  const f = await fixture(),
    bytes = Buffer.from("NBT_PRIVATE_VALUE ".repeat(40000)),
    transfer = await upload(f, bytes);
  expect(await readFile(path.join(f.root, "file.nbt"), "utf8")).toBe(
    "original bytes",
  );
  const stored = await readdir(path.join(f.data, "binary-file-writes"));
  for (const name of stored) {
    const content = await readFile(
      path.join(f.data, "binary-file-writes", name),
    );
    expect(content.includes(Buffer.from("NBT_PRIVATE_VALUE"))).toBe(false);
    expect(content.includes(Buffer.from(f.root))).toBe(false);
  }
  const receipt = await transfer.commit();
  expect(receipt).toMatchObject({
    state: "committed",
    size: bytes.length,
    sha256: transfer.sha,
    version: "binary-sha256:" + transfer.sha,
  });
  expect(await readFile(path.join(f.root, "file.nbt"))).toEqual(bytes);
  const restarted = f.create();
  try {
    expect(
      await f.send(
        {
          type: "explorer.binary.write.status",
          path: "file.nbt",
          uploadId: transfer.id,
        },
        restarted,
      ),
    ).toEqual(receipt);
  } finally {
    await restarted.dispose();
  }
  expect(
    (await readdir(f.root)).filter((name) =>
      name.startsWith(".cantrip-publish-"),
    ),
  ).toEqual([]);
});
it("retries a chunk idempotently, rejects changed retry data, and resumes an upload after recreation", async () => {
  const f = await fixture(),
    id = randomUUID(),
    part = Buffer.alloc(BINARY_WRITE_CHUNK_BYTES, 42),
    request = {
      type: "explorer.binary.write.chunk" as const,
      path: "file.nbt",
      uploadId: id,
      offset: 0,
      data: part.toString("base64"),
      final: false,
    };
  await f.send({
    type: "explorer.binary.write.begin",
    path: "file.nbt",
    uploadId: id,
    version: await version(f.root),
  });
  const first = await f.send(request);
  expect(await f.send(request)).toEqual(first);
  await expect(
    f.send({
      ...request,
      data: Buffer.alloc(part.length, 43).toString("base64"),
    }),
  ).rejects.toThrow("different content");
  const next = f.create();
  try {
    expect(
      await f.send(
        {
          type: "explorer.binary.write.status",
          path: "file.nbt",
          uploadId: id,
        },
        next,
      ),
    ).toMatchObject({ state: "uploading", offset: part.length });
    const last = Buffer.from("tail");
    await f.send(
      {
        type: "explorer.binary.write.chunk",
        path: "file.nbt",
        uploadId: id,
        offset: part.length,
        data: last.toString("base64"),
        final: true,
      },
      next,
    );
    const bytes = Buffer.concat([part, last]);
    await f.send(
      {
        type: "explorer.binary.write.commit",
        path: "file.nbt",
        uploadId: id,
        size: bytes.length,
        sha256: digest(bytes),
      },
      next,
    );
    expect(await readFile(path.join(f.root, "file.nbt"))).toEqual(bytes);
  } finally {
    await next.dispose();
  }
});
it("retains the original when checksum verification or encrypted staging authentication fails", async () => {
  const f = await fixture(),
    bytes = Buffer.from("new value"),
    transfer = await upload(f, bytes);
  await expect(
    f.send({
      type: "explorer.binary.write.commit",
      path: "file.nbt",
      uploadId: transfer.id,
      size: bytes.length,
      sha256: "0".repeat(64),
    }),
  ).rejects.toThrow("checksum");
  expect(await readFile(path.join(f.root, "file.nbt"), "utf8")).toBe(
    "original bytes",
  );
  const stage = (await readdir(path.join(f.data, "binary-file-writes"))).find(
      (name) => name.endsWith(".stage"),
    )!,
    filename = path.join(f.data, "binary-file-writes", stage),
    content = await readFile(filename);
  content[content.length - 1]! ^= 1;
  await writeFile(filename, content);
  await expect(transfer.commit()).rejects.toThrow();
  expect(await readFile(path.join(f.root, "file.nbt"), "utf8")).toBe(
    "original bytes",
  );
});
it("returns a version conflict and keeps external changes intact", async () => {
  const f = await fixture(),
    transfer = await upload(f, Buffer.from("our bytes"));
  await writeFile(path.join(f.root, "file.nbt"), "external bytes");
  expect(await transfer.commit()).toMatchObject({ state: "conflict" });
  expect(await readFile(path.join(f.root, "file.nbt"), "utf8")).toBe(
    "external bytes",
  );
});
it("lets only one of two saves against the same version replace the target", async () => {
  const f = await fixture(),
    expected = await version(f.root),
    one = await upload(f, Buffer.from("first"), "file.nbt", expected),
    two = await upload(f, Buffer.from("second"), "file.nbt", expected),
    results = await Promise.all([one.commit(), two.commit()]);
  expect(results.map((result) => result.state).sort()).toEqual([
    "committed",
    "conflict",
  ]);
  expect(await readFile(path.join(f.root, "file.nbt"), "utf8")).toBe(
    results[0]!.state === "committed" ? "first" : "second",
  );
});
it("reconciles a publication whose committed acknowledgement could not be stored", async () => {
  const f = await fixture(),
    bytes = Buffer.from("committed without reply"),
    transfer = await upload(f, bytes),
    write = BinaryWriteStorage.prototype.write;
  vi.spyOn(BinaryWriteStorage.prototype, "write").mockImplementation(
    async function (key, value) {
      if ((value as { state?: string }).state === "committed")
        throw new Error("Injected receipt storage failure");
      return write.call(this, key, value);
    },
  );
  await expect(transfer.commit()).rejects.toThrow("receipt storage");
  expect(await readFile(path.join(f.root, "file.nbt"))).toEqual(bytes);
  const restarted = f.create();
  try {
    const receipt = await f.send(
      {
        type: "explorer.binary.write.status",
        path: "file.nbt",
        uploadId: transfer.id,
      },
      restarted,
    );
    expect(receipt).toMatchObject({
      state: "committed",
      version: "binary-sha256:" + digest(bytes),
    });
  } finally {
    await restarted.dispose();
  }
});
it("supports Save As without overwriting a concurrently created destination and accepts content-bound versions for later saves", async () => {
  const f = await fixture(),
    one = await upload(f, Buffer.from("first"), "new.nbt", null);
  expect(await one.commit()).toMatchObject({ state: "committed" });
  const next = await upload(
    f,
    Buffer.from("second"),
    "new.nbt",
    "binary-sha256:" + digest(Buffer.from("first")),
  );
  expect(await next.commit()).toMatchObject({ state: "committed" });
  const other = await upload(f, Buffer.from("ours"), "raced.nbt", null);
  await writeFile(path.join(f.root, "raced.nbt"), "theirs");
  expect(await other.commit()).toMatchObject({ state: "conflict" });
  expect(await readFile(path.join(f.root, "raced.nbt"), "utf8")).toBe("theirs");
});
it("supports empty final pages and explicit cancellation without changing the source", async () => {
  const f = await fixture(),
    empty = await upload(f, Buffer.alloc(0), "empty.nbt", null);
  expect(await empty.commit()).toMatchObject({ state: "committed", size: 0 });
  const transfer = await upload(f, Buffer.from("cancelled"));
  expect(
    await f.send({
      type: "explorer.binary.write.abort",
      path: "file.nbt",
      uploadId: transfer.id,
    }),
  ).toMatchObject({ state: "aborted" });
  expect(await readFile(path.join(f.root, "file.nbt"), "utf8")).toBe(
    "original bytes",
  );
});
it("binds receipts to their account/document/path context", async () => {
  const f = await fixture(),
    transfer = await upload(f, Buffer.from("new"));
  expect(
    await f.writer.execute(
      { ...f.context, surfaceId: "other" },
      {
        type: "explorer.binary.write.status",
        path: "file.nbt",
        uploadId: transfer.id,
      },
    ),
  ).toMatchObject({ state: "unknown" });
  expect(
    await f.send({
      type: "explorer.binary.write.status",
      path: "other.nbt",
      uploadId: transfer.id,
    }),
  ).toMatchObject({ state: "unknown" });
});
it("durably cancels an upload before begin arrives and refuses to resurrect it", async () => {
  const f = await fixture(),
    uploadId = randomUUID();
  expect(
    await f.send({
      type: "explorer.binary.write.abort",
      path: "file.nbt",
      uploadId,
    }),
  ).toMatchObject({ state: "aborted" });
  expect(
    await f.send({
      type: "explorer.binary.write.status",
      path: "file.nbt",
      uploadId,
    }),
  ).toMatchObject({ state: "aborted" });
  expect(
    await f.send({
      type: "explorer.binary.write.begin",
      path: "file.nbt",
      uploadId,
      version: "binary-sha256:" + digest(Buffer.from("original bytes")),
    }),
  ).toMatchObject({ state: "aborted" });
  await expect(
    f.send({
      type: "explorer.binary.write.chunk",
      path: "file.nbt",
      uploadId,
      offset: 0,
      data: Buffer.from("late").toString("base64"),
      final: true,
    }),
  ).rejects.toThrow("no longer accepts");
  expect(
    await f.send({
      type: "explorer.binary.write.abort",
      path: "file.nbt",
      uploadId,
    }),
  ).toMatchObject({ state: "aborted" });
  expect(await readFile(path.join(f.root, "file.nbt"), "utf8")).toBe(
    "original bytes",
  );
});
it("preserves intentional file symlinks while atomically replacing their targets", async (context) => {
  const f = await fixture(),
    outside = path.join(f.directory, "outside.nbt");
  await writeFile(outside, "shared file");
  try {
    await symlink(outside, path.join(f.root, "link.nbt"));
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
    ) {
      context.skip();
      return;
    }
    throw error;
  }
  const transfer = await upload(
    f,
    Buffer.from("updated shared file"),
    "link.nbt",
  );
  expect(await transfer.commit()).toMatchObject({ state: "committed" });
  expect((await lstat(path.join(f.root, "link.nbt"))).isSymbolicLink()).toBe(
    true,
  );
  expect(await readFile(outside, "utf8")).toBe("updated shared file");
});
it("does not report a missing publication temporary as a committed save without matching target bytes", async () => {
  const f = await fixture(),
    transfer = await upload(f, Buffer.from("replaced bytes")),
    write = BinaryWriteStorage.prototype.write;
  vi.spyOn(BinaryWriteStorage.prototype, "write").mockImplementation(
    async function (key, value) {
      await write.call(this, key, value);
      const record = value as { state: string; publication: string };
      if (record.state === "prepared") {
        await rm(record.publication, { force: true });
        throw new Error("Simulated crash before publish");
      }
    },
  );
  await expect(transfer.commit()).rejects.toThrow("before publish");
  vi.restoreAllMocks();
  const restarted = f.create();
  try {
    const receipt = await f.send(
      {
        type: "explorer.binary.write.status",
        path: "file.nbt",
        uploadId: transfer.id,
      },
      restarted,
    );
    expect(receipt.state).toBe("conflict");
    expect(receipt.version).toBeNull();
    expect(await readFile(path.join(f.root, "file.nbt"), "utf8")).toBe(
      "original bytes",
    );
  } finally {
    await restarted.dispose();
  }
});
