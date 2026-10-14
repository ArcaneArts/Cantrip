import {
  openWorkerAttachmentMetadata,
  openWorkerAttachmentChunk,
  protectWorkerAttachmentChunk,
} from "../attachment-encryption.js";
import { clearSensitiveBytes } from "@cantrip/crypto";
import type { WorkerCommand } from "@cantrip/protocol";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import type { AttachmentStore } from "../attachment-store.js";

export type AttachmentCommand = Extract<
  WorkerCommand,
  {
    type:
      | "attachment.upload.begin"
      | "attachment.upload.chunk"
      | "attachment.upload.complete"
      | "attachment.read"
      | "attachment.delete";
  }
>;
export interface AttachmentCommandDependencies {
  workerEncryption: WorkerEncryptionService;
  attachments: Pick<
    AttachmentStore,
    "begin" | "append" | "complete" | "read" | "remove"
  >;
}

// Services are owned by the worker entry point; this handler only executes commands.
export async function handleAttachmentCommand(
  command: AttachmentCommand,
  dependencies: AttachmentCommandDependencies,
): Promise<unknown> {
  const { workerEncryption, attachments } = dependencies;
  switch (command.type) {
    case "attachment.upload.begin": {
      const metadata = await openWorkerAttachmentMetadata({
        chatId: command.chatId,
        attachmentId: command.attachmentId,
        protectedMetadata: command.protectedMetadata,
        service: workerEncryption,
      });
      if (metadata.error !== null) {
        throw new Error("Unavailable attachment metadata cannot be uploaded.");
      }
      await attachments.begin(
        command.chatId,
        command.attachmentId,
        metadata.fileName,
        command.sizeBytes,
        command.operationId,
        metadata.sha256,
      );
      return { accepted: true };
    }
    case "attachment.upload.chunk": {
      const bytes = await openWorkerAttachmentChunk({
        chatId: command.chatId,
        attachmentId: command.attachmentId,
        operationId: command.operationId,
        direction: command.direction,
        chunk: command.chunk,
        service: workerEncryption,
      });
      try {
        await attachments.append(
          command.chatId,
          command.attachmentId,
          command.chunk.sequence,
          bytes,
          command.operationId,
          command.chunk.eof,
        );
        return { accepted: true };
      } finally {
        clearSensitiveBytes(bytes);
      }
    }
    case "attachment.upload.complete":
      return attachments.complete(
        command.chatId,
        command.attachmentId,
        command.operationId,
      );
    case "attachment.read": {
      const metadata = await openWorkerAttachmentMetadata({
        chatId: command.chatId,
        attachmentId: command.attachmentId,
        protectedMetadata: command.protectedMetadata,
        service: workerEncryption,
      });
      const result = await attachments.read(
        command.chatId,
        command.attachmentId,
        metadata.fileName,
        command.offset,
        command.limit,
      );
      try {
        return {
          chunk: await protectWorkerAttachmentChunk({
            chatId: command.chatId,
            attachmentId: command.attachmentId,
            operationId: command.operationId,
            direction: command.direction,
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
    case "attachment.delete":
      await attachments.remove(command.chatId, command.attachmentId);
      return { accepted: true };
  }
}
