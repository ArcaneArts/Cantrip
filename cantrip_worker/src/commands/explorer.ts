import {
  type SurfaceOperationOutcomeContent,
  explorerOperationRequestContentSchema,
  surfaceOperationOutcomeContentSchema,
  surfaceStreamWireResponseSchema,
} from "@cantrip/protocol/surface-stream";
import {
  openWorkerSurfaceStreamContent,
  protectWorkerSurfaceStreamContent,
} from "../surface-stream-encryption.js";
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
import type { WorkerCommand } from "@cantrip/protocol";
import type { SurfaceStreamReplayGuard } from "../surface-stream-encryption.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import { decodeSurfacePrivateStateForWorker } from "../surface-private-state-encryption.js";
import { fileDocumentPrivateStateProtectedContentSchema } from "@cantrip/protocol/surface-private-state";
import type { ExplorerFileImports } from "../explorer-file-imports.js";

export type ExplorerCommand = Extract<
  WorkerCommand,
  { type: "explorer.operation" | "file-document.operation" }
>;
export interface ExplorerCommandDependencies {
  fileImports: ExplorerFileImports;
  surfaceStreamReplay: Pick<SurfaceStreamReplayGuard, "reserve" | "accept">;
  workerEncryption: WorkerEncryptionService;
}

// Services are owned by the worker entry point; this handler only executes commands.
export async function handleExplorerCommand(
  command: ExplorerCommand,
  dependencies: ExplorerCommandDependencies,
): Promise<unknown> {
  const { surfaceStreamReplay, workerEncryption } = dependencies;
  switch (command.type) {
    case "explorer.operation":
    case "file-document.operation": {
      const streamContext = {
        serverId: command.serverId,
        surfaceKind:
          command.type === "explorer.operation"
            ? ("explorer" as const)
            : ("file-document" as const),
        surfaceId:
          command.type === "explorer.operation"
            ? command.explorerId
            : command.documentId,
        operationId: command.operationId,
        direction: "request" as const,
        sequence: command.sequence,
      };
      surfaceStreamReplay.reserve(streamContext);
      const request = await openWorkerSurfaceStreamContent({
        context: streamContext,
        opaque: command.protectedRequest,
        schema: explorerOperationRequestContentSchema,
        service: workerEncryption,
      });
      let outcome: SurfaceOperationOutcomeContent;
      let complete = true;
      try {
        if (command.type === "file-document.operation") {
          const location = fileDocumentPrivateStateProtectedContentSchema.parse(
            await decodeSurfacePrivateStateForWorker({
              ownerId: workerEncryption.ownerId(),
              context: {
                serverId: command.serverId,
                resource: "file-document-row",
                resourceId: command.documentId,
                operationId: null,
                recordKind: "file-document-state",
              },
              opaque: command.stateProtection,
              service: workerEncryption,
            }),
          );
          if (
            location.projectId !== command.projectId ||
            location.worktreeId !== command.worktreeId ||
            location.workerId !== command.workerId
          ) {
            throw new Error("File document checkout binding does not match.");
          }
          if (
            (request.type !== "explorer.binary.read" &&
              request.type !== "explorer.file.read" &&
              request.type !== "explorer.file.preview" &&
              request.type !== "explorer.file.tail" &&
              request.type !== "explorer.file.write" &&
              request.type !== "explorer.media.read") ||
            request.path !== location.path
          ) {
            throw new Error(
              "The operation does not target this file document.",
            );
          }
        }
        switch (request.type) {
          case "explorer.file.import": {
            const value = await dependencies.fileImports.write(
              JSON.stringify([
                command.serverId,
                streamContext.surfaceId,
                command.operationId,
              ]),
              command.root,
              command.sequence,
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
                command.serverId,
                streamContext.surfaceId,
                command.operationId,
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
                value: await listExplorerDirectory(command.root, request.path),
              },
            };
            break;
          case "explorer.files.search":
            outcome = {
              ok: true as const,
              result: {
                type: request.type,
                value: await searchExplorerFiles(
                  command.root,
                  request.query,
                  request.limit,
                ),
              },
            };
            break;
          case "explorer.directory.commits":
            outcome = {
              ok: true as const,
              result: {
                type: request.type,
                value: await listExplorerDirectoryCommits(
                  command.root,
                  request.path,
                ),
              },
            };
            break;
          case "explorer.binary.read":
            outcome = {
              ok: true,
              result: {
                type: "explorer.binary",
                value: await readExplorerBinaryFile(
                  command.root,
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
                value: await readExplorerFile(command.root, request.path),
              },
            };
            break;
          case "explorer.file.tail":
            outcome = {
              ok: true,
              result: {
                type: "explorer.file.tail",
                value: await readExplorerLogTail(
                  command.root,
                  request.path,
                  request.cursor,
                ),
              },
            };
            break;
          case "explorer.file.preview":
            outcome = {
              ok: true,
              result: {
                type: "explorer.file.preview",
                value: await readExplorerTextPreview(
                  command.root,
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
                  command.root,
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
                value: await createExplorerFile(
                  command.root,
                  request.path,
                  request.name,
                ),
              },
            };
            break;
          case "explorer.directory.create":
            outcome = {
              ok: true as const,
              result: {
                type: "explorer.directory.created" as const,
                value: await createExplorerDirectory(
                  command.root,
                  request.path,
                ),
              },
            };
            break;
          case "explorer.entry.rename":
            outcome = {
              ok: true as const,
              result: {
                type: "explorer.entry.mutated" as const,
                value: await renameExplorerEntry(
                  command.root,
                  request.path,
                  request.name,
                ),
              },
            };
            break;
          case "explorer.entry.delete":
            outcome = {
              ok: true as const,
              result: {
                type: "explorer.entry.mutated" as const,
                value: await deleteExplorerEntry(command.root, request.path),
              },
            };
            break;
          case "explorer.media.read": {
            const value = await readExplorerMediaFile(
              command.root,
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
      } catch (error) {
        outcome = {
          ok: false as const,
          ...(error instanceof TextPreviewRequiredError
            ? { code: "text-preview-required" as const }
            : error instanceof BinaryFileChangedError
              ? { code: "file-version-changed" as const }
              : {}),
          error:
            error instanceof Error
              ? error.message.slice(0, 2_000)
              : "Explorer operation failed.",
        };
      }
      const protectedResponse = await protectWorkerSurfaceStreamContent({
        context: { ...streamContext, direction: "response" },
        content: outcome,
        schema: surfaceOperationOutcomeContentSchema,
        service: workerEncryption,
      });
      surfaceStreamReplay.accept(streamContext, complete || !outcome.ok);
      return surfaceStreamWireResponseSchema.parse({
        operationId: command.operationId,
        sequence: command.sequence,
        protectedResponse,
      });
    }
  }
}
