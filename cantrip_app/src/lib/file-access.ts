import {
  getClientSessionIdentitySnapshot,
  clientSessionIdentityMatches,
  onClientSessionIdentityChanged,
} from "./client-session";
import {
  openProtectedBinarySource,
  type BinaryFileSource,
} from "./binary-file-source";
import type {
  BinaryWriteRequest,
  BinaryWriteReceipt,
  ExplorerLogTail,
  LogTailCursor,
  ExplorerTextPreviewPage,
} from "@cantrip/protocol/surface-stream";
import type {
  ExplorerFile,
  ExplorerFileWrite,
  ExplorerMediaKind,
} from "@cantrip/protocol";
import {
  executeFileDocumentOperation,
  type FileDocument,
} from "./api/file-documents";
import { loadProtectedFileMedia } from "./api/files";

/** File I/O is independent of the tree that originally opened a document. */
export interface FileAccess {
  readonly cacheKey: string;
  read(path: string): Promise<ExplorerFile>;
  preview?(
    path: string,
    offset: number,
    version?: string,
  ): Promise<ExplorerTextPreviewPage>;
  tail?(path: string, cursor?: LogTailCursor): Promise<ExplorerLogTail>;
  save(input: ExplorerFileWrite): Promise<ExplorerFile>;
  media(
    path: string,
    mediaType?: { kind: ExplorerMediaKind; mimeType: string },
  ): Promise<Blob>;
  binaryWrite?(
    content: BinaryWriteRequest,
    signal?: AbortSignal,
  ): Promise<BinaryWriteReceipt>;
  binary?(path: string, signal?: AbortSignal): Promise<BinaryFileSource>;
}

export function documentFileAccess(document: FileDocument): FileAccess {
  function requirePath(path: string) {
    if (path !== document.path)
      throw new Error("This view belongs to a different file document.");
  }
  return {
    cacheKey: `file-document:${document.id}`,
    async binaryWrite(content, signal) {
      requirePath(content.path);
      const result = await executeFileDocumentOperation(
        document.id,
        content,
        undefined,
        undefined,
        signal,
      );
      if (result.type !== "explorer.binary.write")
        throw new Error("Unexpected binary save result.");
      return result.value;
    },
    async binary(path, signal) {
      requirePath(path);
      const identity = getClientSessionIdentitySnapshot();
      const current = () => {
        if (!identity || !clientSessionIdentityMatches(identity))
          throw new Error("The binary document account changed.");
      };
      current();
      const source = await openProtectedBinarySource(
        path,
        async (offset, limit, version, requestSignal) => {
          const result = await executeFileDocumentOperation(
            document.id,
            { type: "explorer.binary.read", path, offset, limit, version },
            undefined,
            undefined,
            requestSignal,
          );
          if (result.type !== "explorer.binary")
            throw new Error("Unexpected binary result.");
          return result.value;
        },
        signal,
        current,
      );
      let off = () => {};
      const close = () => {
        off();
        signal?.removeEventListener("abort", close);
        source.close();
      };
      off = onClientSessionIdentityChanged(() => {
        if (!identity || !clientSessionIdentityMatches(identity)) close();
      });
      signal?.addEventListener("abort", close, { once: true });
      if (signal?.aborted) close();
      return { ...source, close };
    },
    async read(path) {
      requirePath(path);
      const result = await executeFileDocumentOperation(document.id, {
        type: "explorer.file.read",
        path,
      });
      if (result.type !== "explorer.file")
        throw new Error("Unexpected file result.");
      return result.value;
    },
    async preview(path, offset, version) {
      requirePath(path);
      const result = await executeFileDocumentOperation(document.id, {
        type: "explorer.file.preview",
        path,
        offset,
        version,
      });
      if (result.type !== "explorer.file.preview")
        throw new Error("Unexpected text preview result.");
      return result.value;
    },
    async tail(path, cursor) {
      requirePath(path);
      const result = await executeFileDocumentOperation(document.id, {
        type: "explorer.file.tail",
        path,
        cursor,
      });
      if (result.type !== "explorer.file.tail")
        throw new Error("Unexpected log tail result.");
      return result.value;
    },
    async save(input) {
      requirePath(input.path);
      const result = await executeFileDocumentOperation(document.id, {
        type: "explorer.file.write",
        ...input,
      });
      if (result.type !== "explorer.file")
        throw new Error("Unexpected file result.");
      return result.value;
    },
    async media(path, mediaType) {
      requirePath(path);
      return loadProtectedFileMedia(
        path,
        (content, operationId, sequence) =>
          executeFileDocumentOperation(
            document.id,
            content,
            operationId,
            sequence,
          ),
        mediaType,
      );
    },
  };
}
