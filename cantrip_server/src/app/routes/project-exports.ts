import {
  projectExportCreateSchema,
  projectExportPreviewRequestSchema,
  projectExportPreviewSchema,
  projectExportResultSchema,
  projectExportTargetInspectionSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import {
  exportCanonicalChat,
  projectExportTargetDefinition,
} from "../../project-exports/service.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ProjectExportRouteDependencies {
  applicationOwnerId: () => string;
  bridge: WorkerCommandBus;
  repository: ServerRepository;
}

export function installProjectExportRoutes(
  app: FastifyInstance,
  { applicationOwnerId, bridge, repository }: ProjectExportRouteDependencies,
): void {
  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/exports/preview",
    async (request, reply) => {
      const input = projectExportPreviewRequestSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      const context = await repository.getProjectWorktreeContext(
        ownerId,
        request.params.projectId,
        input.data.worktreeId,
      );
      if (!context) {
        return reply
          .code(404)
          .send({ error: "Project worktree was not found or is not ready." });
      }
      const worker = (await repository.listWorkers(ownerId)).find(
        (candidate) => candidate.workerId === context.workerId,
      );
      if (!worker) {
        return reply.code(404).send({ error: "Project worker was not found." });
      }
      const definition = projectExportTargetDefinition(input.data.target);
      let inspection;
      if (
        definition.requiredWorkerCapability === "externalCodexHistory" &&
        !worker.externalCodexHistory
      ) {
        inspection = {
          target: input.data.target,
          available: false,
          destinationLabel: null,
          message: `${worker.name} does not support local Codex project exports.`,
          platform: worker.platform,
        };
      } else if (!worker.online || !bridge.isConnected(worker.workerId)) {
        inspection = {
          target: input.data.target,
          available: false,
          destinationLabel: null,
          message: `${worker.name} is offline.`,
          platform: worker.platform,
        };
      } else {
        try {
          inspection = projectExportTargetInspectionSchema.parse(
            await bridge.request(
              worker.workerId,
              {
                type: "project.export.target.inspect",
                target: input.data.target,
                cwd: context.worktree.path,
              },
              { timeoutMs: 30_000 },
            ),
          );
        } catch (error) {
          inspection = {
            target: input.data.target,
            available: false,
            destinationLabel: null,
            message: errorMessage(error).slice(0, 2_000),
            platform: worker.platform,
          };
        }
      }
      return reply.send(
        projectExportPreviewSchema.parse({
          target: input.data.target,
          targetLabel: definition.label,
          available: inspection.available,
          destinationLabel: inspection.destinationLabel,
          message: inspection.message,
          worker: {
            workerId: worker.workerId,
            name: worker.name,
            platform: inspection.platform,
          },
          worktree: {
            worktreeId: context.worktree.id,
            name: context.worktree.name,
            displayPath: context.worktree.displayPath,
          },
          maxChats: definition.maxChats,
          supportedChatExperiences: definition.supportedChatExperiences,
          preserves: definition.preserves,
          flattens: definition.flattens,
        }),
      );
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/exports",
    async (request, reply) => {
      const input = projectExportCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      const context = await repository.getProjectWorktreeContext(
        ownerId,
        request.params.projectId,
        input.data.worktreeId,
      );
      if (!context) {
        return reply
          .code(404)
          .send({ error: "Project worktree was not found or is not ready." });
      }
      const worker = (await repository.listWorkers(ownerId)).find(
        (candidate) => candidate.workerId === context.workerId,
      );
      if (!worker) {
        return reply.code(404).send({ error: "Project worker was not found." });
      }
      const definition = projectExportTargetDefinition(input.data.target);
      if (
        definition.requiredWorkerCapability === "externalCodexHistory" &&
        !worker.externalCodexHistory
      ) {
        return reply
          .code(409)
          .send({ error: "The selected worker cannot export to Codex." });
      }
      if (!worker.online || !bridge.isConnected(worker.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      const chatsById = new Map(
        (await repository.listChats(ownerId, request.params.projectId)).map(
          (chat) => [chat.id, chat],
        ),
      );
      const selectedChats = input.data.chatIds.map((chatId) =>
        chatsById.get(chatId),
      );
      if (selectedChats.some((chat) => !chat)) {
        return reply
          .code(404)
          .send({ error: "One or more selected chats were not found." });
      }
      const unsupported = selectedChats.find(
        (chat) =>
          chat &&
          !definition.supportedChatExperiences.includes(chat.experience),
      );
      if (unsupported) {
        return reply.code(409).send({
          error:
            "The selected export target does not support one or more chat types.",
        });
      }
      const active = selectedChats.find(
        (chat) =>
          chat?.status === "running" || chat?.status === "waiting-for-approval",
      );
      if (active) {
        return reply.code(409).send({
          error: "Wait for selected chats to finish before exporting them.",
        });
      }
      const outcomes = [];
      for (const chat of selectedChats) {
        if (!chat) continue;
        try {
          const messages = await repository.listEncryptedMessages(
            ownerId,
            chat.id,
          );
          const exported = await exportCanonicalChat({
            bridge,
            operationId: input.data.operationId,
            target: input.data.target,
            workerId: worker.workerId,
            chatId: chat.id,
            cwd: context.worktree.path,
            titleProtection: chat.titleProtection,
            payload: {
              version: 1,
              kind: "chat-encrypted",
              messages,
              attachments: [],
            },
          });
          outcomes.push({ status: "exported" as const, ...exported });
        } catch (error) {
          const message = errorMessage(error).slice(0, 2_000);
          const normalized = message.toLowerCase();
          const code = /encrypt|decrypt|key revision|private label/iu.test(
            normalized,
          )
            ? ("encryption-unavailable" as const)
            : /external codex home|export target|worktree|worker is offline/iu.test(
                  normalized,
                )
              ? ("target-unavailable" as const)
              : /codex|thread\/(?:start|inject_items|read|name)|runtime/iu.test(
                    normalized,
                  )
                ? ("runtime-incompatible" as const)
                : ("worker-error" as const);
          outcomes.push({
            status: "failed" as const,
            chatId: chat.id,
            code,
            message: message || "Could not export this chat.",
          });
        }
      }
      return reply.send(
        projectExportResultSchema.parse({
          operationId: input.data.operationId,
          target: input.data.target,
          workerId: worker.workerId,
          worktreeId: context.worktree.id,
          outcomes,
        }),
      );
    },
  );
}
