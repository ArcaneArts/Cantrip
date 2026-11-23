import { workerLogger, workerLogError } from "../logger.js";
import { executeExplorerRequest } from "./explorer-request.js";
import {
  BinaryFileWrites,
  BinaryWriteConflictError,
} from "../binary-file-writes.js";
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
import { BinaryFileChangedError } from "../explorer-binary.js";
import { TextPreviewRequiredError } from "../explorer-text-preview.js";
import type { WorkerCommand, CantripOsExecution } from "@cantrip/protocol";
import type { ExplorerOperationRequestContent } from "@cantrip/protocol/surface-stream";
import type { ExplorerRequestContext } from "./explorer-request.js";
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
  osFiles?: {
    execute(
      root: CantripOsExecution,
      request: ExplorerOperationRequestContent,
      context: ExplorerRequestContext,
    ): Promise<{ outcome: SurfaceOperationOutcomeContent; complete: boolean }>;
  };
  fileImports: ExplorerFileImports;
  binaryWrites?: BinaryFileWrites;
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
            location.workerId !== command.workerId ||
            (typeof command.root !== "string" &&
              (command.root.scope.projectId !== location.projectId ||
                command.root.scope.worktreeId !== location.worktreeId))
          ) {
            throw new Error("File document checkout binding does not match.");
          }
          if (
            (request.type !== "explorer.binary.write.begin" &&
              request.type !== "explorer.binary.write.chunk" &&
              request.type !== "explorer.binary.write.commit" &&
              request.type !== "explorer.binary.write.status" &&
              request.type !== "explorer.binary.write.abort" &&
              request.type !== "explorer.binary.read" &&
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
        ({ outcome, complete } =
          typeof command.root === "string"
            ? await executeExplorerRequest(
                command.root,
                request,
                dependencies,
                streamContext,
              )
            : await (dependencies.osFiles?.execute(
                command.root,
                request,
                streamContext,
              ) ??
                Promise.reject(
                  new Error(
                    "This worker does not support CantripOS file operations.",
                  ),
                )));
      } catch (error) {
        if (typeof command.root !== "string")
          workerLogger.event("warn", "CantripOS file operation failed", {
            event: "os.files.operation-failed",
            subsystem: "cantrip-os",
            operation: request.type,
            status: "failed",
            error: workerLogError(error),
          });
        outcome = {
          ok: false as const,
          ...(error instanceof TextPreviewRequiredError
            ? { code: "text-preview-required" as const }
            : error instanceof BinaryFileChangedError ||
                error instanceof BinaryWriteConflictError
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
