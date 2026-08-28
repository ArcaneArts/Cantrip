import {
  chatModelUpdateSchema,
  chatPermissionProfileStateSchema,
  chatPermissionProfileUpdateSchema,
  chatReasoningStateSchema,
  chatReasoningUpdateSchema,
  configurablePermissionProfileIdSchema,
  contextualChatWireSummarySchema,
  DEFAULT_PERMISSION_PROFILE_ID,
  modelConfigurationSchema,
  permissionProfileCapabilitySchema,
  YOLO_PERMISSION_PROFILE_ID,
  type ChatReasoningState,
  type ModelConfiguration,
  type ReasoningEffort,
} from "@cantrip/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";

import { effectivePermissionProfile } from "../../chats/execution-helpers.js";
import type {
  ChatExecutionContext,
  ModelRuntime,
  ServerRepository,
} from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import { configurationReasoningStateForRuntimes } from "../../models/reasoning.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { CONFIGURABLE_PERMISSION_PROFILES } from "../shared/constants.js";

export interface ChatRuntimeConfigurationRouteDependencies {
  applicationOwnerId: () => string;
  availableModelRuntimes: (
    context: { providerAccountId?: string | null; workerId: string },
    modelId: string,
  ) => Promise<ModelRuntime[]>;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  reasoningStateForContext: (
    context: ChatExecutionContext,
    requestedModelId?: string,
    requestedReasoningEffort?: ReasoningEffort | null,
  ) => Promise<ChatReasoningState>;
  repository: Pick<
    ServerRepository,
    | "getChatExecutionContext"
    | "getModelReasoningDefault"
    | "setChatModelConfiguration"
    | "setChatPermissionProfile"
  >;
  resolveModelId: (
    context: ChatExecutionContext,
    requestedModelId?: string,
  ) => Promise<string>;
  routePairsForConfiguration: (
    context: ChatExecutionContext,
    configuration: ModelConfiguration,
  ) => Promise<unknown>;
  runtimeForContext: (
    context: ChatExecutionContext,
  ) => Promise<ModelRuntime | null>;
  sendModelConfigurationResolutionFailure: (
    reply: FastifyReply,
    error: unknown,
  ) => FastifyReply | null;
}

/** Registers Chat model, reasoning, and permission-profile configuration routes. */
export function installChatRuntimeConfigurationRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    availableModelRuntimes,
    bridge,
    reasoningStateForContext,
    repository,
    resolveModelId,
    routePairsForConfiguration,
    runtimeForContext,
    sendModelConfigurationResolutionFailure,
  }: ChatRuntimeConfigurationRouteDependencies,
): void {
  const permissionProfileState = async (context: ChatExecutionContext) => {
    const selection = effectivePermissionProfile(context);
    if (!bridge.isConnected(context.workerId)) {
      return chatPermissionProfileStateSchema.parse({
        ...selection,
        available: false,
        profiles: CONFIGURABLE_PERMISSION_PROFILES,
        reason:
          "Project worker is offline; the legacy sandbox policy remains active.",
      });
    }
    try {
      const runtime = await runtimeForContext(context);
      if (!runtime) {
        throw new Error("Choose a model before listing permission profiles.");
      }
      const capability = permissionProfileCapabilitySchema.parse(
        await bridge.request(context.workerId, {
          type: "permission-profiles.list",
          cwd: context.cwd,
          model: runtime.model,
          provider: runtime.provider,
        }),
      );
      const fullAccessProfile = capability.profiles.find(
        (profile) => profile.id === ":danger-full-access",
      );
      const profiles =
        fullAccessProfile &&
        !capability.profiles.some(
          (profile) => profile.id === YOLO_PERMISSION_PROFILE_ID,
        )
          ? [
              ...capability.profiles,
              {
                id: YOLO_PERMISSION_PROFILE_ID,
                description: "Unrestricted access without approval prompts",
                allowed: fullAccessProfile.allowed,
              },
            ]
          : capability.profiles;
      return chatPermissionProfileStateSchema.parse({
        ...selection,
        ...capability,
        profiles,
      });
    } catch (error) {
      return chatPermissionProfileStateSchema.parse({
        ...selection,
        available: false,
        profiles: CONFIGURABLE_PERMISSION_PROFILES,
        reason: `Permission profiles are unavailable: ${errorMessage(error)}`,
      });
    }
  };

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/model",
    async (request, reply) => {
      const input = chatModelUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      let reasoning: ChatReasoningState;
      try {
        const rememberedReasoningEffort =
          await repository.getModelReasoningDefault(
            applicationOwnerId(),
            input.data.modelId,
          );
        reasoning = await reasoningStateForContext(
          { ...context, modelId: input.data.modelId },
          input.data.modelId,
          rememberedReasoningEffort ?? null,
        );
      } catch (error) {
        const response = sendModelConfigurationResolutionFailure(reply, error);
        return response ?? reply.code(409).send({ error: errorMessage(error) });
      }
      const configuration = modelConfigurationSchema.parse({
        ...context.modelConfiguration,
        modelId: input.data.modelId,
        reasoningEffort: reasoning.reasoningEffort,
      });
      try {
        await routePairsForConfiguration(context, configuration);
      } catch (error) {
        const response = sendModelConfigurationResolutionFailure(reply, error);
        return response ?? reply.code(409).send({ error: errorMessage(error) });
      }
      const result = await repository.setChatModelConfiguration(
        applicationOwnerId(),
        request.params.chatId,
        configuration,
      );
      if (!result) {
        return reply.code(404).send({ error: "Chat or model not found." });
      }
      return reply.send(contextualChatWireSummarySchema.parse(result));
    },
  );

  app.get<{
    Params: { chatId: string };
    Querystring: { modelId?: string };
  }>("/api/chats/:chatId/reasoning", async (request, reply) => {
    const context = await repository.getChatExecutionContext(
      applicationOwnerId(),
      request.params.chatId,
    );
    if (!context) {
      return reply.code(404).send({ error: "Chat source not found." });
    }
    try {
      const requestedModelId = request.query.modelId?.trim() || null;
      const resolvedModelId = await resolveModelId(
        context,
        requestedModelId ?? undefined,
      );
      const initialReasoningEffort = context.modelId
        ? requestedModelId
          ? ((await repository.getModelReasoningDefault(
              applicationOwnerId(),
              resolvedModelId,
            )) ?? null)
          : context.reasoningEffort
        : ((await repository.getModelReasoningDefault(
            applicationOwnerId(),
            resolvedModelId,
          )) ?? null);
      if (requestedModelId) {
        return reply.send(
          chatReasoningStateSchema.parse(
            configurationReasoningStateForRuntimes(
              resolvedModelId,
              initialReasoningEffort,
              await availableModelRuntimes(context, resolvedModelId),
            ),
          ),
        );
      }
      return reply.send(
        chatReasoningStateSchema.parse(
          await reasoningStateForContext(
            context,
            resolvedModelId,
            initialReasoningEffort,
          ),
        ),
      );
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/reasoning",
    async (request, reply) => {
      const input = chatReasoningUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      let current: ChatReasoningState;
      try {
        current = await reasoningStateForContext(context);
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
      if (
        input.data.reasoningEffort !== null &&
        !current.options.some(
          ({ effort }) => effort === input.data.reasoningEffort,
        )
      ) {
        return reply.code(409).send({
          error:
            "That reasoning effort is not supported by every eligible provider route.",
        });
      }
      const configuration = modelConfigurationSchema.parse({
        ...context.modelConfiguration,
        modelId: current.modelId,
        reasoningEffort: input.data.reasoningEffort,
      });
      try {
        await routePairsForConfiguration(context, configuration);
      } catch (error) {
        const response = sendModelConfigurationResolutionFailure(reply, error);
        return response ?? reply.code(409).send({ error: errorMessage(error) });
      }
      const updated = await repository.setChatModelConfiguration(
        applicationOwnerId(),
        context.chatId,
        configuration,
      );
      if (!updated) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      return reply.send(
        chatReasoningStateSchema.parse({
          ...current,
          reasoningEffort: input.data.reasoningEffort,
        }),
      );
    },
  );

  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/permission-profiles",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      return reply.send(await permissionProfileState(context));
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/permission-profile",
    async (request, reply) => {
      const input = chatPermissionProfileUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      const capability = await permissionProfileState(context);
      const requestedId =
        input.data.id ??
        context.defaultPermissionProfileId ??
        DEFAULT_PERMISSION_PROFILE_ID;
      const profile = capability.profiles.find(
        (candidate) => candidate.id === requestedId,
      );
      if (
        !profile ||
        (!capability.available &&
          !configurablePermissionProfileIdSchema.safeParse(requestedId).success)
      ) {
        return reply
          .code(400)
          .send({ error: "Codex did not advertise that permission profile." });
      }
      if (!profile.allowed) {
        return reply
          .code(409)
          .send({ error: "That permission profile is not allowed here." });
      }
      const updated = await repository.setChatPermissionProfile(
        applicationOwnerId(),
        context.chatId,
        input.data.id,
      );
      if (!updated) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      const refreshed = await repository.getChatExecutionContext(
        applicationOwnerId(),
        context.chatId,
      );
      if (!refreshed) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      return reply.send(
        chatPermissionProfileStateSchema.parse({
          ...effectivePermissionProfile(refreshed),
          available: capability.available,
          profiles: capability.profiles,
          reason: capability.reason,
        }),
      );
    },
  );
}
