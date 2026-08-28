import { endpointContentContextSchema } from "@cantrip/protocol/endpoint-content";
import {
  protectedCustomizationRequestSchema,
  type CustomizationContentOperation,
  type CustomizationContentScope,
  type ProtectedCustomizationResponse,
} from "@cantrip/protocol/customization-content";
import type { FastifyInstance } from "fastify";

import type {
  ChatExecutionContext,
  ModelRuntime,
  ServerRepository,
} from "../../db/repository.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ChatCustomizationRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  chatCustomizationScope: (
    context: ChatExecutionContext,
    runtime: ModelRuntime,
  ) => CustomizationContentScope;
  checkedCustomizationResponse: (input: {
    raw: unknown;
    operationId: string;
    operation: CustomizationContentOperation;
    scope: CustomizationContentScope;
  }) => ProtectedCustomizationResponse;
  customizationScopesMatch: (
    left: CustomizationContentScope,
    right: CustomizationContentScope,
  ) => boolean;
  publishChatInvalidation: (chatId: string, resource: "customization") => void;
  repository: Pick<ServerRepository, "getChatExecutionContext">;
  runtimeForContext: (
    context: ChatExecutionContext,
  ) => Promise<ModelRuntime | null>;
  serverId: string;
}

/** Registers worker-backed Chat customization and skill routes. */
export function installChatCustomizationRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    chatCustomizationScope,
    checkedCustomizationResponse,
    customizationScopesMatch,
    publishChatInvalidation,
    repository,
    runtimeForContext,
    serverId,
  }: ChatCustomizationRouteDependencies,
): void {
  app.get<{
    Params: { chatId: string };
    Querystring: { operationId?: string };
  }>("/api/chats/:chatId/skills", async (request, reply) => {
    const operationId =
      endpointContentContextSchema.shape.operationId.safeParse(
        request.query.operationId,
      );
    if (!operationId.success) {
      return reply
        .code(400)
        .send({ error: "A valid operationId is required." });
    }
    const context = await repository.getChatExecutionContext(
      applicationOwnerId(),
      request.params.chatId,
    );
    if (!context) return reply.code(404).send({ error: "Chat not found." });
    if (!bridge.isConnected(context.workerId)) {
      return reply.code(503).send({ error: "Project worker is offline." });
    }
    try {
      const runtime = await runtimeForContext(context);
      if (!runtime) {
        return reply
          .code(409)
          .send({ error: "Choose a model before listing skills." });
      }
      const scope = chatCustomizationScope(context, runtime);
      const skills = checkedCustomizationResponse({
        raw: await bridge.request(context.workerId, {
          type: "skills.list",
          operationId: operationId.data,
          serverId,
          scope,
          cwd: context.cwd,
          model: runtime.model,
          provider: runtime.provider,
        }),
        operationId: operationId.data,
        operation: "skills.list",
        scope,
      });
      return reply.send(skills);
    } catch (error) {
      return sendWorkerRequestFailure(reply, error);
    }
  });

  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/customizations/target",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      const runtime = await runtimeForContext(context);
      if (!runtime) {
        return reply
          .code(409)
          .send({ error: "Choose a model before using customizations." });
      }
      return reply.send(chatCustomizationScope(context, runtime));
    },
  );

  app.get<{
    Params: { chatId: string };
    Querystring: { operationId?: string; refresh?: string };
  }>("/api/chats/:chatId/customizations", async (request, reply) => {
    const operationId =
      endpointContentContextSchema.shape.operationId.safeParse(
        request.query.operationId,
      );
    if (!operationId.success) {
      return reply
        .code(400)
        .send({ error: "A valid operationId is required." });
    }
    const context = await repository.getChatExecutionContext(
      applicationOwnerId(),
      request.params.chatId,
    );
    if (!context) return reply.code(404).send({ error: "Chat not found." });
    if (!bridge.isConnected(context.workerId)) {
      return reply.code(503).send({ error: "Project worker is offline." });
    }
    try {
      const runtime = await runtimeForContext(context);
      if (!runtime) {
        return reply
          .code(409)
          .send({ error: "Choose a model before listing customizations." });
      }
      const scope = chatCustomizationScope(context, runtime);
      const inventory = checkedCustomizationResponse({
        raw: await bridge.request(context.workerId, {
          type: "customization.inventory.read",
          operationId: operationId.data,
          serverId,
          scope,
          cwd: context.cwd,
          threadId: context.threadId,
          forceReload: request.query.refresh === "true",
          model: runtime.model,
          provider: runtime.provider,
        }),
        operationId: operationId.data,
        operation: "customization.inventory.read",
        scope,
      });
      return reply.send(inventory);
    } catch (error) {
      return sendWorkerRequestFailure(reply, error);
    }
  });

  app.get<{
    Params: { chatId: string };
    Querystring: { operationId?: string };
  }>(
    "/api/chats/:chatId/customizations/external-preview",
    async (request, reply) => {
      const operationId =
        endpointContentContextSchema.shape.operationId.safeParse(
          request.query.operationId,
        );
      if (!operationId.success) {
        return reply
          .code(400)
          .send({ error: "A valid operationId is required." });
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const runtime = await runtimeForContext(context);
        if (!runtime) {
          return reply
            .code(409)
            .send({ error: "Choose a model before previewing imports." });
        }
        const scope = chatCustomizationScope(context, runtime);
        const preview = checkedCustomizationResponse({
          raw: await bridge.request(context.workerId, {
            type: "customization.external.preview",
            operationId: operationId.data,
            serverId,
            scope,
            cwd: context.cwd,
            model: runtime.model,
            provider: runtime.provider,
          }),
          operationId: operationId.data,
          operation: "customization.external.preview",
          scope,
        });
        return reply.send(preview);
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/customizations/mcp-resource",
    async (request, reply) => {
      const input = protectedCustomizationRequestSchema.safeParse(request.body);
      if (
        !input.success ||
        input.data.operation !== "customization.mcp.resource.read"
      ) {
        return reply.code(400).send({ error: "Invalid protected request." });
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const runtime = await runtimeForContext(context);
        if (!runtime) {
          return reply
            .code(409)
            .send({ error: "Choose a model before reading MCP resources." });
        }
        const scope = chatCustomizationScope(context, runtime);
        if (!customizationScopesMatch(input.data.scope, scope)) {
          return reply
            .code(409)
            .send({ error: "Customization scope changed." });
        }
        const resource = checkedCustomizationResponse({
          raw: await bridge.request(context.workerId, {
            type: "customization.mcp.resource.read",
            operationId: input.data.operationId,
            serverId,
            scope,
            protectedRequest: input.data.protectedRequest,
            cwd: context.cwd,
            model: runtime.model,
            provider: runtime.provider,
          }),
          operationId: input.data.operationId,
          operation: input.data.operation,
          scope,
        });
        return reply.send(resource);
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/customizations/skill",
    async (request, reply) => {
      const input = protectedCustomizationRequestSchema.safeParse(request.body);
      if (
        !input.success ||
        input.data.operation !== "customization.skill.configure"
      ) {
        return reply.code(400).send({ error: "Invalid protected request." });
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const runtime = await runtimeForContext(context);
        if (!runtime) {
          return reply
            .code(409)
            .send({ error: "Choose a model before configuring skills." });
        }
        const scope = chatCustomizationScope(context, runtime);
        if (!customizationScopesMatch(input.data.scope, scope)) {
          return reply
            .code(409)
            .send({ error: "Customization scope changed." });
        }
        const result = checkedCustomizationResponse({
          raw: await bridge.request(context.workerId, {
            type: "customization.skill.configure",
            operationId: input.data.operationId,
            serverId,
            scope,
            protectedRequest: input.data.protectedRequest,
            cwd: context.cwd,
            model: runtime.model,
            provider: runtime.provider,
          }),
          operationId: input.data.operationId,
          operation: input.data.operation,
          scope,
        });
        if (result.result === "succeeded") {
          publishChatInvalidation(context.chatId, "customization");
        }
        return reply.send(result);
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.put<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/customizations/skill-roots",
    async (request, reply) => {
      const input = protectedCustomizationRequestSchema.safeParse(request.body);
      if (
        !input.success ||
        input.data.operation !== "customization.skill-roots.set"
      ) {
        return reply.code(400).send({ error: "Invalid protected request." });
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const runtime = await runtimeForContext(context);
        if (!runtime) {
          return reply
            .code(409)
            .send({ error: "Choose a model before configuring skill roots." });
        }
        const scope = chatCustomizationScope(context, runtime);
        if (!customizationScopesMatch(input.data.scope, scope)) {
          return reply
            .code(409)
            .send({ error: "Customization scope changed." });
        }
        const result = checkedCustomizationResponse({
          raw: await bridge.request(context.workerId, {
            type: "customization.skill-roots.set",
            operationId: input.data.operationId,
            serverId,
            scope,
            protectedRequest: input.data.protectedRequest,
            cwd: context.cwd,
            model: runtime.model,
            provider: runtime.provider,
          }),
          operationId: input.data.operationId,
          operation: input.data.operation,
          scope,
        });
        if (result.result === "succeeded") {
          publishChatInvalidation(context.chatId, "customization");
        }
        return reply.send(result);
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/customizations/mcp-oauth",
    async (request, reply) => {
      const input = protectedCustomizationRequestSchema.safeParse(request.body);
      if (
        !input.success ||
        input.data.operation !== "customization.mcp.oauth.start"
      ) {
        return reply.code(400).send({ error: "Invalid protected request." });
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const runtime = await runtimeForContext(context);
        if (!runtime) {
          return reply
            .code(409)
            .send({ error: "Choose a model before authorizing MCP servers." });
        }
        const scope = chatCustomizationScope(context, runtime);
        if (!customizationScopesMatch(input.data.scope, scope)) {
          return reply
            .code(409)
            .send({ error: "Customization scope changed." });
        }
        const result = checkedCustomizationResponse({
          raw: await bridge.request(context.workerId, {
            type: "customization.mcp.oauth.start",
            operationId: input.data.operationId,
            serverId,
            scope,
            protectedRequest: input.data.protectedRequest,
            cwd: context.cwd,
            model: runtime.model,
            provider: runtime.provider,
          }),
          operationId: input.data.operationId,
          operation: input.data.operation,
          scope,
        });
        return reply.send(result);
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/customizations/mcp-oauth/status",
    async (request, reply) => {
      const input = protectedCustomizationRequestSchema.safeParse(request.body);
      if (
        !input.success ||
        input.data.operation !== "customization.mcp.oauth.status"
      ) {
        return reply.code(400).send({ error: "Invalid protected request." });
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const runtime = await runtimeForContext(context);
        if (!runtime) {
          return reply
            .code(409)
            .send({ error: "Choose a model before checking MCP OAuth." });
        }
        const scope = chatCustomizationScope(context, runtime);
        if (!customizationScopesMatch(input.data.scope, scope)) {
          return reply
            .code(409)
            .send({ error: "Customization scope changed." });
        }
        const status = checkedCustomizationResponse({
          raw: await bridge.request(context.workerId, {
            type: "customization.mcp.oauth.status",
            operationId: input.data.operationId,
            serverId,
            scope,
            protectedRequest: input.data.protectedRequest,
            cwd: context.cwd,
            model: runtime.model,
            provider: runtime.provider,
          }),
          operationId: input.data.operationId,
          operation: input.data.operation,
          scope,
        });
        return reply.send(status);
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/customizations/mcp-reload",
    async (request, reply) => {
      const input = protectedCustomizationRequestSchema.safeParse(request.body);
      if (
        !input.success ||
        input.data.operation !== "customization.mcp.reload"
      ) {
        return reply.code(400).send({ error: "Invalid protected request." });
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const runtime = await runtimeForContext(context);
        if (!runtime) {
          return reply
            .code(409)
            .send({ error: "Choose a model before reloading MCP servers." });
        }
        const scope = chatCustomizationScope(context, runtime);
        if (!customizationScopesMatch(input.data.scope, scope)) {
          return reply
            .code(409)
            .send({ error: "Customization scope changed." });
        }
        const result = checkedCustomizationResponse({
          raw: await bridge.request(context.workerId, {
            type: "customization.mcp.reload",
            operationId: input.data.operationId,
            serverId,
            scope,
            protectedRequest: input.data.protectedRequest,
            cwd: context.cwd,
            model: runtime.model,
            provider: runtime.provider,
          }),
          operationId: input.data.operationId,
          operation: input.data.operation,
          scope,
        });
        if (result.result === "succeeded") {
          publishChatInvalidation(context.chatId, "customization");
        }
        return reply.send(result);
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/customizations/external-import",
    async (request, reply) => {
      const input = protectedCustomizationRequestSchema.safeParse(request.body);
      if (
        !input.success ||
        input.data.operation !== "customization.external.apply"
      ) {
        return reply.code(400).send({ error: "Invalid protected request." });
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const runtime = await runtimeForContext(context);
        if (!runtime) {
          return reply.code(409).send({
            error: "Choose a model before importing external configuration.",
          });
        }
        const scope = chatCustomizationScope(context, runtime);
        if (!customizationScopesMatch(input.data.scope, scope)) {
          return reply
            .code(409)
            .send({ error: "Customization scope changed." });
        }
        const status = checkedCustomizationResponse({
          raw: await bridge.request(context.workerId, {
            type: "customization.external.apply",
            operationId: input.data.operationId,
            serverId,
            scope,
            protectedRequest: input.data.protectedRequest,
            cwd: context.cwd,
            model: runtime.model,
            provider: runtime.provider,
          }),
          operationId: input.data.operationId,
          operation: input.data.operation,
          scope,
        });
        return reply.code(202).send(status);
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/customizations/external-import/status",
    async (request, reply) => {
      const input = protectedCustomizationRequestSchema.safeParse(request.body);
      if (
        !input.success ||
        input.data.operation !== "customization.external.status"
      ) {
        return reply.code(400).send({ error: "Invalid protected request." });
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const runtime = await runtimeForContext(context);
        if (!runtime) {
          return reply.code(409).send({
            error: "Choose a model before checking an external import.",
          });
        }
        const scope = chatCustomizationScope(context, runtime);
        if (!customizationScopesMatch(input.data.scope, scope)) {
          return reply
            .code(409)
            .send({ error: "Customization scope changed." });
        }
        const status = checkedCustomizationResponse({
          raw: await bridge.request(context.workerId, {
            type: "customization.external.status",
            operationId: input.data.operationId,
            serverId,
            scope,
            protectedRequest: input.data.protectedRequest,
            cwd: context.cwd,
            model: runtime.model,
            provider: runtime.provider,
          }),
          operationId: input.data.operationId,
          operation: input.data.operation,
          scope,
        });
        return reply.send(status);
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );
}
