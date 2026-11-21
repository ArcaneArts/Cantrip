import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  rename,
  link,
  rm,
  lstat,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  binaryWriteReceiptSchema,
  binaryWriteVersionSchema,
  BINARY_WRITE_CHUNK_BYTES,
  type BinaryWriteRequest,
  type BinaryWriteReceipt,
} from "@cantrip/protocol/surface-stream";
import { resolveBinaryWriteTarget } from "./explorer.js";
import { binaryFileVersion } from "./explorer-binary.js";
import {
  BinaryWriteStorage,
  syncBinaryDirectory,
  type BinaryWriteKeys,
} from "./binary-write-storage.js";
const recordSchema = z
  .object({
    formatVersion: z.literal(1),
    key: z.string().regex(/^[a-f0-9]{64}$/u),
    root: z.string(),
    path: z.string(),
    uploadId: z.string().uuid(),
    target: z.string(),
    publication: z.string(),
    publicationVersion: z.string().nullable(),
    expected: binaryWriteVersionSchema.nullable(),
    mode: z.number().int(),
    offset: z.number().int().nonnegative().safe(),
    frames: z.number().int().nonnegative().safe(),
    final: z.boolean(),
    state: z.enum([
      "uploading",
      "prepared",
      "committed",
      "conflict",
      "aborted",
    ]),
    size: z.number().int().nonnegative().safe().nullable(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    error: z.string().nullable(),
  })
  .strict();
type RecordState = z.infer<typeof recordSchema>;
export interface BinaryWriteContext {
  serverId: string;
  surfaceKind: "explorer" | "file-document";
  surfaceId: string;
  root: string;
}
export class BinaryWriteConflictError extends Error {
  constructor() {
    super(
      "This file changed on disk. Keep the draft and reload or save it to another path.",
    );
  }
}
const queues = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, run: () => Promise<T>) {
  const pending = (queues.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(run);
  queues.set(key, pending);
  try {
    return await pending;
  } finally {
    if (queues.get(key) === pending) queues.delete(key);
  }
}
/** Version-checked atomic publication. Upload bytes and receipts remain encrypted on worker storage. */
export class BinaryFileWrites {
  private storage: BinaryWriteStorage;
  private closing = false;
  private operations = new Set<Promise<unknown>>();
  constructor(
    dataDirectory: string,
    private service: BinaryWriteKeys,
  ) {
    this.storage = new BinaryWriteStorage(dataDirectory, service);
  }
  async execute(
    context: BinaryWriteContext,
    request: BinaryWriteRequest,
  ): Promise<BinaryWriteReceipt> {
    if (this.closing) throw new Error("The worker is shutting down.");
    const key = this.storage.key(
      JSON.stringify([
        context.serverId,
        this.service.ownerId(),
        context.surfaceKind,
        context.surfaceId,
        context.root,
        request.path,
        request.uploadId,
      ]),
    );
    const operation = serialized("upload:" + key, () =>
      this.run(context, key, request),
    );
    this.operations.add(operation);
    try {
      return await operation;
    } finally {
      this.operations.delete(operation);
    }
  }
  async dispose() {
    this.closing = true;
    await Promise.allSettled([...this.operations]);
  }
  private receipt(record: RecordState): BinaryWriteReceipt {
    return binaryWriteReceiptSchema.parse({
      path: record.path,
      uploadId: record.uploadId,
      state: record.state,
      offset: record.offset,
      size: record.size,
      sha256: record.sha256,
      version:
        record.state === "committed" ? "binary-sha256:" + record.sha256 : null,
      error: record.error,
    });
  }
  private async save(record: RecordState) {
    await this.storage.write(record.key, record);
  }
  private async load(
    context: BinaryWriteContext,
    key: string,
    request: BinaryWriteRequest,
  ) {
    const stored = await this.storage.read(key);
    if (stored === undefined) return undefined;
    const record = recordSchema.parse(stored);
    if (
      record.key !== key ||
      record.root !== context.root ||
      record.path !== request.path ||
      record.uploadId !== request.uploadId
    )
      throw new Error("Binary write receipt belongs to another document.");
    return record;
  }
  private async inspect(
    root: string,
    relativePath: string,
    expected: string | null,
    expectedSize?: number,
  ) {
    const resolved = await resolveBinaryWriteTarget(root, relativePath);
    if (!resolved.exists) {
      if (expected !== null) throw new BinaryWriteConflictError();
      return { target: resolved.targetPath, mode: 0o600 };
    }
    if (expected === null) throw new BinaryWriteConflictError();
    const handle = await open(
      resolved.targetPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile())
        throw new Error("Binary saving requires a regular file.");
      if (expectedSize !== undefined && before.size !== BigInt(expectedSize))
        throw new BinaryWriteConflictError();
      if (expected.startsWith("binary-v1:")) {
        if (binaryFileVersion(before) !== expected)
          throw new BinaryWriteConflictError();
      } else if ("binary-sha256:" + (await hashHandle(handle)) !== expected)
        throw new BinaryWriteConflictError();
      if (
        binaryFileVersion(await handle.stat({ bigint: true })) !==
        binaryFileVersion(before)
      )
        throw new BinaryWriteConflictError();
      return { target: resolved.targetPath, mode: Number(before.mode) & 0o777 };
    } finally {
      await handle.close();
    }
  }
  private async run(
    context: BinaryWriteContext,
    key: string,
    request: BinaryWriteRequest,
  ): Promise<BinaryWriteReceipt> {
    let record = await this.load(context, key, request);
    if (request.type === "explorer.binary.write.begin") {
      if (record) {
        if (record.state === "aborted") return this.receipt(record);
        if (record.expected !== request.version)
          throw new Error("The binary upload baseline changed.");
        return this.reconcile(record);
      }
      const target = await this.inspect(
        context.root,
        request.path,
        request.version,
      );
      await this.storage.initialize();
      try {
        await this.storage.create(key);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.storage.discard(key);
        await this.storage.create(key);
      }
      record = {
        formatVersion: 1,
        key,
        root: context.root,
        path: request.path,
        uploadId: request.uploadId,
        target: target.target,
        publication: path.join(
          path.dirname(target.target),
          ".cantrip-publish-" + randomUUID(),
        ),
        publicationVersion: null,
        expected: request.version,
        mode: target.mode,
        offset: 0,
        frames: 0,
        final: false,
        state: "uploading",
        size: null,
        sha256: null,
        error: null,
      };
      await this.save(record);
      return this.receipt(record);
    }
    if (!record) {
      if (request.type === "explorer.binary.write.abort") {
        // Cancellation may arrive before a delayed begin request. Persist its
        // tombstone under the same per-upload queue so that begin cannot later
        // resurrect an upload which the recovering client already abandoned.
        record = {
          formatVersion: 1,
          key,
          root: context.root,
          path: request.path,
          uploadId: request.uploadId,
          target: "",
          publication: "",
          publicationVersion: null,
          expected: null,
          mode: 0,
          offset: 0,
          frames: 0,
          final: false,
          state: "aborted",
          size: null,
          sha256: null,
          error: null,
        };
        await this.save(record);
        return this.receipt(record);
      }
      if (request.type !== "explorer.binary.write.status")
        throw new Error("Binary upload is unavailable. Start a new save.");
      return {
        path: request.path,
        uploadId: request.uploadId,
        state: "unknown",
        offset: 0,
        size: null,
        sha256: null,
        version: null,
        error: null,
      };
    }
    if (request.type === "explorer.binary.write.status")
      return this.reconcile(record);
    if (request.type === "explorer.binary.write.abort") {
      if (record.state === "prepared") {
        const reconciled = await this.reconcile(record, false);
        if (reconciled.state === "committed") return reconciled;
      }
      if (record.state === "committed") return this.receipt(record);
      record.state = "aborted";
      record.error = null;
      await this.save(record);
      await this.storage.discard(key);
      if (record.publication) await rm(record.publication, { force: true });
      return this.receipt(record);
    }
    if (request.type === "explorer.binary.write.commit") {
      if (record.state === "committed") {
        if (record.size !== request.size || record.sha256 !== request.sha256)
          throw new Error("The committed upload does not match this save.");
        return this.receipt(record);
      }
      if (record.state === "prepared") {
        if (record.size !== request.size || record.sha256 !== request.sha256)
          throw new Error("The prepared upload does not match this save.");
        return this.reconcile(record);
      }
      if (
        record.state !== "uploading" ||
        !record.final ||
        record.offset !== request.size
      )
        throw new Error("The binary upload is not complete.");
      record.size = request.size;
      record.sha256 = request.sha256;
      await this.materialize(record);
      record.state = "prepared";
      await this.save(record);
      return this.publish(record);
    }
    if (record.state !== "uploading")
      throw new Error("This binary upload no longer accepts chunks.");
    const bytes = Buffer.from(request.data, "base64");
    try {
      if (
        request.offset % BINARY_WRITE_CHUNK_BYTES !== 0 ||
        bytes.length > BINARY_WRITE_CHUNK_BYTES ||
        (!request.final && bytes.length !== BINARY_WRITE_CHUNK_BYTES)
      )
        throw new Error(
          "Binary chunks require ordered full pages and one final page.",
        );
      if (record.final || request.offset < record.offset) {
        const index = request.offset / BINARY_WRITE_CHUNK_BYTES;
        if (index >= record.frames)
          throw new Error("Binary retry offset is unavailable.");
        const prior = await this.storage.frame(key, index);
        try {
          if (
            prior.final !== request.final ||
            prior.bytes.length !== bytes.length ||
            !timingSafeEqual(prior.bytes, bytes)
          )
            throw new Error("A retried binary chunk has different content.");
        } finally {
          prior.bytes.fill(0);
        }
        return this.receipt(record);
      }
      if (request.offset !== record.offset)
        throw new Error(
          "Binary chunk offset does not match the uploaded prefix.",
        );
      if (!Number.isSafeInteger(record.offset + bytes.length))
        throw new Error("Binary upload exceeds supported byte addressing.");
      await this.storage.append(
        key,
        request.offset,
        bytes,
        request.final,
        record.frames,
      );
      record.offset += bytes.length;
      record.frames++;
      record.final = request.final;
      await this.save(record);
      return this.receipt(record);
    } finally {
      bytes.fill(0);
    }
  }
  private async materialize(record: RecordState) {
    // Only this authenticated receipt can name this worker-generated publication temporary.
    await rm(record.publication, { force: true });
    const target = await open(record.publication, "wx+", 0o600),
      hash = createHash("sha256");
    let size = 0;
    try {
      for (let i = 0; i < record.frames; i++) {
        const frame = await this.storage.frame(record.key, i);
        try {
          if (frame.final !== (i === record.frames - 1))
            throw new Error("Binary staging final-page marker is invalid.");
          let written = 0;
          while (written < frame.bytes.length) {
            const result = await target.write(
              frame.bytes,
              written,
              frame.bytes.length - written,
              size + written,
            );
            if (!result.bytesWritten)
              throw new Error("Binary publication stopped writing.");
            written += result.bytesWritten;
          }
          hash.update(frame.bytes);
          size += frame.bytes.length;
        } finally {
          frame.bytes.fill(0);
        }
      }
      if (size !== record.size || hash.digest("hex") !== record.sha256)
        throw new Error("Binary upload size or checksum does not match.");
      await target.chmod(record.mode);
      await target.sync();
      if (
        (await target.stat()).size !== record.size ||
        (await hashHandle(target)) !== record.sha256
      )
        throw new Error(
          "Binary publication failed its stored size/checksum verification.",
        );
      record.publicationVersion = binaryFileVersion(
        await target.stat({ bigint: true }),
      );
    } catch (error) {
      await rm(record.publication, { force: true }).catch(() => {});
      throw error;
    } finally {
      await target.close();
    }
    await syncBinaryDirectory(path.dirname(record.publication));
  }
  private async publish(record: RecordState): Promise<BinaryWriteReceipt> {
    return serialized("target:" + record.target, async () => {
      try {
        const current = await this.inspect(
          record.root,
          record.path,
          record.expected,
        );
        if (current.target !== record.target)
          throw new BinaryWriteConflictError();
        const publication = await open(
          record.publication,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          if (
            binaryFileVersion(await publication.stat({ bigint: true })) !==
            record.publicationVersion
          )
            throw new Error(
              "The staged publication changed before saving. Restart this save.",
            );
        } finally {
          await publication.close();
        }
        if (record.expected === null) {
          await link(record.publication, record.target);
          await rm(record.publication, { force: true });
        } else await rename(record.publication, record.target);
        await syncBinaryDirectory(path.dirname(record.target));
      } catch (error) {
        if (
          error instanceof BinaryWriteConflictError ||
          (error as NodeJS.ErrnoException).code === "EEXIST"
        ) {
          record.state = "conflict";
          record.error = new BinaryWriteConflictError().message;
          await this.save(record);
          return this.receipt(record);
        }
        throw error;
      }
      record.state = "committed";
      record.error = null;
      // Prepared is already durable. If this update fails, status can reconcile the consumed temporary.
      await this.save(record);
      await this.storage.discard(record.key).catch(() => {});
      return this.receipt(record);
    });
  }
  private async reconcile(
    record: RecordState,
    finish = true,
  ): Promise<BinaryWriteReceipt> {
    if (record.state !== "prepared") return this.receipt(record);
    const publication = await lstat(record.publication).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    const target =
      record.expected === null && publication
        ? await lstat(record.target).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          })
        : null;
    if (
      !publication ||
      (target &&
        publication.isFile() &&
        target.isFile() &&
        publication.dev === target.dev &&
        publication.ino === target.ino)
    ) {
      // Absence alone cannot prove rename: cleanup or another process may have
      // removed the temporary before publication. Observe the actual output.
      try {
        const current = await this.inspect(
          record.root,
          record.path,
          "binary-sha256:" + record.sha256,
          record.size!,
        );
        if (current.target !== record.target)
          throw new BinaryWriteConflictError();
      } catch (error) {
        if (!(error instanceof BinaryWriteConflictError)) throw error;
        record.state = "conflict";
        record.error =
          "The prepared save cannot be verified against the current file. The draft has been retained.";
        await this.save(record);
        return this.receipt(record);
      }
      if (publication) await rm(record.publication, { force: true });
      record.state = "committed";
      record.error = null;
      await this.save(record).catch(() => {});
      await this.storage.discard(record.key).catch(() => {});
      return this.receipt(record);
    }
    return finish ? this.publish(record) : this.receipt(record);
  }
}
async function hashHandle(handle: FileHandle) {
  const hash = createHash("sha256"),
    bytes = Buffer.alloc(BINARY_WRITE_CHUNK_BYTES);
  let offset = 0;
  try {
    for (;;) {
      const result = await handle.read(bytes, 0, bytes.length, offset);
      if (!result.bytesRead) break;
      hash.update(bytes.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    return hash.digest("hex");
  } finally {
    bytes.fill(0);
  }
}
