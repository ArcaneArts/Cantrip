import {
  EXPLORER_FILE_IMPORT_CHUNK_BYTES,
  type ExplorerFileBinding,
} from "@cantrip/protocol/surface-stream";
import { explorerEntryNameSchema } from "@cantrip/protocol";
import { executeExplorerOperation } from "./files";

function encodeChunk(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  return btoa(binary);
}

/** Stream exact file bytes; never decode text or buffer the entire file. */
export async function importExplorerFile(
  explorerId: string,
  path: string,
  file: File,
  binding: ExplorerFileBinding,
  options: { isCurrent(): boolean; onProgress(bytes: number): void },
) {
  const name = explorerEntryNameSchema.parse(file.name);
  const operationId = crypto.randomUUID();
  let offset = 0;
  let sequence = 0;
  try {
    do {
      if (!options.isCurrent())
        throw new Error("The project changed during the file import.");
      const chunk = new Uint8Array(
        await file
          .slice(offset, offset + EXPLORER_FILE_IMPORT_CHUNK_BYTES)
          .arrayBuffer(),
      );
      if (!options.isCurrent())
        throw new Error("The project changed during the file import.");
      const nextOffset = offset + chunk.byteLength;
      const eof = nextOffset === file.size;
      const result = await executeExplorerOperation(
        explorerId,
        {
          type: "explorer.file.import",
          path,
          name,
          size: file.size,
          offset,
          data: encodeChunk(chunk),
          eof,
        },
        operationId,
        sequence++,
        binding,
      );
      if (
        result.type !== "explorer.file.imported" ||
        result.value.offset !== nextOffset ||
        (eof
          ? result.value.entry?.path !== (path ? `${path}/${name}` : name) ||
            result.value.entry.size !== file.size
          : result.value.entry !== null)
      )
        throw new Error("Explorer returned an unexpected file import result.");
      options.onProgress(nextOffset);
      if (eof) return result.value.entry!;
      if (!chunk.byteLength)
        throw new Error("The file import stopped progressing.");
      offset = nextOffset;
    } while (offset < file.size);
    throw new Error("The file import ended before the file was complete.");
  } catch (error) {
    await executeExplorerOperation(
      explorerId,
      { type: "explorer.file.import.cancel" },
      operationId,
      sequence,
      binding,
    ).catch(() => {});
    throw error;
  }
}
