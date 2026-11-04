import {
  BinaryFileWrites,
  BinaryWriteConflictError,
} from "../binary-file-writes.js";
import { type SurfaceOperationOutcomeContent } from "@cantrip/protocol/surface-stream";
import {
  listExplorerDirectory,
  searchExplorerFiles,
  listExplorerDirectoryCommits,
  readExplorerFile,
  readExplorerBinaryFile,
  readExplorerLogTail,
  readExplorerTextPreview,
  writeExplorerFile,
  createExplorerDirectory,
  createExplorerFile,
  renameExplorerEntry,
  deleteExplorerEntry,
  readExplorerMediaFile,
} from "../explorer.js";
import { BinaryFileChangedError } from "../explorer-binary.js";
import { TextPreviewRequiredError } from "../explorer-text-preview.js";
import type { ExplorerOperationRequestContent } from "@cantrip/protocol/surface-stream";
import type { ExplorerFileImports } from "../explorer-file-imports.js";
export interface ExplorerRequestServices {
  fileImports: ExplorerFileImports;
  binaryWrites?: BinaryFileWrites;
}
export interface ExplorerRequestContext {
  serverId: string;
  surfaceKind: "explorer" | "file-document";
  surfaceId: string;
  operationId: string;
  sequence: number;
}
/** Application file semantics shared by the owning worker and optional guest helper. */
export async function executeExplorerRequest(
  root: string,
  request: ExplorerOperationRequestContent,
  dependencies: ExplorerRequestServices,
  context: ExplorerRequestContext,
) {
  let outcome: SurfaceOperationOutcomeContent;
  let complete = true;
  switch (request.type) {
    case "explorer.binary.write.begin":
    case "explorer.binary.write.chunk":
    case "explorer.binary.write.commit":
    case "explorer.binary.write.status":
    case "explorer.binary.write.abort": {
      if (!dependencies.binaryWrites)
        throw new Error("This worker does not support streamed binary saves.");
      const value = await dependencies.binaryWrites.execute(
        {
          serverId: context.serverId,
          surfaceKind: context.surfaceKind,
          surfaceId: context.surfaceId,
          root: root,
        },
        request,
      );
      outcome = {
        ok: true,
        result: { type: "explorer.binary.write", value },
      };
      break;
    }
    case "explorer.file.import": {
      const value = await dependencies.fileImports.write(
        JSON.stringify([
          context.serverId,
          context.surfaceId,
          context.operationId,
        ]),
        root,
        context.sequence,
        request,
      );
      complete = request.eof;
      outcome = {
        ok: true,
        result: { type: "explorer.file.imported", value },
      };
      break;
    }
    case "explorer.file.import.cancel":
      await dependencies.fileImports.cancel(
        JSON.stringify([
          context.serverId,
          context.surfaceId,
          context.operationId,
        ]),
      );
      outcome = {
        ok: true,
        result: {
          type: "explorer.file.imported",
          value: { offset: 0, entry: null },
        },
      };
      break;
    case "explorer.directory.list":
      outcome = {
        ok: true as const,
        result: {
          type: request.type,
          value: await listExplorerDirectory(root, request.path),
        },
      };
      break;
    case "explorer.files.search":
      outcome = {
        ok: true as const,
        result: {
          type: request.type,
          value: await searchExplorerFiles(root, request.query, request.limit),
        },
      };
      break;
    case "explorer.directory.commits":
      outcome = {
        ok: true as const,
        result: {
          type: request.type,
          value: await listExplorerDirectoryCommits(root, request.path),
        },
      };
      break;
    case "explorer.binary.read":
      outcome = {
        ok: true,
        result: {
          type: "explorer.binary",
          value: await readExplorerBinaryFile(
            root,
            request.path,
            request.offset,
            request.limit,
            request.version,
          ),
        },
      };
      break;
    case "explorer.file.read":
      outcome = {
        ok: true as const,
        result: {
          type: "explorer.file" as const,
          value: await readExplorerFile(root, request.path),
        },
      };
      break;
    case "explorer.file.tail":
      outcome = {
        ok: true,
        result: {
          type: "explorer.file.tail",
          value: await readExplorerLogTail(root, request.path, request.cursor),
        },
      };
      break;
    case "explorer.file.preview":
      outcome = {
        ok: true,
        result: {
          type: "explorer.file.preview",
          value: await readExplorerTextPreview(
            root,
            request.path,
            request.offset,
            request.version,
          ),
        },
      };
      break;
    case "explorer.file.write":
      outcome = {
        ok: true as const,
        result: {
          type: "explorer.file" as const,
          value: await writeExplorerFile(
            root,
            request.path,
            request.content,
            request.version,
          ),
        },
      };
      break;
    case "explorer.file.create":
      outcome = {
        ok: true as const,
        result: {
          type: "explorer.file.created" as const,
          value: await createExplorerFile(root, request.path, request.name),
        },
      };
      break;
    case "explorer.directory.create":
      outcome = {
        ok: true as const,
        result: {
          type: "explorer.directory.created" as const,
          value: await createExplorerDirectory(root, request.path),
        },
      };
      break;
    case "explorer.entry.rename":
      outcome = {
        ok: true as const,
        result: {
          type: "explorer.entry.mutated" as const,
          value: await renameExplorerEntry(root, request.path, request.name),
        },
      };
      break;
    case "explorer.entry.delete":
      outcome = {
        ok: true as const,
        result: {
          type: "explorer.entry.mutated" as const,
          value: await deleteExplorerEntry(root, request.path),
        },
      };
      break;
    case "explorer.media.read": {
      const value = await readExplorerMediaFile(
        root,
        request.path,
        request.offset,
        request.limit,
        request.mediaType,
      );
      complete = value.eof;
      outcome = {
        ok: true as const,
        result: { type: "explorer.media" as const, value },
      };
      break;
    }
  }
  return { outcome, complete };
}

export function explorerRequestFailure(error: unknown): {
  outcome: SurfaceOperationOutcomeContent;
  complete: boolean;
} {
  return {
    complete: true,
    outcome: {
      ok: false,
      ...(error instanceof TextPreviewRequiredError
        ? { code: "text-preview-required" as const }
        : error instanceof BinaryFileChangedError ||
            error instanceof BinaryWriteConflictError
          ? { code: "file-version-changed" as const }
          : {}),
      error:
        error instanceof Error
          ? error.message.slice(0, 2000)
          : "Explorer operation failed.",
    },
  };
}

/** Unknown future operations keep durable mutation admission by default. */
export function explorerRequestMutates(
  request: ExplorerOperationRequestContent,
): boolean {
  return ![
    "explorer.directory.list",
    "explorer.files.search",
    "explorer.directory.commits",
    "explorer.binary.read",
    "explorer.file.read",
    "explorer.file.preview",
    "explorer.file.tail",
    "explorer.media.read",
    "explorer.binary.write.status",
  ].includes(request.type);
}
