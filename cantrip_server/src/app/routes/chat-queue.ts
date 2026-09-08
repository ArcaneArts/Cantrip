import { NativeCommandError } from "../../db/repository/native-commands.js";
import { managedConsoleSessionContext } from "../../terminals/managed-session.js";
import {
  lookupManagedGuiQueue,
  mutateManagedGuiQueue,
} from "../runtime/managed-queue-input.js";
import { randomUUID, createHash } from "node:crypto";

import {
  encryptedChatPromptSteerResultSchema,
  encryptedQueuedPromptListSchema,
  encryptedQueuedPromptSchema,
  encryptedQueuedPromptUpdateSchema,
  queuedPromptOpaqueContentSchema,
  queuedPromptOrderSchema,
  type ChatMessageOpaqueSummary,
} from "@cantrip/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";

import { chatIsExecuting } from "../../chats/execution-helpers.js";
import {
  toChatAttachmentOpaqueSummary,
  type ChatExecutionContext,
  type ModelRuntime,
  type ServerRepository,
} from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import type { ChatTurnStarter } from "./chat-turn-contracts.js";

export interface ChatQueueRouteDependencies {
  appendLiveEncryptedChatMessage: (
    ...input: Parameters<ServerRepository["appendEncryptedMessage"]>
  ) => ReturnType<ServerRepository["appendEncryptedMessage"]>;
  applicationOwnerId: () => string;
  beginTurn: ChatTurnStarter;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  deleteLiveQueuedPrompt: (
    ...input: Parameters<ServerRepository["deleteQueuedPrompt"]>
  ) => ReturnType<ServerRepository["deleteQueuedPrompt"]>;
  dispatchNextQueuedPrompt: (chatId: string) => Promise<void>;
  reorderLiveQueuedPrompts: (
    ...input: Parameters<ServerRepository["reorderQueuedPrompts"]>
  ) => ReturnType<ServerRepository["reorderQueuedPrompts"]>;
  repository: Pick<
    ServerRepository,
    | "nativeCommands"
    | "managedQueue"
    | "createEncryptedQueuedPrompt"
    | "getChatExecutionContext"
    | "getEncryptedMessageByIdempotencyKey"
    | "getEncryptedQueuedPrompt"
    | "listEncryptedQueuedPrompts"
    | "replaceEncryptedQueuedPrompt"
    | "updateChatWorktree"
  >;
  resolveModelId: (
    context: ChatExecutionContext,
    requestedModelId?: string,
  ) => Promise<string>;
  resolvePromptAttachments: (
    context: ChatExecutionContext,
    attachmentIds: string[],
  ) => ReturnType<ServerRepository["getChatAttachments"]>;
  runtimeForContext: (
    context: ChatExecutionContext,
  ) => Promise<ModelRuntime | null>;
  sendModelConfigurationResolutionFailure: (
    reply: FastifyReply,
    error: unknown,
  ) => FastifyReply | null;
}

/** Registers encrypted queued-prompt lifecycle and steering routes. */
export function installChatQueueRoutes(
  app: FastifyInstance,
  {
    appendLiveEncryptedChatMessage,
    applicationOwnerId,
    beginTurn,
    bridge,
    deleteLiveQueuedPrompt,
    dispatchNextQueuedPrompt,
    reorderLiveQueuedPrompts,
    repository,
    resolveModelId,
    resolvePromptAttachments,
    runtimeForContext,
    sendModelConfigurationResolutionFailure,
  }: ChatQueueRouteDependencies,
): void {
  app.get<{ Params: { chatId: string; operationId: string } }>(
    "/api/chats/:chatId/queue/operations/:operationId",
    async (request, reply) => {
      try {
        return await repository.managedQueue.guiOperation(
          applicationOwnerId(),
          request.params.chatId,
          request.params.operationId,
        );
      } catch (error) {
        if (error instanceof NativeCommandError)
          return reply.code(error.statusCode).send({ code: error.code });
        throw error;
      }
    },
  );
  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/queue",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (context?.experience === "task") {
        return reply.code(409).send({
          error: "Queued prompts are unavailable for encrypted Tasks.",
        });
      }
      if (context && managedConsoleSessionContext(context)) {
        const { revision, items, pendingImports, claims } =
          await repository.managedQueue.snapshot(
            applicationOwnerId(),
            context.chatId,
          );
        return reply.send({ revision, items, pendingImports, claims });
      }
      return reply.send(
        encryptedQueuedPromptListSchema.parse(
          await repository.listEncryptedQueuedPrompts(
            applicationOwnerId(),
            request.params.chatId,
          ),
        ),
      );
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/queue",
    async (request, reply) => {
      const input = queuedPromptOpaqueContentSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      if (context.experience === "task") {
        return reply.code(409).send({
          error: "Queued prompts are unavailable for encrypted Tasks.",
        });
      }
      let modelId: string;
      let attachments: Awaited<ReturnType<typeof resolvePromptAttachments>>;
      try {
        modelId = await resolveModelId(context, input.data.modelId);
        attachments = await resolvePromptAttachments(
          context,
          input.data.classification.attachmentIds,
        );
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
      if (modelId !== input.data.modelId) {
        return reply.code(409).send({ error: "Selected model was not found." });
      }
      const managed = managedConsoleSessionContext(context) !== undefined;
      let prompt;
      try {
        prompt = managed
          ? ((
              await mutateManagedGuiQueue(
                repository,
                applicationOwnerId(),
                context,
                {
                  kind: "add",
                  prompt: input.data,
                  attachments: attachments.map(toChatAttachmentOpaqueSummary),
                },
                {
                  operationId: `gui-queue:add:${context.chatId}:${input.data.id}`,
                },
              )
            ).acceptedItem ??
            (await repository.getEncryptedQueuedPrompt(
              applicationOwnerId(),
              input.data.id,
            )))
          : await repository.createEncryptedQueuedPrompt(
              applicationOwnerId(),
              context.chatId,
              input.data,
              attachments.map(toChatAttachmentOpaqueSummary),
            );
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
      if (!prompt) return reply.code(404).send({ error: "Chat not found." });
      app.log.info(
        {
          event: "chat.queue.enqueued",
          subsystem: "chat-queue",
          operation: "enqueue-prompt",
          status: prompt.frozen ? "frozen" : "queued",
          chatId: context.chatId,
          requestId: prompt.id,
          counts: { attachments: prompt.attachments.length },
        },
        "Chat prompt queued",
      );
      if (!prompt.frozen) void dispatchNextQueuedPrompt(context.chatId);
      return reply.code(201).send(encryptedQueuedPromptSchema.parse(prompt));
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/queue/order",
    async (request, reply) => {
      const input = queuedPromptOrderSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (context && managedConsoleSessionContext(context)) {
        if (
          input.data.expectedRevision === undefined ||
          !input.data.operationId
        )
          return reply.code(409).send({ code: "queue-revision-required" });
        try {
          await mutateManagedGuiQueue(
            repository,
            applicationOwnerId(),
            context,
            { kind: "reorder", ids: input.data.ids },
            {
              operationId: input.data.operationId,
              expectedRevision: input.data.expectedRevision,
            },
          );
          return reply.code(204).send();
        } catch (error) {
          return reply.code(409).send({ error: errorMessage(error) });
        }
      }
      const reordered = await reorderLiveQueuedPrompts(
        applicationOwnerId(),
        request.params.chatId,
        input.data,
      );
      return reordered
        ? reply.code(204).send()
        : reply.code(400).send({ error: "Queued prompt order is invalid." });
    },
  );

  app.patch<{ Params: { promptId: string } }>(
    "/api/queued-prompts/:promptId",
    async (request, reply) => {
      const input = encryptedQueuedPromptUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const current = await repository.getEncryptedQueuedPrompt(
        applicationOwnerId(),
        request.params.promptId,
      );
      if (!current) {
        return reply.code(404).send({ error: "Queued prompt not found." });
      }
      const promptContext = await repository.getChatExecutionContext(
        applicationOwnerId(),
        current.chatId,
      );
      if (!promptContext) {
        return reply.code(404).send({ error: "Chat not found." });
      }
      if (promptContext?.experience === "task") {
        return reply.code(409).send({
          error: "Queued prompts are unavailable for encrypted Tasks.",
        });
      }
      let attachments: Awaited<ReturnType<typeof resolvePromptAttachments>>;
      try {
        attachments = await resolvePromptAttachments(
          promptContext,
          input.data.prompt.classification.attachmentIds,
        );
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
      if (managedConsoleSessionContext(promptContext)) {
        if (
          input.data.expectedItemRevision === undefined ||
          !input.data.operationId
        )
          return reply.code(409).send({ code: "queue-revision-required" });
        try {
          const original = {
            kind: "update" as const,
            id: request.params.promptId,
            expectedItemRevision: input.data.expectedItemRevision,
            prompt: input.data.prompt,
            attachments: attachments.map(toChatAttachmentOpaqueSummary),
          };
          const prior = await lookupManagedGuiQueue(
            repository,
            applicationOwnerId(),
            promptContext,
            original,
            { operationId: input.data.operationId },
          );
          if (prior) return reply.send(prior.acceptedItem);
          const normalized = input.data.prompt.protectedNativeInput
            ? queuedPromptOpaqueContentSchema.parse(
                await bridge.request(promptContext.workerId, {
                  type: "chat.queue.prepare",
                  chatId: promptContext.chatId,
                  prompt: input.data.prompt,
                  attachments: original.attachments,
                }),
              )
            : input.data.prompt;
          const result = await mutateManagedGuiQueue(
            repository,
            applicationOwnerId(),
            promptContext,
            { ...original, prompt: normalized },
            {
              operationId: input.data.operationId,
              payloadDigest: createHash("sha256")
                .update(JSON.stringify(original))
                .digest("hex"),
            },
          );
          const prompt = result.acceptedItem;
          if (prompt && !prompt.frozen)
            void dispatchNextQueuedPrompt(prompt.chatId);
          return reply.send(prompt);
        } catch (error) {
          return reply.code(409).send({ error: errorMessage(error) });
        }
      }
      const prompt = await repository.replaceEncryptedQueuedPrompt(
        applicationOwnerId(),
        request.params.promptId,
        input.data.prompt,
        attachments.map((attachment) =>
          toChatAttachmentOpaqueSummary(attachment),
        ),
      );
      if (!prompt) {
        return reply.code(404).send({ error: "Queued prompt not found." });
      }
      if (!prompt.frozen) void dispatchNextQueuedPrompt(prompt.chatId);
      return reply.send(encryptedQueuedPromptSchema.parse(prompt));
    },
  );

  app.delete<{
    Params: { promptId: string };
    Querystring: { expectedItemRevision?: string; operationId?: string };
  }>("/api/queued-prompts/:promptId", async (request, reply) => {
    const current = await repository.getEncryptedQueuedPrompt(
      applicationOwnerId(),
      request.params.promptId,
    );
    const context = current
      ? await repository.getChatExecutionContext(
          applicationOwnerId(),
          current.chatId,
        )
      : null;
    if (context && managedConsoleSessionContext(context)) {
      const revision = Number(request.query.expectedItemRevision);
      if (
        request.query.expectedItemRevision === undefined ||
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        !request.query.operationId
      )
        return reply.code(409).send({ code: "queue-revision-required" });
      try {
        await mutateManagedGuiQueue(
          repository,
          applicationOwnerId(),
          context,
          {
            kind: "delete",
            id: request.params.promptId,
            expectedItemRevision: revision,
          },
          { operationId: request.query.operationId },
        );
        return reply.code(204).send();
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    }
    const prompt = await deleteLiveQueuedPrompt(
      applicationOwnerId(),
      request.params.promptId,
    );
    return prompt
      ? reply.code(204).send()
      : reply.code(404).send({ error: "Queued prompt not found." });
  });

  app.post<{
    Params: { promptId: string };
    Body: { expectedItemRevision?: number; operationId?: string };
  }>("/api/queued-prompts/:promptId/steer", async (request, reply) => {
    const queued = await repository.getEncryptedQueuedPrompt(
      applicationOwnerId(),
      request.params.promptId,
    );
    if (!queued) {
      return reply.code(404).send({ error: "Queued prompt not found." });
    }
    const control = await repository.nativeCommands.controlContext(
      applicationOwnerId(),
      queued.chatId,
    );
    let context = control.context;
    if (!context) return reply.code(404).send({ error: "Chat not found." });
    if (context.experience === "task") {
      return reply.code(409).send({
        error: "Queued prompts are unavailable for encrypted Tasks.",
      });
    }

    const managed = managedConsoleSessionContext(context) !== undefined;
    let queueClaim: import("@cantrip/protocol").ManagedQueueClaim | null = null;
    if (managed) {
      if (
        !Number.isSafeInteger(request.body?.expectedItemRevision) ||
        request.body.expectedItemRevision! < 0 ||
        !request.body?.operationId
      )
        return reply.code(409).send({ code: "queue-revision-required" });
      try {
        queueClaim = await repository.managedQueue.claimItem(
          applicationOwnerId(),
          context.chatId,
          queued.id,
          request.body.expectedItemRevision!,
          `steer:${request.body.operationId}`,
        );
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    }
    if (queueClaim?.status === "consumed") {
      const message =
        (await repository.getEncryptedMessageByIdempotencyKey(
          applicationOwnerId(),
          queued.chatId,
          queued.pendingMessage.idempotencyKey,
        )) ??
        (await appendLiveEncryptedChatMessage(
          applicationOwnerId(),
          queued.chatId,
          queued.pendingMessage,
        ));
      return message
        ? reply.send(
            encryptedChatPromptSteerResultSchema.parse({
              steered: true,
              message,
            }),
          )
        : reply.code(404).send({ error: "Chat not found." });
    }
    try {
      let message: ChatMessageOpaqueSummary;
      if (chatIsExecuting(context.status)) {
        if (queued.classification.mode !== "default") {
          throw new Error(
            "Plan and Goal mode prompts cannot steer an active turn. Leave this prompt queued for the next turn.",
          );
        }
        if (queued.worktreeId && queued.worktreeId !== context.worktreeId) {
          throw new Error(
            "This prompt is pinned to another worktree and cannot steer the active turn.",
          );
        }
        if (!bridge.isConnected(context.workerId)) {
          throw new Error("The active Codex thread is unavailable.");
        }
        const runtime = control.activationGeneration
          ? null
          : await runtimeForContext(context);
        if (!control.activationGeneration && !runtime)
          throw new Error("Selected model was not found.");
        const attachments = await resolvePromptAttachments(
          context,
          queued.classification.attachmentIds,
        );
        const workerAttachments = attachments.map((attachment) =>
          toChatAttachmentOpaqueSummary(attachment),
        );
        const alreadyApplied =
          queueClaim?.operationId && queueClaim.operationGeneration
            ? (
                await repository.nativeCommands.get(
                  applicationOwnerId(),
                  context.workerId,
                  queueClaim.operationId,
                  queueClaim.operationGeneration,
                )
              ).status === "applied"
            : false;
        if (!alreadyApplied)
          await bridge.request(
            context.workerId,
            control.activationGeneration
              ? {
                  type: "chat.native-control",
                  ...(queueClaim
                    ? {
                        operationId: request.body.operationId,
                        queueClaim: {
                          id: queueClaim.id,
                          promptRevision: queueClaim.promptRevision,
                        },
                        protectedNativeInput: queued.protectedNativeInput,
                        queuedPromptId: queued.id,
                        nativeClientUserMessageId:
                          queued.nativeClientUserMessageId,
                      }
                    : {}),
                  chatId: context.chatId,
                  threadId: context.threadId,
                  nativeActivationGeneration: control.activationGeneration,
                  nativeRuntimeGeneration: control.runtimeGeneration,
                  modelRouteId: context.modelRouteId,
                  providerAccountId: context.providerAccountId,
                  control: {
                    kind: "steer",
                    protectedPrompt: queued.pendingMessage,
                    attachments: workerAttachments,
                  },
                }
              : {
                  type: "chat.steer",
                  executionProfile:
                    context.contextKind === "standalone"
                      ? "standalone-chat"
                      : "ide",
                  chatId: context.chatId,
                  threadId: context.threadId,
                  protectedPrompt: queued.pendingMessage,
                  attachments: workerAttachments,
                  model: runtime!.model,
                  provider: runtime!.provider,
                },
          );
        const appended = await appendLiveEncryptedChatMessage(
          applicationOwnerId(),
          context.chatId,
          queued.pendingMessage,
          context.executionLaneId
            ? context.contextKind === "standalone"
              ? {
                  contextKind: "standalone",
                  executionLaneId: context.executionLaneId,
                  worktreeId: null,
                  scratchRootId: context.scratchRootId,
                }
              : {
                  contextKind: "project",
                  executionLaneId: context.executionLaneId,
                  worktreeId: context.worktreeId,
                  scratchRootId: null,
                }
            : undefined,
        );
        if (!appended) throw new Error("Chat not found.");
        message = appended;
      } else if (queueClaim) {
        await dispatchNextQueuedPrompt(context.chatId);
        const started = await repository.getEncryptedMessageByIdempotencyKey(
          applicationOwnerId(),
          context.chatId,
          queued.pendingMessage.idempotencyKey,
        );
        if (!started)
          throw new Error(
            "The queued action is still pending; its durable claim was retained.",
          );
        message = started;
      } else {
        if (queued.worktreeId && queued.worktreeId !== context.worktreeId) {
          if (context.contextKind !== "project") {
            throw new Error(
              "Standalone Chat prompts cannot target project worktrees.",
            );
          }
          await repository.updateChatWorktree(
            applicationOwnerId(),
            context.chatId,
            {
              worktreeId: queued.worktreeId,
              mode: context.worktreeMode,
            },
          );
          const selected = await repository.getChatExecutionContext(
            applicationOwnerId(),
            context.chatId,
          );
          if (!selected) throw new Error("Worktree could not be selected.");
          context = selected;
        }
        await beginTurn(
          context,
          {
            text: "Encrypted queued prompt.",
            attachmentIds: queued.classification.attachmentIds,
            mode: queued.classification.mode,
            modelId: queued.modelId,
            reasoningEffort: queued.reasoningEffort,
            customSubagentModel: queued.customSubagentModel,
            subagentModelId: queued.subagentModelId,
            subagentReasoningEffort: queued.subagentReasoningEffort,
            idempotencyKey: queued.pendingMessage.idempotencyKey,
          },
          {
            encryptedChatMessages: {
              userMessage: queued.pendingMessage,
              response: {
                id: randomUUID(),
                idempotencyKey: `assistant:${queued.pendingMessage.id}`,
              },
            },
          },
        );
        const started = await repository.getEncryptedMessageByIdempotencyKey(
          applicationOwnerId(),
          context.chatId,
          queued.pendingMessage.idempotencyKey,
        );
        if (!started) throw new Error("Encrypted chat message was not saved.");
        message = started;
      }
      if (!managed)
        await deleteLiveQueuedPrompt(applicationOwnerId(), queued.id);
      app.log.info(
        {
          event: "chat.queue.steered",
          subsystem: "chat-queue",
          operation: "steer",
          status: "completed",
          chatId: context.chatId,
          projectId: context.projectId,
          workerId: context.workerId,
          requestId: queued.id,
        },
        "Queued prompt steered into chat",
      );
      return reply.send(
        encryptedChatPromptSteerResultSchema.parse({
          steered: true,
          message,
        }),
      );
    } catch (error) {
      if (queueClaim)
        await repository.managedQueue.releaseUnadmitted(
          applicationOwnerId(),
          queued.chatId,
          queueClaim.id,
        );
      return (
        sendModelConfigurationResolutionFailure(reply, error) ??
        reply.code(409).send({ error: errorMessage(error) })
      );
    }
  });
}
