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
import { isDeepStrictEqual } from "node:util";
import {
  CANTRIP_OS_SYSTEM_CHUNK_BYTES,
  CANTRIP_OS_SYSTEM_METADATA_BYTES,
  cantripOsSystemCryptoContextSchema,
  cantripOsSystemEndSchema,
  cantripOsSystemFileHeaderSchema,
  cantripOsSystemFrameSchema,
  cantripOsSystemManifestSchema,
  type CantripOsSystemCryptoContext,
  type CantripOsSystemManifest,
  type CantripOsSystemArchiveReceipt,
} from "@cantrip/protocol/cantrip-os-system";
import {
  clearSensitiveBytes,
  decryptCantripOsSystemFrame,
  encryptCantripOsSystemFrame,
} from "@cantrip/crypto";
import type { BackupKeyAccess } from "./private-backup-file.js";

type Identity = {
  context: CantripOsSystemCryptoContext;
  keys: BackupKeyAccess;
  signal?: AbortSignal;
};
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function account(input: Identity) {
  input.signal?.throwIfAborted();
  if (
    input.keys.ownerId() !== input.context.ownerId ||
    input.keys.serverIdentity() !== input.context.serverId
  )
    throw new Error(
      "The private system archive belongs to another account or Server.",
    );
}
function keyFor(input: Identity, revision?: number) {
  account(input);
  return input.keys.componentKey("repository-content", revision);
}
function manifestFor(input: Identity, raw: unknown) {
  const value = cantripOsSystemManifestSchema.parse(raw);
  if (
    value.snapshot.instanceId !== input.context.instanceId ||
    value.snapshot.sourceContainerId !== input.context.containerId
  )
    throw new Error(
      "The system manifest belongs to a different original instance.",
    );
  return value;
}
async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function output(destination: string) {
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(directory, `.cantrip-system-${randomUUID()}.partial`);
  return { temporary, handle: await open(temporary, "wx", 0o600) };
}
async function publish(
  temporary: string,
  destination: string,
  handle: FileHandle,
) {
  await handle.sync();
  await handle.close();
  await link(temporary, destination);
  await unlink(temporary);
  await syncDirectory(dirname(destination));
}
async function* chunks(archive: AsyncIterable<Uint8Array>) {
  let pending = Buffer.alloc(CANTRIP_OS_SYSTEM_CHUNK_BYTES),
    used = 0;
  try {
    for await (const source of archive) {
      if (!(source instanceof Uint8Array))
        throw new Error("Invalid system archive bytes.");
      for (let offset = 0; offset < source.length;) {
        const size = Math.min(source.length - offset, pending.length - used);
        pending.set(source.subarray(offset, offset + size), used);
        used += size;
        offset += size;
        if (used === pending.length) {
          yield pending;
          clearSensitiveBytes(pending);
          pending = Buffer.alloc(CANTRIP_OS_SYSTEM_CHUNK_BYTES);
          used = 0;
        }
      }
    }
    if (used) yield pending.subarray(0, used);
  } finally {
    clearSensitiveBytes(pending);
  }
}

/** Docker tar size/digest are known only at EOF. A fresh stream identity binds
 * every frame; the authenticated footer commits the exact manifest and bytes. */
export async function sealPrivateSystem(
  input: Identity & {
    destination: string;
    manifest: CantripOsSystemManifest;
    archive: AsyncIterable<Uint8Array>;
  },
): Promise<CantripOsSystemArchiveReceipt> {
  input = {
    ...input,
    context: cantripOsSystemCryptoContextSchema.parse(input.context),
  };
  const manifest = manifestFor(input, input.manifest);
  const material = keyFor(input);
  let file: Awaited<ReturnType<typeof output>> | undefined;
  const streamId = randomUUID();
  const identity = {
    context: input.context,
    streamId,
    keyRevision: material.keyRevision,
    componentKey: material.key,
  };
  const metadata = new TextEncoder().encode(JSON.stringify(manifest));
  try {
    file = await output(input.destination);
    const write = async (value: unknown) => {
      account(input);
      await file!.handle.writeFile(JSON.stringify(value) + "\n");
    };
    await write({
      format: "CantripOS-private-system",
      version: 1,
      checkpointId: input.context.checkpointId,
      streamId,
      keyRevision: material.keyRevision,
      manifest: await encryptCantripOsSystemFrame({
        ...identity,
        kind: "manifest",
        sequence: 0,
        plaintext: metadata,
      }),
    });
    const digest = createHash("sha256");
    let archiveBytes = 0,
      count = 0;
    for await (const plaintext of chunks(input.archive)) {
      account(input);
      archiveBytes += plaintext.length;
      if (!Number.isSafeInteger(archiveBytes))
        throw new Error("System archive is too large.");
      digest.update(plaintext);
      await write(
        await encryptCantripOsSystemFrame({
          ...identity,
          kind: "chunk",
          sequence: count++,
          plaintext,
        }),
      );
    }
    const end = cantripOsSystemEndSchema.parse({
      archiveBytes,
      archiveSha256: digest.digest("hex"),
      manifestSha256: hash(metadata),
      chunks: count,
    });
    const plaintext = new TextEncoder().encode(JSON.stringify(end));
    try {
      await write(
        await encryptCantripOsSystemFrame({
          ...identity,
          kind: "end",
          sequence: count,
          plaintext,
        }),
      );
    } finally {
      clearSensitiveBytes(plaintext);
    }
    account(input);
    await publish(file.temporary, input.destination, file.handle);
    return { ...end, keyRevision: material.keyRevision, streamId };
  } finally {
    clearSensitiveBytes(metadata);
    clearSensitiveBytes(material.key);
    await file?.handle.close().catch(() => {});
    if (file)
      await unlink(file.temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}

async function* records(source: string) {
  const stream = createReadStream(source, { highWaterMark: 65_536 });
  const maximum =
    Math.ceil((CANTRIP_OS_SYSTEM_METADATA_BYTES + 16) / 3) * 4 + 65_536;
  let pending = Buffer.alloc(0);
  try {
    for await (const bytes of stream) {
      pending = Buffer.concat([pending, bytes]);
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        if (newline > maximum)
          throw new Error("Private system record is too large.");
        yield JSON.parse(
          pending.subarray(0, newline).toString("utf8"),
        ) as unknown;
        pending = pending.subarray(newline + 1);
      }
      if (pending.length > maximum)
        throw new Error("Private system record is too large.");
    }
    if (pending.length) throw new Error("Private system record is incomplete.");
  } finally {
    stream.destroy();
  }
}

async function consume(
  input: Identity & {
    source: string;
    destination?: string;
    expected?: {
      manifest: CantripOsSystemManifest;
      receipt: CantripOsSystemArchiveReceipt;
    };
  },
) {
  input = {
    ...input,
    context: cantripOsSystemCryptoContextSchema.parse(input.context),
  };
  const iterator = records(input.source)[Symbol.asyncIterator]();
  let key: Uint8Array | undefined;
  let file: Awaited<ReturnType<typeof output>> | undefined;
  try {
    const header = cantripOsSystemFileHeaderSchema.parse(
      (await iterator.next()).value,
    );
    if (
      header.checkpointId !== input.context.checkpointId ||
      header.manifest.kind !== "manifest" ||
      header.manifest.sequence !== 0
    )
      throw new Error("Private system header does not match its admission.");
    const material = keyFor(input, header.keyRevision);
    key = material.key;
    if (material.keyRevision !== header.keyRevision)
      throw new Error("The granted archive key revision changed.");
    const identity = {
      context: input.context,
      streamId: header.streamId,
      keyRevision: header.keyRevision,
      componentKey: key,
    };
    const metadata = await decryptCantripOsSystemFrame({
      ...identity,
      frame: header.manifest,
    });
    let manifest: CantripOsSystemManifest, manifestSha256: string;
    try {
      manifest = manifestFor(
        input,
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata)),
      );
      manifestSha256 = hash(metadata);
    } finally {
      clearSensitiveBytes(metadata);
    }
    if (input.destination) file = await output(input.destination);
    const digest = createHash("sha256");
    let archiveBytes = 0,
      count = 0;
    while (true) {
      account(input);
      const next = await iterator.next();
      if (next.done)
        throw new Error("Private system archive has no authenticated footer.");
      const frame = cantripOsSystemFrameSchema.parse(next.value);
      if (
        frame.sequence !== count ||
        (frame.kind !== "chunk" && frame.kind !== "end")
      )
        throw new Error("Private system archive frames are out of order.");
      const plaintext = await decryptCantripOsSystemFrame({
        ...identity,
        frame,
      });
      try {
        if (frame.kind === "chunk") {
          if (!plaintext.length)
            throw new Error("Private system chunk is empty.");
          archiveBytes += plaintext.length;
          if (!Number.isSafeInteger(archiveBytes))
            throw new Error("System archive is too large.");
          digest.update(plaintext);
          count++;
          await file?.handle.writeFile(plaintext);
          continue;
        }
        const end = cantripOsSystemEndSchema.parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
          ),
        );
        if (
          end.archiveBytes !== archiveBytes ||
          end.chunks !== count ||
          end.archiveSha256 !== digest.digest("hex") ||
          end.manifestSha256 !== manifestSha256 ||
          !(await iterator.next()).done
        )
          throw new Error("Private system archive is incomplete or changed.");
        account(input);
        const receipt = {
          ...end,
          streamId: header.streamId,
          keyRevision: header.keyRevision,
        };
        if (
          input.expected &&
          (!isDeepStrictEqual(input.expected.manifest, manifest) ||
            !isDeepStrictEqual(input.expected.receipt, receipt))
        )
          throw new Error("The original system archive proof changed.");
        if (file)
          await publish(file.temporary, input.destination!, file.handle);
        return { manifest, receipt };
      } finally {
        clearSensitiveBytes(plaintext);
      }
    }
  } finally {
    if (key) clearSensitiveBytes(key);
    await iterator.return?.(undefined);
    await file?.handle.close().catch(() => {});
    if (file)
      await unlink(file.temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}
export const verifyPrivateSystem = (input: Identity & { source: string }) =>
  consume(input);
/** Plaintext remains a private staging file until the complete footer and EOF
 * authenticate. Callers must verify the loaded image identity before activation. */
export const openPrivateSystem = (
  input: Identity & {
    source: string;
    destination: string;
    expected?: {
      manifest: CantripOsSystemManifest;
      receipt: CantripOsSystemArchiveReceipt;
    };
  },
) => consume(input);
