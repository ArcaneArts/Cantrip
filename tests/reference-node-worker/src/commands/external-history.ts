import {
  discoverExternalChatHistory,
  readExternalChatHistory,
} from "../external-chat-history.js";
import { protectWorkerAttachmentChunk } from "../attachment-encryption.js";
import { clearSensitiveBytes } from "@cantrip/crypto";
import type { WorkerCommand } from "@cantrip/protocol";
import type { ExternalChatAttachmentStagingStore } from "../external-chat-attachments.js";
import type { WorkerConfig } from "../config.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";

export type ExternalHistoryCommand = Extract<
  WorkerCommand,
  {
    type:
      | "external.chat-history.discover"
      | "external.chat-history.read"
      | "external.chat-history.attachment.read"
      | "external.chat-history.attachments.release";
  }
>;
export interface ExternalHistoryCommandDependencies {
  externalChatAttachments: ExternalChatAttachmentStagingStore;
  config: Pick<WorkerConfig, "codexBinary" | "dataDirectory">;
  workerEncryption: WorkerEncryptionService;
}

// Services are owned by the worker entry point; this handler only executes commands.
export async function handleExternalHistoryCommand(
  command: ExternalHistoryCommand,
  dependencies: ExternalHistoryCommandDependencies,
): Promise<unknown> {
  const { externalChatAttachments, config, workerEncryption } = dependencies;
  switch (command.type) {
    case "external.chat-history.discover":
      return discoverExternalChatHistory(
        {
          attachmentStore: externalChatAttachments,
          binary: config.codexBinary,
          managedDataDirectory: config.dataDirectory,
        },
        command,
      );
    case "external.chat-history.read":
      return readExternalChatHistory(
        {
          attachmentStore: externalChatAttachments,
          binary: config.codexBinary,
          encryptionService: workerEncryption,
          managedDataDirectory: config.dataDirectory,
        },
        command,
      );
    case "external.chat-history.attachment.read": {
      if (command.ownerId !== workerEncryption.ownerId()) {
        throw new Error("Attachment owner does not match this worker.");
      }
      const result = await externalChatAttachments.read(
        command.sourceId,
        command.sourceThreadId,
        command.attachmentId,
        command.offset,
        command.limit,
      );
      if (result.status === "unavailable") return result;
      try {
        return {
          status: "available" as const,
          chunk: await protectWorkerAttachmentChunk({
            chatId: command.chatId,
            attachmentId: command.targetAttachmentId,
            operationId: command.operationId,
            direction: "relay",
            sequence: command.sequence,
            eof: result.eof,
            bytes: result.bytes,
            service: workerEncryption,
          }),
          sizeBytes: result.sizeBytes,
        };
      } finally {
        clearSensitiveBytes(result.bytes);
      }
    }
    case "external.chat-history.attachments.release":
      await externalChatAttachments.release(
        command.sourceId,
        command.sourceThreadId,
      );
      return { accepted: true };
  }
}
