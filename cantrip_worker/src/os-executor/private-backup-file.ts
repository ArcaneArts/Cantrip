import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  open,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CantripDecryptionError,
  clearSensitiveBytes,
  decryptCantripOsBackupFrame,
  encryptCantripOsBackupFrame,
} from "@cantrip/crypto";
import {
  CANTRIP_OS_BACKUP_CHUNK_BYTES,
  CANTRIP_OS_BACKUP_METADATA_BYTES,
  cantripOsBackupArchiveMetadataSchema,
  cantripOsBackupCryptoContextSchema,
  cantripOsBackupEndSchema,
  cantripOsBackupFileHeaderSchema,
  cantripOsBackupFrameSchema,
  type CantripOsBackupArchiveMetadata,
  type CantripOsBackupCryptoContext,
} from "@cantrip/protocol/cantrip-os-backup";
import type { WorkerEncryptionService } from "../worker-encryption.js";

export type BackupKeyAccess = Pick<
  WorkerEncryptionService,
  "ownerId" | "serverIdentity" | "componentKey"
>;
type Identity = {
  context: CantripOsBackupCryptoContext;
  keys: BackupKeyAccess;
};

function keyFor(input: Identity, revision?: number) {
  if (
    input.keys.ownerId() !== input.context.ownerId ||
    input.keys.serverIdentity() !== input.context.serverId
  )
    throw new Error("The private backup account or server changed.");
  return input.keys.componentKey("repository-content", revision);
}

async function privateOutput(path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = join(
    dirname(path),
    `.cantrip-backup-${randomUUID()}.partial`,
  );
  return { temporary, handle: await open(temporary, "wx", 0o600) };
}

async function publish(
  temporary: string,
  destination: string,
  handle: FileHandle,
) {
  await handle.sync();
  await handle.close();
  // Atomic publication without replacing an existing backup/admission. If
  // directory sync fails afterwards, the valid file remains observable.
  await link(temporary, destination);
  await unlink(temporary);
  const directory = await open(dirname(destination), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeJson(handle: FileHandle, value: unknown) {
  await handle.writeFile(JSON.stringify(value) + "\n");
}

async function* chunks(source: AsyncIterable<Uint8Array>) {
  let buffer = Buffer.alloc(CANTRIP_OS_BACKUP_CHUNK_BYTES),
    used = 0;
  for await (const input of source) {
    for (let offset = 0; offset < input.byteLength;) {
      const take = Math.min(input.byteLength - offset, buffer.length - used);
      buffer.set(input.subarray(offset, offset + take), used);
      offset += take;
      used += take;
      if (used === buffer.length) {
        yield buffer;
        buffer = Buffer.alloc(CANTRIP_OS_BACKUP_CHUNK_BYTES);
        used = 0;
      }
    }
  }
  if (used) yield buffer.subarray(0, used);
}

/** Seal a verified guest archive in a dedicated Worker-private directory.
 * Neither the manifest nor paths/profile bytes appear in the public header. */
export async function sealPrivateBackup(
  input: Identity & {
    destination: string;
    metadata: CantripOsBackupArchiveMetadata;
    archive: AsyncIterable<Uint8Array>;
  },
) {
  const context = cantripOsBackupCryptoContextSchema.parse(input.context);
  const metadata = cantripOsBackupArchiveMetadataSchema.parse(input.metadata);
  const material = keyFor(input);
  const output = await privateOutput(input.destination).catch(
    (error: unknown) => {
      clearSensitiveBytes(material.key);
      throw error;
    },
  );
  const identity = {
    context,
    componentKey: material.key,
    keyRevision: material.keyRevision,
  };
  const digest = createHash("sha256");
  let archiveBytes = 0,
    count = 0;
  try {
    const plaintext = new TextEncoder().encode(JSON.stringify(metadata));
    try {
      await writeJson(output.handle, {
        format: "CantripOS-private-backup",
        version: 1,
        backupId: context.backupId,
        keyRevision: material.keyRevision,
        metadata: await encryptCantripOsBackupFrame({
          ...identity,
          kind: "metadata",
          sequence: 0,
          plaintext,
        }),
      });
    } finally {
      clearSensitiveBytes(plaintext);
    }
    for await (const plaintext of chunks(input.archive)) {
      try {
        archiveBytes += plaintext.byteLength;
        if (archiveBytes > metadata.archiveBytes)
          throw new Error("The guest archive exceeds its captured size.");
        digest.update(plaintext);
        await writeJson(
          output.handle,
          await encryptCantripOsBackupFrame({
            ...identity,
            kind: "chunk",
            sequence: count++,
            plaintext,
          }),
        );
      } finally {
        clearSensitiveBytes(plaintext);
      }
    }
    const archiveSha256 = digest.digest("hex");
    if (
      archiveBytes !== metadata.archiveBytes ||
      archiveSha256 !== metadata.archiveSha256
    )
      throw new Error("The guest archive differs from its captured receipt.");
    const end = new TextEncoder().encode(
      JSON.stringify({ archiveBytes, archiveSha256, chunks: count }),
    );
    try {
      await writeJson(
        output.handle,
        await encryptCantripOsBackupFrame({
          ...identity,
          kind: "end",
          sequence: count,
          plaintext: end,
        }),
      );
    } finally {
      clearSensitiveBytes(end);
    }
    await publish(output.temporary, input.destination, output.handle);
    return {
      keyRevision: material.keyRevision,
      archiveBytes,
      archiveSha256,
      chunks: count,
    };
  } finally {
    clearSensitiveBytes(material.key);
    await output.handle.close().catch(() => {});
    await unlink(output.temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

const MAX_LINE_BYTES =
  Math.ceil((CANTRIP_OS_BACKUP_METADATA_BYTES + 16) / 3) * 4 + 4096;

async function* records(path: string) {
  const source = createReadStream(path, { highWaterMark: 64 * 1024 });
  let parts: Buffer[] = [],
    length = 0;
  try {
    for await (const value of source) {
      const chunk = value as Buffer;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(start, end);
        length += part.length;
        if (length > MAX_LINE_BYTES) throw new CantripDecryptionError();
        parts.push(part);
        if (newline < 0) break;
        yield JSON.parse(
          Buffer.concat(parts, length).toString("utf8"),
        ) as unknown;
        parts = [];
        length = 0;
        start = newline + 1;
      }
    }
    if (length) throw new CantripDecryptionError();
  } finally {
    source.destroy();
  }
}

/** Authenticate the complete ordered file, including EOF, before publishing any
 * usable plaintext archive. The caller owns deletion after its staged restore. */
export async function openPrivateBackup(
  input: Identity & { source: string; destination: string },
) {
  return consumePrivateBackup(input);
}

/** Observe an already published encrypted file without creating a plaintext
 * archive or inferring success from a filename alone. */
export async function verifyPrivateBackup(
  input: Identity & { source: string },
) {
  return consumePrivateBackup(input);
}

async function consumePrivateBackup(
  input: Identity & { source: string; destination?: string },
) {
  const context = cantripOsBackupCryptoContextSchema.parse(input.context);
  const iterator = records(input.source);
  let material: ReturnType<BackupKeyAccess["componentKey"]> | undefined;
  let output: Awaited<ReturnType<typeof privateOutput>> | undefined;
  try {
    const first = await iterator.next();
    const header = cantripOsBackupFileHeaderSchema.parse(first.value);
    if (
      header.backupId !== context.backupId ||
      header.metadata.kind !== "metadata" ||
      header.metadata.sequence !== 0
    )
      throw new CantripDecryptionError();
    material = keyFor(input, header.keyRevision);
    const identity = {
      context,
      componentKey: material.key,
      keyRevision: header.keyRevision,
    };
    const manifestBytes = await decryptCantripOsBackupFrame({
      ...identity,
      frame: header.metadata,
    });
    let metadata: CantripOsBackupArchiveMetadata;
    try {
      metadata = cantripOsBackupArchiveMetadataSchema.parse(
        JSON.parse(new TextDecoder().decode(manifestBytes)),
      );
    } finally {
      clearSensitiveBytes(manifestBytes);
    }
    if (input.destination !== undefined)
      output = await privateOutput(input.destination);
    const digest = createHash("sha256");
    let archiveBytes = 0,
      count = 0,
      ended = false;
    for await (const value of iterator) {
      if (ended) throw new CantripDecryptionError();
      const frame = cantripOsBackupFrameSchema.parse(value);
      if (frame.kind === "metadata" || frame.sequence !== count)
        throw new CantripDecryptionError();
      const plaintext = await decryptCantripOsBackupFrame({
        ...identity,
        frame,
      });
      try {
        if (frame.kind === "chunk") {
          if (!plaintext.byteLength) throw new CantripDecryptionError();
          archiveBytes += plaintext.byteLength;
          if (archiveBytes > metadata.archiveBytes)
            throw new CantripDecryptionError();
          digest.update(plaintext);
          if (output) await output.handle.writeFile(plaintext);
          count++;
        } else {
          const end = cantripOsBackupEndSchema.parse(
            JSON.parse(new TextDecoder().decode(plaintext)),
          );
          if (
            end.chunks !== count ||
            end.archiveBytes !== archiveBytes ||
            archiveBytes !== metadata.archiveBytes ||
            end.archiveSha256 !== metadata.archiveSha256 ||
            end.archiveSha256 !== digest.digest("hex")
          )
            throw new CantripDecryptionError();
          ended = true;
        }
      } finally {
        clearSensitiveBytes(plaintext);
      }
    }
    if (!ended) throw new CantripDecryptionError();
    if (output && input.destination !== undefined)
      await publish(output.temporary, input.destination, output.handle);
    return { metadata, keyRevision: header.keyRevision };
  } finally {
    if (material) clearSensitiveBytes(material.key);
    try {
      await iterator.return(undefined);
    } finally {
      if (output) {
        await output.handle.close().catch(() => {});
        await unlink(output.temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
  }
}
