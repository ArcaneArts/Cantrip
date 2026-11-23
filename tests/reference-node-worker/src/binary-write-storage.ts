import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  encryptPayload,
  decryptPayload,
  deriveFieldKey,
  clearSensitiveBytes,
} from "@cantrip/crypto";
import {
  encryptedPayloadEnvelopeSchema,
  type EncryptionAssociatedData,
} from "@cantrip/protocol/encryption";
import type { WorkerEncryptionService } from "./worker-encryption.js";
import { BINARY_WRITE_CHUNK_BYTES } from "@cantrip/protocol/surface-stream";
export const BINARY_FRAME_OVERHEAD = 40;
export type BinaryWriteKeys = Pick<
  WorkerEncryptionService,
  "ownerId" | "componentKey"
>;
export async function syncBinaryDirectory(directory: string) {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !["EPERM", "EISDIR", "EINVAL", "ENOTSUP"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
  } finally {
    await handle?.close();
  }
}
/** Receipt metadata and staged chunks use distinct field keys scoped to this owner and upload. */
export class BinaryWriteStorage {
  readonly directory: string;
  constructor(
    dataDirectory: string,
    private service: BinaryWriteKeys,
  ) {
    this.directory = path.join(dataDirectory, "binary-file-writes");
  }
  key(binding: string) {
    return createHash("sha256").update(binding).digest("hex");
  }
  private material(key: string, field: string) {
    const material = this.service.componentKey("surface-private-state"),
      associatedData: EncryptionAssociatedData = {
        ownerId: this.service.ownerId(),
        component: "surface-private-state",
        table: "worker:binary-file-writes",
        rowId: key,
        field,
        formatVersion: 1,
        keyRevision: material.keyRevision,
      };
    try {
      return {
        key: deriveFieldKey({
          componentKey: material.key,
          ownerId: associatedData.ownerId,
          component: "surface-private-state",
          table: associatedData.table,
          field,
          keyRevision: material.keyRevision,
        }),
        associatedData,
      };
    } finally {
      clearSensitiveBytes(material.key);
    }
  }
  file(key: string) {
    if (!/^[a-f0-9]{64}$/u.test(key))
      throw new Error("Invalid binary write storage key.");
    return path.join(this.directory, key + ".stage");
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }
  async read(key: string): Promise<unknown | undefined> {
    let bytes: Uint8Array;
    try {
      const handle = await open(
        path.join(this.directory, key + ".json"),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const data = Buffer.alloc(128 * 1024),
          read = await handle.read(data, 0, data.length, 0);
        if (read.bytesRead === data.length)
          throw new Error("Binary write receipt exceeds its storage limit.");
        bytes = data.subarray(0, read.bytesRead);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const material = this.material(key, "receipt-v1");
    let plaintext: Uint8Array | undefined;
    try {
      const envelope = encryptedPayloadEnvelopeSchema.parse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
      plaintext = await decryptPayload({
        key: material.key,
        envelope,
        associatedData: material.associatedData,
      });
      return JSON.parse(new TextDecoder().decode(plaintext));
    } finally {
      clearSensitiveBytes(material.key);
      plaintext?.fill(0);
      bytes.fill(0);
    }
  }
  async write(key: string, value: unknown) {
    await this.initialize();
    const material = this.material(key, "receipt-v1"),
      plaintext = new TextEncoder().encode(JSON.stringify(value));
    let temporary: string | undefined;
    try {
      if (plaintext.length > 64 * 1024)
        throw new Error("Binary write receipt exceeds its storage limit.");
      const envelope = await encryptPayload({
        key: material.key,
        plaintext,
        associatedData: material.associatedData,
      });
      temporary = path.join(this.directory, key + "." + randomUUID() + ".tmp");
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(envelope));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path.join(this.directory, key + ".json"));
      temporary = undefined;
      await syncBinaryDirectory(this.directory);
    } finally {
      clearSensitiveBytes(material.key);
      plaintext.fill(0);
      if (temporary) await rm(temporary, { force: true });
    }
  }
  private aad(key: string, offset: number, length: number, final: boolean) {
    return Buffer.from(
      JSON.stringify([
        "cantrip-binary-write-chunk",
        1,
        this.service.ownerId(),
        key,
        offset,
        length,
        final,
      ]),
    );
  }
  async append(
    key: string,
    offset: number,
    bytes: Uint8Array,
    final: boolean,
    frames: number,
  ) {
    const material = this.material(key, "chunks-v1"),
      nonce = randomBytes(12),
      header = Buffer.alloc(24);
    header.writeUInt32LE(bytes.length, 0);
    header[4] = final ? 1 : 0;
    nonce.copy(header, 8);
    header.writeUInt32LE(material.associatedData.keyRevision, 20);
    let ciphertext: Buffer | undefined, tag: Buffer | undefined;
    try {
      const cipher = createCipheriv("aes-256-gcm", material.key, nonce);
      cipher.setAAD(this.aad(key, offset, bytes.length, final));
      ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      tag = cipher.getAuthTag();
      const handle = await open(
        this.file(key),
        constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const position =
          frames * (BINARY_WRITE_CHUNK_BYTES + BINARY_FRAME_OVERHEAD);
        if (!Number.isSafeInteger(position))
          throw new Error("Binary staging exceeds supported byte addressing.");
        await handle.truncate(position);
        for (const part of [header, ciphertext, tag]) {
          let used = 0;
          while (used < part.length) {
            const written = await handle.write(
              part,
              used,
              part.length - used,
              position +
                used +
                (part === header
                  ? 0
                  : part === ciphertext
                    ? header.length
                    : header.length + ciphertext.length),
            );
            if (!written.bytesWritten)
              throw new Error("Binary staging stopped writing.");
            used += written.bytesWritten;
          }
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
    } finally {
      clearSensitiveBytes(material.key);
      nonce.fill(0);
      header.fill(0);
      ciphertext?.fill(0);
      tag?.fill(0);
    }
  }
  async frame(key: string, index: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    let handle: FileHandle | undefined;
    const header = Buffer.alloc(24),
      position = index * (BINARY_WRITE_CHUNK_BYTES + BINARY_FRAME_OVERHEAD);
    let ciphertext: Buffer | undefined,
      tag: Buffer | undefined,
      plaintext: Buffer | undefined;
    const material = this.material(key, "chunks-v1");
    try {
      handle = await open(
        this.file(key),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      await readExact(handle, header, position);
      const length = header.readUInt32LE(0),
        final = header[4] === 1;
      if (
        length > BINARY_WRITE_CHUNK_BYTES ||
        header[4]! > 1 ||
        header.readUInt32LE(20) !== material.associatedData.keyRevision
      )
        throw new Error("Binary staging frame is invalid.");
      ciphertext = Buffer.alloc(length);
      tag = Buffer.alloc(16);
      await readExact(handle, ciphertext, position + header.length);
      await readExact(handle, tag, position + header.length + length);
      const decipher = createDecipheriv(
        "aes-256-gcm",
        material.key,
        header.subarray(8, 20),
      );
      decipher.setAAD(
        this.aad(key, index * BINARY_WRITE_CHUNK_BYTES, length, final),
      );
      decipher.setAuthTag(tag);
      plaintext = decipher.update(ciphertext);
      const bytes = Buffer.concat([plaintext, decipher.final()]);
      return { bytes, final };
    } finally {
      await handle?.close();
      clearSensitiveBytes(material.key);
      header.fill(0);
      ciphertext?.fill(0);
      tag?.fill(0);
      plaintext?.fill(0);
    }
  }
  async create(key: string) {
    await this.initialize();
    const handle = await open(this.file(key), "wx", 0o600);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncBinaryDirectory(this.directory);
  }
  async discard(key: string) {
    await rm(this.file(key), { force: true });
  }
}
async function readExact(handle: FileHandle, bytes: Buffer, offset: number) {
  let used = 0;
  while (used < bytes.length) {
    const read = await handle.read(
      bytes,
      used,
      bytes.length - used,
      offset + used,
    );
    if (!read.bytesRead) throw new Error("Binary staging frame is incomplete.");
    used += read.bytesRead;
  }
}
