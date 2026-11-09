import {
  workerAttachmentReadResultSchema,
  workerAttachmentUploadResultSchema,
} from "@cantrip/protocol";
import {
  attachmentDownloadOpaqueSchema,
  attachmentUploadOpaqueSchema,
} from "@cantrip/protocol/attachment-content";
import type { FastifyInstance } from "fastify";

import {
  toChatAttachmentOpaqueSummary,
  type ServerRepository,
} from "../../db/repository.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { RelayQuotaManager } from "../../operations/relay-quotas.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { ATTACHMENT_CHUNK_BYTES } from "../shared/constants.js";

export interface ChatAttachmentRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  encryptedAttachmentUploadLimitBytes: number;
  relayQuotas: Pick<RelayQuotaManager, "consumeUpload">;
  repository: Pick<
    ServerRepository,
    | "createChatAttachment"
    | "deleteChatAttachment"
    | "getChatAttachment"
    | "getChatAttachmentReplicaWorkerIds"
    | "getChatExecutionContext"
  >;
  uploadLimitBytes: number;
}

/** Registers protected Chat attachment upload, download, and removal routes. */
export function installChatAttachmentRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    encryptedAttachmentUploadLimitBytes,
    relayQuotas,
    repository,
    uploadLimitBytes,
  }: ChatAttachmentRouteDependencies,
): void {
  app.post<{ Body: Buffer; Params: { chatId: string } }>(
    "/api/chats/:chatId/attachments",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      let raw: unknown;
      try {
        raw = JSON.parse(
          Buffer.isBuffer(request.body) ? request.body.toString("utf8") : "",
        );
      } catch {
        raw = null;
      }
      const input = attachmentUploadOpaqueSchema.safeParse(raw);
      if (
        !input.success ||
        !Buffer.isBuffer(request.body) ||
        request.body.byteLength > encryptedAttachmentUploadLimitBytes ||
        input.data.sizeBytes > uploadLimitBytes
      ) {
        return reply.code(400).send({ error: "Invalid attachment upload." });
      }

      const attachmentId = input.data.attachmentId;
      if (
        await repository.getChatAttachment(applicationOwnerId(), attachmentId)
      ) {
        return reply.code(409).send({ error: "Attachment already exists." });
      }
      relayQuotas.consumeUpload(
        applicationOwnerId(),
        context.workerId,
        input.data.sizeBytes,
      );
      try {
        await bridge.request(context.workerId, {
          type: "attachment.upload.begin",
          chatId: context.chatId,
          attachmentId,
          operationId: input.data.operationId,
          direction: "upload",
          protectedMetadata: input.data.protectedMetadata,
          sizeBytes: input.data.sizeBytes,
        });
        for (const chunk of input.data.chunks) {
          await bridge.request(context.workerId, {
            type: "attachment.upload.chunk",
            chatId: context.chatId,
            attachmentId,
            operationId: input.data.operationId,
            direction: "upload",
            chunk,
          });
        }
        const uploaded = workerAttachmentUploadResultSchema.parse(
          await bridge.request(context.workerId, {
            type: "attachment.upload.complete",
            chatId: context.chatId,
            attachmentId,
            operationId: input.data.operationId,
          }),
        );
        if (uploaded.sizeBytes !== input.data.sizeBytes || !uploaded.verified) {
          throw new Error("Attachment worker rejected the protected upload.");
        }
        const attachment = await repository.createChatAttachment(
          applicationOwnerId(),
          context.chatId,
          {
            id: attachmentId,
            workerId: context.workerId,
            protectedMetadata: input.data.protectedMetadata,
            sizeBytes: uploaded.sizeBytes,
          },
        );
        if (!attachment) throw new Error("Chat not found.");
        return reply.code(201).send(toChatAttachmentOpaqueSummary(attachment));
      } catch (error) {
        try {
          await bridge.request(context.workerId, {
            type: "attachment.delete",
            chatId: context.chatId,
            attachmentId,
          });
        } catch {
          // Cleanup is best effort if the worker disconnected mid-upload.
        }
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.get<{
    Params: { attachmentId: string };
    Querystring: { operationId?: string };
  }>("/api/attachments/:attachmentId/content", async (request, reply) => {
    const attachment = await repository.getChatAttachment(
      applicationOwnerId(),
      request.params.attachmentId,
    );
    if (!attachment) {
      return reply.code(404).send({ error: "Attachment not found." });
    }
    if (attachment.status === "failed") {
      return reply.code(409).send({
        error: "The attachment content is unavailable.",
      });
    }
    const operationId = request.query.operationId?.trim() ?? "";
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        operationId,
      )
    ) {
      return reply.code(400).send({ error: "Invalid attachment operation." });
    }
    const replicaWorkerIds = await repository.getChatAttachmentReplicaWorkerIds(
      applicationOwnerId(),
      attachment.id,
    );
    const contentWorkerId = [attachment.workerId, ...replicaWorkerIds].find(
      (workerId, index, workerIds) => {
        return (
          workerIds.indexOf(workerId) === index && bridge.isConnected(workerId)
        );
      },
    );
    if (!contentWorkerId) {
      return reply.code(503).send({ error: "Attachment worker is offline." });
    }
    try {
      const chunks = [];
      let offset = 0;
      let sequence = 0;
      const expectedSize = attachment.sizeBytes;
      while (offset < expectedSize || (expectedSize === 0 && offset === 0)) {
        const chunk = workerAttachmentReadResultSchema.parse(
          await bridge.request(contentWorkerId, {
            type: "attachment.read",
            chatId: attachment.chatId,
            attachmentId: attachment.id,
            operationId,
            direction: "download",
            protectedMetadata: attachment.protectedMetadata,
            sequence,
            offset,
            limit: ATTACHMENT_CHUNK_BYTES,
          }),
        );
        if (chunk.sizeBytes !== expectedSize) {
          throw new Error(
            "Attachment worker returned an inconsistent content size.",
          );
        }
        const remainingBytes = expectedSize - offset;
        const maximumChunkBytes = Math.min(
          ATTACHMENT_CHUNK_BYTES,
          Math.max(remainingBytes, 0),
        );
        if (
          chunk.chunk.sequence !== sequence ||
          chunk.chunk.plaintextBytes > maximumChunkBytes
        ) {
          throw new Error("Attachment worker returned an oversized chunk.");
        }
        chunks.push(chunk.chunk);
        offset += chunk.chunk.plaintextBytes;
        sequence += 1;
        if (chunk.chunk.eof) {
          if (offset !== expectedSize) {
            throw new Error("Attachment content was truncated.");
          }
          break;
        }
        if (offset === expectedSize) {
          throw new Error(
            "Attachment worker did not terminate the content stream.",
          );
        }
        if (chunk.chunk.plaintextBytes === 0) {
          throw new Error("Attachment worker returned an empty chunk.");
        }
      }
      return reply.header("cache-control", "no-store").send(
        attachmentDownloadOpaqueSchema.parse({
          attachmentId: attachment.id,
          operationId,
          sizeBytes: attachment.sizeBytes,
          protectedMetadata: attachment.protectedMetadata,
          chunks,
        }),
      );
    } catch (error) {
      return sendWorkerRequestFailure(reply, error);
    }
  });

  app.delete<{ Params: { attachmentId: string } }>(
    "/api/attachments/:attachmentId",
    async (request, reply) => {
      const attachment = await repository.getChatAttachment(
        applicationOwnerId(),
        request.params.attachmentId,
      );
      if (!attachment) {
        return reply.code(404).send({ error: "Attachment not found." });
      }
      const replicaWorkerIds =
        await repository.getChatAttachmentReplicaWorkerIds(
          applicationOwnerId(),
          attachment.id,
        );
      await Promise.all(
        [attachment.workerId, ...replicaWorkerIds]
          .filter(
            (workerId, index, workerIds) =>
              workerIds.indexOf(workerId) === index &&
              bridge.isConnected(workerId),
          )
          .map((workerId) =>
            bridge.request(workerId, {
              type: "attachment.delete",
              chatId: attachment.chatId,
              attachmentId: attachment.id,
            }),
          ),
      );
      await repository.deleteChatAttachment(
        applicationOwnerId(),
        attachment.id,
      );
      return reply.code(204).send();
    },
  );
}
