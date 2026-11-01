import type { ExplorerTextPreviewPage } from "@cantrip/protocol/surface-stream";
import type { ExplorerFile, ExplorerFileWrite } from "@cantrip/protocol";
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
  save(input: ExplorerFileWrite): Promise<ExplorerFile>;
  media(path: string): Promise<Blob>;
}

export function documentFileAccess(document: FileDocument): FileAccess {
  function requirePath(path: string) {
    if (path !== document.path)
      throw new Error("This view belongs to a different file document.");
  }
  return {
    cacheKey: `file-document:${document.id}`,
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
    async media(path) {
      requirePath(path);
      return loadProtectedFileMedia(path, (content, operationId, sequence) =>
        executeFileDocumentOperation(
          document.id,
          content,
          operationId,
          sequence,
        ),
      );
    },
  };
}
