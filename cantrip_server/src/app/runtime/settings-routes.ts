import {
  appDestinationSchema,
  appDestinationUpdateSchema,
  chatReasoningStateSchema,
  codeProbeResultSchema,
  codeProtectedAttachmentWireSchema,
  codeSettingsWorkbenchAttachmentCreateSchema,
  codeSettingsWorkbenchAttachmentWireSchema,
  codeSettingsWorkbenchOpenResultSchema,
  desktopUpdateActiveWorkSummarySchema,
  encryptedMcpServerCreateSchema,
  encryptedMcpServerUpdateSchema,
  encryptedModelProviderCreateSchema,
  encryptedModelProviderUpdateSchema,
  mcpServerDiscoveryResultSchema,
  mcpServerWireListSchema,
  mcpServerWireSummarySchema,
  modelConfigurationSchema,
  modelProfileCreateSchema,
  modelProfileSummarySchema,
  modelProfileUpdateSchema,
  modelProviderWireSummarySchema,
  providerConnectionTestResultSchema,
  providerModelCatalogResultSchema,
  settingsBundleWireSchema,
  skillAudienceContextSchema,
  skillAudienceListSchema,
  skillAudienceSummarySchema,
  skillAudienceUpdateSchema,
  skillSettingsContextSchema,
  taskWorkerCreateSchema,
  taskWorkerDeleteSchema,
  taskWorkerListSchema,
  taskWorkerOrderUpdateSchema,
  taskWorkerSummarySchema,
  taskWorkerUpdateSchema,
  userSettingsUpdateSchema,
  workerProviderConnectionTestResultSchema,
  type AppLiveResource,
  type CodeRuntimeStatus,
  type ModelConfiguration,
  type ModelProviderKind,
  type SkillSettingsContext,
} from "@cantrip/protocol";
import {
  codeSettingsProfileIdSchema,
  codeSettingsPublicStatusSchema,
  codeSettingsResolveRequestSchema,
  codeSettingsSynchronizeRequestSchema,
  codeSettingsWorkerStatusSchema,
} from "@cantrip/protocol/code-settings";
import {
  type CustomizationContentOperation,
  type CustomizationContentScope,
  type ProtectedCustomizationRequest,
  type ProtectedCustomizationResponse,
} from "@cantrip/protocol/customization-content";
import { endpointContentContextSchema } from "@cantrip/protocol/endpoint-content";
import type { FastifyInstance, FastifyReply } from "fastify";

import { authenticatedPrincipal } from "../../auth/principal.js";
import { scopedCodeProfileId } from "../../chats/execution-helpers.js";
import type { CodeTunnelBroker } from "../../code/tunnel.js";
import type { ServerRepository } from "../../db/repository.js";
import { TaskSchedulingConflictError } from "../../db/task-scheduling.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import {
  accountProviderLabel,
  canRefreshProviderOnWorker,
  isAccountProviderKind,
} from "../../models/account-provider.js";
import type { ChatGptCatalogService } from "../../models/chatgpt-catalog.js";
import type { GrokCatalogService } from "../../models/grok-catalog.js";
import type { OllamaCatalogService } from "../../models/ollama-catalog.js";
import type { OpenRouterCatalogService } from "../../models/openrouter-catalog.js";
import type { OpenRouterRuntimeCatalogHydrator } from "../../models/openrouter-runtime-catalog.js";
import type { ProviderAccountLifecycleService } from "../../models/provider-account-lifecycle.js";
import {
  providerConnectionFailureMessage,
  providerConnectionFailureStage,
} from "../../models/provider-connection-test.js";
import { readAndPersistProviderQuotaSnapshot } from "../../models/provider-quota.js";
import { configurationReasoningStateForRuntimes } from "../../models/reasoning.js";
import type { ResolvedModelRoutePair } from "../../models/subagent-routing.js";
import {
  isZaiCodingPlanProvider,
  type ZaiCatalogService,
} from "../../models/zai-catalog.js";
import { WorkerUnavailableError } from "../../workers/bridge.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import type { installProviderAccountAuthRoutes } from "../routes/provider-account-auth.js";
import {
  ProviderAccountReconnectRequiredError,
  SkillSettingsRequestError,
} from "../shared/errors.js";
import { serverLogger } from "../../logger.js";

type ProviderAccountAuthRuntime = ReturnType<
  typeof installProviderAccountAuthRoutes
>;

interface SkillSettingsTarget {
  cwd: string | null;
  providerId: string;
  providerKind: ModelProviderKind;
  workerId: string;
}

export interface SettingsRouteRuntimeDependencies {
  applicationOwnerId: () => string;
  bridge: LimitedWorkerCommandBus;
  chatGptCatalogService: ChatGptCatalogService;
  checkedCustomizationRequest: (input: {
    raw: unknown;
    operation: CustomizationContentOperation;
  }) => ProtectedCustomizationRequest;
  checkedCustomizationResponse: (input: {
    raw: unknown;
    operationId: string;
    operation: CustomizationContentOperation;
    scope: CustomizationContentScope;
  }) => ProtectedCustomizationResponse;
  codeTunnel: CodeTunnelBroker;
  configuredRoutePairsForDefaults: (
    configuration: ModelConfiguration,
  ) => Promise<ResolvedModelRoutePair[]>;
  customizationScopesMatch: (
    left: CustomizationContentScope,
    right: CustomizationContentScope,
  ) => boolean;
  grokCatalogService: GrokCatalogService;
  ollamaCatalogService: OllamaCatalogService;
  openRouterRuntimeCatalogs: OpenRouterRuntimeCatalogHydrator;
  prepareProviderAccountSignOut: ProviderAccountAuthRuntime["prepareProviderAccountSignOut"];
  providerAccountLifecycle: ProviderAccountLifecycleService;
  providerCatalogService: OpenRouterCatalogService;
  publishLiveInvalidation: (
    resource: AppLiveResource,
    input?: {
      chatId?: string | null;
      entityId?: string | null;
      projectId?: string | null;
    },
  ) => void;
  repository: ServerRepository;
  resolveAccountAuthTarget: ProviderAccountAuthRuntime["resolveAccountAuthTarget"];
  sendModelConfigurationResolutionFailure: (
    reply: FastifyReply,
    error: unknown,
  ) => FastifyReply | null;
  serverId: string;
  settingsContextFromCustomizationScope: (
    scope: CustomizationContentScope,
  ) => SkillSettingsContext;
  settingsCustomizationScope: (
    input: SkillSettingsContext,
  ) => CustomizationContentScope;
  skillSettingsTarget: (
    input: SkillSettingsContext,
  ) => Promise<SkillSettingsTarget>;
  zaiCatalogService: ZaiCatalogService;
}

/**
 * Owns global settings, Code settings, Skills, MCP, provider catalogs,
 * model profiles, and task-worker configuration.
 */
export function installSettingsRouteRuntime(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    chatGptCatalogService,
    checkedCustomizationRequest,
    checkedCustomizationResponse,
    codeTunnel,
    configuredRoutePairsForDefaults,
    customizationScopesMatch,
    grokCatalogService,
    ollamaCatalogService,
    openRouterRuntimeCatalogs,
    prepareProviderAccountSignOut,
    providerAccountLifecycle,
    providerCatalogService,
    publishLiveInvalidation,
    repository,
    resolveAccountAuthTarget,
    sendModelConfigurationResolutionFailure,
    serverId,
    settingsContextFromCustomizationScope,
    settingsCustomizationScope,
    skillSettingsTarget,
    zaiCatalogService,
  }: SettingsRouteRuntimeDependencies,
) {
  app.get("/api/settings", async (_request, reply) => {
    const ownerId = applicationOwnerId();
    await zaiCatalogService.reconcileOwnerProviders(ownerId);
    const settings = await repository.getSettings(ownerId);
    for (const provider of settings.providers) {
      if (provider.kind !== "ollama" && !isAccountProviderKind(provider.kind)) {
        continue;
      }
      void loadProviderCatalog(ownerId, provider.id, undefined, false).catch(
        () => undefined,
      );
    }
    return reply.send(settingsBundleWireSchema.parse(settings));
  });

  app.get<{ Params: { profileId: string } }>(
    "/api/settings/code/:profileId",
    async (request, reply) => {
      const profileId = codeSettingsProfileIdSchema.safeParse(
        request.params.profileId,
      );
      if (!profileId.success) {
        return reply.code(400).send(invalidBody(profileId.error.issues));
      }
      reply.header("cache-control", "no-store");
      return reply.send(
        codeSettingsPublicStatusSchema.parse(
          await repository.codeSettings.publicStatus(
            applicationOwnerId(),
            profileId.data,
          ),
        ),
      );
    },
  );

  app.get<{ Params: { workerId: string } }>(
    "/api/settings/code/workers/:workerId/status",
    async (request, reply) => {
      const ownerId = applicationOwnerId();
      const worker = await repository.getWorker(
        ownerId,
        request.params.workerId,
      );
      if (!worker) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      if (!bridge.isConnected(worker.workerId)) {
        return reply.code(503).send({ error: "Worker is offline." });
      }
      reply.header("cache-control", "no-store");
      try {
        return reply.send(
          codeSettingsWorkerStatusSchema.parse(
            await bridge.request(worker.workerId, {
              type: "code.settings.status",
            }),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { workerId: string } }>(
    "/api/settings/code/workers/:workerId/synchronize",
    async (request, reply) => {
      const input = codeSettingsSynchronizeRequestSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      const worker = await repository.getWorker(
        ownerId,
        request.params.workerId,
      );
      if (!worker) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      if (!bridge.isConnected(worker.workerId)) {
        return reply.code(503).send({ error: "Worker is offline." });
      }
      try {
        return reply.send(
          codeSettingsWorkerStatusSchema.parse(
            await bridge.request(worker.workerId, {
              type: "code.settings.synchronize",
              initializeIfMissing: input.data.initializeIfMissing,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { workerId: string } }>(
    "/api/settings/code/workers/:workerId/resolve",
    async (request, reply) => {
      const input = codeSettingsResolveRequestSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      const worker = await repository.getWorker(
        ownerId,
        request.params.workerId,
      );
      if (!worker) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      if (!bridge.isConnected(worker.workerId)) {
        return reply.code(503).send({ error: "Worker is offline." });
      }
      try {
        return reply.send(
          codeSettingsWorkerStatusSchema.parse(
            await bridge.request(worker.workerId, {
              type: "code.settings.resolve",
              resolution: input.data.resolution,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post(
    "/api/settings/code/protected-code-attachments",
    async (request, reply) => {
      const input = codeSettingsWorkbenchAttachmentCreateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      const workerId = input.data.expectedWorkerId;
      const sessionId = input.data.sessionId;
      const registrationLease = codeTunnel.acquireRegistrationLease({
        authSessionId: authenticatedPrincipal(request).sessionId,
        ownerId,
        sessionId,
        tunnelId: input.data.tunnelId,
      });
      if (!registrationLease) {
        return reply.code(409).send({
          error: "Code settings changed while the workbench was opening.",
        });
      }
      let registrationOwnership: "abort" | "binding" | "release" = "release";
      let registrationRuntime: CodeRuntimeStatus | null = null;
      let bindingAttachmentId: string | null = null;
      let retainBinding = false;
      try {
        const worker = await repository.getWorker(ownerId, workerId);
        if (!worker) {
          return reply.code(404).send({ error: "Worker not found." });
        }
        if (!bridge.isConnected(workerId)) {
          return reply.code(503).send({ error: "Worker is offline." });
        }
        let probe;
        try {
          probe = codeProbeResultSchema.parse(
            await bridge.request(workerId, { type: "code.probe" }),
          );
        } catch (error) {
          return reply.code(503).send({ error: errorMessage(error) });
        }
        if (!probe.capabilities.available || !probe.editorBuild) {
          return reply.code(409).send({
            error:
              probe.capabilities.reason ??
              "This worker has no compatible Cantrip Code build.",
          });
        }
        let workbench;
        try {
          registrationOwnership = "abort";
          workbench = codeSettingsWorkbenchOpenResultSchema.parse(
            await bridge.request(workerId, {
              type: "code.settings.workbench.open",
              sessionId,
              profileId: scopedCodeProfileId(ownerId, "default"),
              appearance: input.data.appearance,
            }),
          );
          registrationRuntime = workbench.runtime;
        } catch (error) {
          return sendWorkerRequestFailure(reply, error);
        }
        if (
          workbench.runtime.sessionId !== sessionId ||
          !codeTunnel.registrationLeaseIsActive(registrationLease)
        ) {
          return reply.code(409).send({
            error: "Code settings changed while the workbench was opening.",
          });
        }
        const createdAttachment = await codeTunnel.createProtectedAttachment({
          authSessionId: authenticatedPrincipal(request).sessionId,
          codeTabId: "global-code-settings",
          ownerId,
          projectId: null,
          protectedRecord: input.data.protectedRecord,
          runtime: workbench.runtime,
          serverId,
          sessionId,
          stopSessionOnRelease: true,
          tunnelId: input.data.tunnelId,
          workerId,
          worktreeId: null,
          worktreePath: null,
          registrationLease,
        });
        bindingAttachmentId = createdAttachment.attachmentId;
        registrationOwnership = "binding";
        const attachment =
          codeProtectedAttachmentWireSchema.parse(createdAttachment);
        const response = reply.code(201).send(
          codeSettingsWorkbenchAttachmentWireSchema.parse({
            workerId,
            synchronization: workbench.synchronization,
            attachment,
          }),
        );
        retainBinding = true;
        return response;
      } catch (error) {
        return reply.code(503).send({ error: errorMessage(error) });
      } finally {
        if (registrationOwnership === "abort") {
          await codeTunnel.abortRegistrationSession({
            lease: registrationLease,
            runtime: registrationRuntime,
            workerId,
          });
        } else {
          codeTunnel.releaseRegistrationLease(registrationLease);
          if (
            registrationOwnership === "binding" &&
            !retainBinding &&
            bindingAttachmentId
          ) {
            await codeTunnel.revokeAttachment(bindingAttachmentId, ownerId);
          }
        }
      }
    },
  );

  app.get("/api/desktop-update/active-work", async (_request, reply) => {
    const summary =
      await repository.desktopUpdateActiveWork(applicationOwnerId());
    return reply.send(desktopUpdateActiveWorkSummarySchema.parse(summary));
  });

  app.get<{
    Querystring: {
      operationId?: string;
      projectId?: string;
      providerId?: string;
      workerId?: string;
    };
  }>("/api/skills", async (request, reply) => {
    const input = skillSettingsContextSchema.safeParse({
      workerId: request.query.workerId,
      providerId: request.query.providerId,
      projectId: request.query.projectId ?? null,
    });
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    const operationId =
      endpointContentContextSchema.shape.operationId.safeParse(
        request.query.operationId,
      );
    if (!operationId.success) {
      return reply
        .code(400)
        .send({ error: "A valid operationId is required." });
    }
    try {
      const target = await skillSettingsTarget(input.data);
      const scope = settingsCustomizationScope(input.data);
      const inventory = checkedCustomizationResponse({
        raw: await bridge.request(target.workerId, {
          type: "skills.settings.list",
          operationId: operationId.data,
          serverId,
          scope,
          cwd: target.cwd,
          providerId: target.providerId,
          providerKind: target.providerKind,
        }),
        operationId: operationId.data,
        operation: "skills.settings.list",
        scope,
      });
      return reply.send(inventory);
    } catch (error) {
      const status =
        error instanceof SkillSettingsRequestError
          ? error.statusCode
          : error instanceof WorkerUnavailableError
            ? 503
            : 502;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.get<{
    Querystring: { providerId?: string; workerId?: string };
  }>("/api/skill-audiences", async (request, reply) => {
    const input = skillAudienceContextSchema.safeParse(request.query);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    const audiences = await repository.listSkillAudiences(
      applicationOwnerId(),
      input.data.workerId,
      input.data.providerId,
    );
    return audiences
      ? reply.send(skillAudienceListSchema.parse(audiences))
      : reply.code(404).send({ error: "Worker or model provider not found." });
  });

  app.patch("/api/skill-audiences", async (request, reply) => {
    const input = skillAudienceUpdateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    const audience = await repository.updateSkillAudience(
      applicationOwnerId(),
      input.data,
    );
    if (!audience) {
      return reply
        .code(404)
        .send({ error: "Worker or model provider not found." });
    }
    publishLiveInvalidation("customization", { projectId: null });
    return reply.send(skillAudienceSummarySchema.parse(audience));
  });

  app.post("/api/skills/read", async (request, reply) => {
    try {
      const input = checkedCustomizationRequest({
        raw: request.body,
        operation: "skills.settings.read",
      });
      const settingsContext = settingsContextFromCustomizationScope(
        input.scope,
      );
      const target = await skillSettingsTarget(settingsContext);
      const scope = settingsCustomizationScope(settingsContext);
      if (!customizationScopesMatch(input.scope, scope)) {
        return reply.code(409).send({ error: "Customization scope changed." });
      }
      return reply.send(
        checkedCustomizationResponse({
          raw: await bridge.request(target.workerId, {
            type: "skills.settings.read",
            operationId: input.operationId,
            serverId,
            scope,
            protectedRequest: input.protectedRequest,
            cwd: target.cwd,
            providerId: target.providerId,
            providerKind: target.providerKind,
          }),
          operationId: input.operationId,
          operation: input.operation,
          scope,
        }),
      );
    } catch (error) {
      const status =
        error instanceof SkillSettingsRequestError
          ? error.statusCode
          : error instanceof WorkerUnavailableError
            ? 503
            : 409;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.put("/api/skills/file", async (request, reply) => {
    try {
      const input = checkedCustomizationRequest({
        raw: request.body,
        operation: "skills.settings.write",
      });
      const settingsContext = settingsContextFromCustomizationScope(
        input.scope,
      );
      const target = await skillSettingsTarget(settingsContext);
      const scope = settingsCustomizationScope(settingsContext);
      if (!customizationScopesMatch(input.scope, scope)) {
        return reply.code(409).send({ error: "Customization scope changed." });
      }
      const result = checkedCustomizationResponse({
        raw: await bridge.request(target.workerId, {
          type: "skills.settings.write",
          operationId: input.operationId,
          serverId,
          scope,
          protectedRequest: input.protectedRequest,
          cwd: target.cwd,
          providerId: target.providerId,
          providerKind: target.providerKind,
        }),
        operationId: input.operationId,
        operation: input.operation,
        scope,
      });
      if (result.result === "succeeded") {
        publishLiveInvalidation("customization", {
          projectId: input.scope.projectId,
        });
      }
      return reply.send(result);
    } catch (error) {
      const status =
        error instanceof SkillSettingsRequestError
          ? error.statusCode
          : error instanceof WorkerUnavailableError
            ? 503
            : 409;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.delete("/api/skills", async (request, reply) => {
    try {
      const input = checkedCustomizationRequest({
        raw: request.body,
        operation: "skills.settings.delete",
      });
      const settingsContext = settingsContextFromCustomizationScope(
        input.scope,
      );
      const target = await skillSettingsTarget(settingsContext);
      const scope = settingsCustomizationScope(settingsContext);
      if (!customizationScopesMatch(input.scope, scope)) {
        return reply.code(409).send({ error: "Customization scope changed." });
      }
      const result = checkedCustomizationResponse({
        raw: await bridge.request(target.workerId, {
          type: "skills.settings.delete",
          operationId: input.operationId,
          serverId,
          scope,
          protectedRequest: input.protectedRequest,
          cwd: target.cwd,
          providerId: target.providerId,
          providerKind: target.providerKind,
        }),
        operationId: input.operationId,
        operation: input.operation,
        scope,
      });
      if (result.result === "succeeded") {
        publishLiveInvalidation("customization", {
          projectId: input.scope.projectId,
        });
      }
      return reply.send(result);
    } catch (error) {
      const status =
        error instanceof SkillSettingsRequestError
          ? error.statusCode
          : error instanceof WorkerUnavailableError
            ? 503
            : 409;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/settings/mcp-servers", async (_request, reply) => {
    const servers = await repository.listMcpServers(applicationOwnerId(), null);
    return reply.send(mcpServerWireListSchema.parse(servers ?? []));
  });

  app.get<{ Params: { workerId: string } }>(
    "/api/settings/mcp-discovery/:workerId",
    async (request, reply) => {
      const ownerId = applicationOwnerId();
      const worker = await repository.getWorker(
        ownerId,
        request.params.workerId,
      );
      if (!worker) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      if (!worker.online || !bridge.isConnected(worker.workerId)) {
        return reply.code(503).send({ error: "Worker is offline." });
      }
      try {
        const result = await bridge.request(
          worker.workerId,
          { type: "mcp.configurations.discover", projectRoot: null },
          { timeoutMs: 20_000 },
        );
        return reply.send(mcpServerDiscoveryResultSchema.parse(result));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post("/api/settings/mcp-servers", async (request, reply) => {
    const input = encryptedMcpServerCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      const server = await repository.createMcpServer(
        applicationOwnerId(),
        null,
        input.data,
      );
      return reply.code(201).send(mcpServerWireSummarySchema.parse(server));
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Params: { serverId: string } }>(
    "/api/settings/mcp-servers/:serverId",
    async (request, reply) => {
      const input = encryptedMcpServerUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const server = await repository.updateMcpServer(
          applicationOwnerId(),
          null,
          request.params.serverId,
          input.data,
        );
        return server
          ? reply.send(mcpServerWireSummarySchema.parse(server))
          : reply.code(404).send({ error: "MCP server not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.delete<{ Params: { serverId: string } }>(
    "/api/settings/mcp-servers/:serverId",
    async (request, reply) => {
      try {
        return (await repository.deleteMcpServer(
          applicationOwnerId(),
          null,
          request.params.serverId,
        ))
          ? reply.code(204).send()
          : reply.code(404).send({ error: "MCP server not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.patch("/api/settings", async (request, reply) => {
    const input = userSettingsUpdateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    const modelConfigurationFields = [
      "defaultModelId",
      "defaultReasoningEffort",
      "defaultCustomSubagentModel",
      "defaultSubagentModelId",
      "defaultSubagentReasoningEffort",
    ] as const;
    if (modelConfigurationFields.some((field) => field in input.data)) {
      const current = await repository.getUserSettings(applicationOwnerId());
      const configuration = modelConfigurationSchema.safeParse({
        modelId:
          input.data.defaultModelId !== undefined
            ? input.data.defaultModelId
            : current.defaultModelId,
        reasoningEffort:
          input.data.defaultReasoningEffort !== undefined
            ? input.data.defaultReasoningEffort
            : current.defaultReasoningEffort,
        customSubagentModel:
          input.data.defaultCustomSubagentModel ??
          current.defaultCustomSubagentModel,
        subagentModelId:
          input.data.defaultSubagentModelId !== undefined
            ? input.data.defaultSubagentModelId
            : current.defaultSubagentModelId,
        subagentReasoningEffort:
          input.data.defaultSubagentReasoningEffort !== undefined
            ? input.data.defaultSubagentReasoningEffort
            : current.defaultSubagentReasoningEffort,
      });
      if (!configuration.success) {
        return reply.code(400).send(invalidBody(configuration.error.issues));
      }
      try {
        await configuredRoutePairsForDefaults(configuration.data);
      } catch (error) {
        const response = sendModelConfigurationResolutionFailure(reply, error);
        if (response) return response;
        throw error;
      }
    }
    if (
      "defaultChatModelId" in input.data ||
      "defaultChatReasoningEffort" in input.data
    ) {
      const current = await repository.getUserSettings(applicationOwnerId());
      const configuration = modelConfigurationSchema.safeParse({
        modelId:
          input.data.defaultChatModelId !== undefined
            ? input.data.defaultChatModelId
            : current.defaultChatModelId,
        reasoningEffort:
          input.data.defaultChatReasoningEffort !== undefined
            ? input.data.defaultChatReasoningEffort
            : current.defaultChatReasoningEffort,
        customSubagentModel: false,
        subagentModelId: null,
        subagentReasoningEffort: null,
      });
      if (!configuration.success) {
        return reply.code(400).send(invalidBody(configuration.error.issues));
      }
      try {
        await configuredRoutePairsForDefaults(configuration.data);
      } catch (error) {
        const response = sendModelConfigurationResolutionFailure(reply, error);
        if (response) return response;
        throw error;
      }
    }
    const settings = await repository.updateSettings(
      applicationOwnerId(),
      input.data,
    );
    if (!settings) {
      return reply
        .code(400)
        .send({ error: "Default model or worker was not found." });
    }
    return reply.send(settingsBundleWireSchema.parse(settings));
  });

  app.patch("/api/settings/destination", async (request, reply) => {
    const input = appDestinationUpdateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    const destination = await repository.updateAppDestination(
      applicationOwnerId(),
      input.data,
    );
    return destination
      ? reply.send(appDestinationSchema.parse(destination))
      : reply.code(409).send({
          error:
            "The saved destination changed or the requested destination is unavailable.",
        });
  });

  app.post("/api/settings/providers", async (request, reply) => {
    const input = encryptedModelProviderCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      const provider = await repository.createModelProvider(
        applicationOwnerId(),
        input.data,
      );
      if (isZaiCodingPlanProvider(provider)) {
        await loadProviderCatalog(
          applicationOwnerId(),
          provider.id,
          undefined,
          false,
        );
      } else if (provider.kind === "ollama") {
        void loadProviderCatalog(
          applicationOwnerId(),
          provider.id,
          undefined,
          false,
        ).catch(() => undefined);
      }
      return reply
        .code(201)
        .send(modelProviderWireSummarySchema.parse(provider));
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { providerId: string } }>(
    "/api/settings/providers/:providerId",
    async (request, reply) => {
      try {
        const ownerId = applicationOwnerId();
        const provider = await repository.getModelProvider(
          ownerId,
          request.params.providerId,
        );
        if (!provider) {
          return reply.code(404).send({ error: "Provider not found." });
        }
        if (isAccountProviderKind(provider.kind)) {
          if (
            await repository.hasModelRoutesForProvider(
              ownerId,
              request.params.providerId,
            )
          ) {
            return reply.code(409).send({
              error:
                "Delete the provider's models before deleting the provider.",
            });
          }
          const accounts =
            (await repository.listModelProviderAccounts(
              ownerId,
              provider.id,
            )) ?? [];
          for (const { id: accountId } of accounts) {
            const account = await resolveAccountAuthTarget(
              provider.id,
              accountId,
            );
            await prepareProviderAccountSignOut(account, provider.id);
            await providerAccountLifecycle.signOut({
              accountId,
              credentialHomeKey: account.credentialHomeKey,
              kind: provider.kind,
              ownerId,
              providerId: provider.id,
            });
          }
        }
        openRouterRuntimeCatalogs.invalidate(request.params.providerId);
        const deleted = await repository.deleteModelProvider(
          ownerId,
          request.params.providerId,
        );
        return deleted
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Provider not found." });
      } catch (error) {
        if (error instanceof ProviderAccountReconnectRequiredError) {
          return reply.code(409).send({ error: error.message });
        }
        return reply.code(409).send({
          error: "Delete the provider's models before deleting the provider.",
        });
      }
    },
  );

  app.patch<{ Params: { providerId: string } }>(
    "/api/settings/providers/:providerId",
    async (request, reply) => {
      const input = encryptedModelProviderUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        openRouterRuntimeCatalogs.invalidate(request.params.providerId);
        const provider = await repository.updateModelProvider(
          applicationOwnerId(),
          request.params.providerId,
          input.data,
        );
        if (provider && isZaiCodingPlanProvider(provider)) {
          await loadProviderCatalog(
            applicationOwnerId(),
            provider.id,
            undefined,
            true,
          );
        } else if (provider?.kind === "ollama") {
          void loadProviderCatalog(
            applicationOwnerId(),
            provider.id,
            undefined,
            true,
          ).catch(() => undefined);
        }
        return provider
          ? reply.send(modelProviderWireSummarySchema.parse(provider))
          : reply.code(404).send({ error: "Provider not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  const loadProviderCatalogUnchecked = async (
    ownerId: string,
    providerId: string,
    workerId: string | undefined,
    force: boolean,
    accountId?: string,
    quotaTrigger?: string,
  ) => {
    const provider = await repository.getModelProviderCatalogRuntime(
      ownerId,
      providerId,
    );
    if (!provider) return null;
    if (isZaiCodingPlanProvider(provider)) {
      return zaiCatalogService.getProviderCatalog(ownerId, providerId);
    }
    if (provider.kind !== "ollama" && !isAccountProviderKind(provider.kind)) {
      const catalog = await providerCatalogService.getProviderCatalog(
        ownerId,
        providerId,
        force,
      );
      if (catalog) openRouterRuntimeCatalogs.markHydrated(providerId);
      return catalog;
    }
    let selectedWorkerId = workerId;
    if (!selectedWorkerId) {
      const [preferences, workers] = await Promise.all([
        repository.getUserSettings(ownerId),
        repository.listWorkers(ownerId),
      ]);
      const defaultWorkerId = preferences.defaultWorkerId;
      selectedWorkerId =
        (defaultWorkerId && bridge.isConnected(defaultWorkerId)
          ? defaultWorkerId
          : workers.find((worker) => bridge.isConnected(worker.workerId))
              ?.workerId) ??
        defaultWorkerId ??
        undefined;
    }
    if (!selectedWorkerId) {
      const label = isAccountProviderKind(provider.kind)
        ? accountProviderLabel(provider.kind)
        : "Ollama";
      throw new Error(`No worker is available for ${label} discovery.`);
    }
    if (provider.kind === "chatgpt") {
      return chatGptCatalogService.getProviderCatalog(
        ownerId,
        providerId,
        selectedWorkerId,
        force,
        accountId,
        quotaTrigger,
      );
    }
    if (provider.kind === "grok") {
      return grokCatalogService.getProviderCatalog(
        ownerId,
        providerId,
        selectedWorkerId,
        force,
        accountId,
        quotaTrigger,
      );
    }
    return ollamaCatalogService.getProviderCatalog(
      ownerId,
      providerId,
      selectedWorkerId,
      force,
    );
  };

  const loadProviderCatalog = async (
    ownerId: string,
    providerId: string,
    workerId: string | undefined,
    force: boolean,
    accountId?: string,
    quotaTrigger?: string,
  ) => {
    const startedAtMs = Date.now();
    serverLogger.event("debug", "Provider catalog refresh began", {
      event: "provider.catalog.refresh-started",
      subsystem: "provider-catalog",
      operation: "refresh",
      status: "refreshing",
      providerId,
      workerId,
    });
    try {
      const catalog = await loadProviderCatalogUnchecked(
        ownerId,
        providerId,
        workerId,
        force,
        accountId,
        quotaTrigger,
      );
      serverLogger.event("info", "Provider catalog refresh completed", {
        event: "provider.catalog.refresh-completed",
        subsystem: "provider-catalog",
        operation: "refresh",
        status: catalog ? "completed" : "not-applicable",
        durationMs: Date.now() - startedAtMs,
        providerId,
        workerId,
      });
      return catalog;
    } catch (error) {
      serverLogger.rateLimited(
        `provider-catalog-refresh-failed:${providerId}:${workerId ?? "automatic"}`,
        "warn",
        "Provider catalog refresh failed",
        {
          event: "provider.catalog.refresh-failed",
          subsystem: "provider-catalog",
          operation: "refresh",
          reasonCode: "catalog-unavailable",
          status: "failed",
          durationMs: Date.now() - startedAtMs,
          providerId,
          workerId,
        },
        { summaryEvery: 10, windowMs: 5 * 60_000 },
      );
      throw error;
    }
  };

  const catalogWorkers = new Map<string, string>();
  const refreshWorkerScopedCatalogs = async (
    ownerId: string,
    workerId: string,
    quotaTrigger: "periodic-refresh" | "worker-reconnected",
  ) => {
    const [providers, worker] = await Promise.all([
      repository.listModelProviderRefreshTargets(ownerId),
      repository.getWorker(ownerId, workerId),
    ]);
    await Promise.allSettled(
      providers
        .filter((provider) => canRefreshProviderOnWorker(provider.kind, worker))
        .map((provider) =>
          loadProviderCatalog(ownerId, provider.id, workerId, false),
        ),
    );
    await Promise.allSettled(
      providers.flatMap((provider) => {
        if (
          !isAccountProviderKind(provider.kind) ||
          !canRefreshProviderOnWorker(provider.kind, worker)
        ) {
          return [];
        }
        const providerKind = provider.kind;
        return provider.accounts
          .filter((account) => account.enabled)
          .map(async (account) => {
            const runtime = await repository.getModelProviderAccountRuntime(
              ownerId,
              provider.id,
              account.id,
            );
            if (!runtime) return;
            await readAndPersistProviderQuotaSnapshot(repository, bridge, {
              ownerId,
              providerId: provider.id,
              accountId: account.id,
              accountPlanType: account.planType,
              workerId,
              trigger: quotaTrigger,
              provider: {
                name: provider.name,
                kind: providerKind,
                baseUrl: provider.baseUrl,
                credentialHomeKey: runtime.credentialHomeKey,
              },
            });
          });
      }),
    );
  };
  const workerCatalogRefreshTimer = setInterval(() => {
    for (const [workerId, ownerId] of catalogWorkers) {
      if (!bridge.isConnected(workerId)) continue;
      void refreshWorkerScopedCatalogs(
        ownerId,
        workerId,
        "periodic-refresh",
      ).catch(() => undefined);
    }
  }, 15 * 60_000);
  workerCatalogRefreshTimer.unref();

  const providerCatalogFailureStatus = (message: string) => {
    if (message === "Worker not found.") return 404;
    if (
      message.includes("not an OpenRouter") ||
      message.includes("not an Ollama") ||
      message.includes("not a ChatGPT") ||
      message.includes("not a Grok") ||
      message.includes("not a Z.ai")
    ) {
      return 409;
    }
    if (
      message.includes("worker is available") ||
      message.includes("offline") ||
      message.includes("signed-in ChatGPT") ||
      message.includes("signed-in Grok")
    ) {
      return 503;
    }
    return 502;
  };

  app.get<{
    Params: { providerId: string };
    Querystring: { workerId?: string };
  }>("/api/settings/providers/:providerId/catalog", async (request, reply) => {
    try {
      const catalog = await loadProviderCatalog(
        applicationOwnerId(),
        request.params.providerId,
        request.query.workerId,
        false,
      );
      return catalog
        ? reply.send(providerModelCatalogResultSchema.parse(catalog))
        : reply.code(404).send({ error: "Provider not found." });
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(providerCatalogFailureStatus(message)).send({
        error: message,
      });
    }
  });

  app.post<{
    Params: { providerId: string };
    Querystring: { workerId?: string };
  }>(
    "/api/settings/providers/:providerId/catalog/refresh",
    async (request, reply) => {
      try {
        const catalog = await loadProviderCatalog(
          applicationOwnerId(),
          request.params.providerId,
          request.query.workerId,
          true,
          undefined,
          "manual-refresh",
        );
        return catalog
          ? reply.send(providerModelCatalogResultSchema.parse(catalog))
          : reply.code(404).send({ error: "Provider not found." });
      } catch (error) {
        const message = errorMessage(error);
        return reply.code(providerCatalogFailureStatus(message)).send({
          error: message,
        });
      }
    },
  );

  app.post<{
    Params: { providerId: string };
    Querystring: { workerId?: string };
  }>("/api/settings/providers/:providerId/test", async (request, reply) => {
    const startedAtMs = Date.now();
    const ownerId = applicationOwnerId();
    const provider = await repository.getModelProvider(
      ownerId,
      request.params.providerId,
    );
    if (!provider) {
      return reply.code(404).send({ error: "Provider not found." });
    }
    if (!isZaiCodingPlanProvider(provider)) {
      return reply.code(409).send({
        error:
          "Connection testing is currently available for Z.ai Coding Plan providers.",
      });
    }

    const runtimes = (await repository.getModelRuntimes(ownerId)).filter(
      (runtime) => runtime.provider.id === provider.id,
    );
    const runtime =
      runtimes.find(({ model }) => model.name === "glm-5.3") ?? runtimes[0];
    if (!runtime) {
      return reply.send(
        providerConnectionTestResultSchema.parse({
          ok: false,
          stage: "model-availability",
          message:
            "No enabled Z.ai model route is available. Refresh the bundled catalog and try again.",
          workerId: null,
          modelName: null,
          durationMs: Date.now() - startedAtMs,
        }),
      );
    }

    const [preferences, workers] = await Promise.all([
      repository.getUserSettings(ownerId),
      repository.listWorkers(ownerId),
    ]);
    const requestedWorkerId = request.query.workerId;
    const requestedWorker = requestedWorkerId
      ? workers.find(({ workerId }) => workerId === requestedWorkerId)
      : null;
    const defaultWorkerId = preferences.defaultWorkerId;
    const workerId = requestedWorkerId
      ? (requestedWorker?.workerId ?? null)
      : defaultWorkerId && bridge.isConnected(defaultWorkerId)
        ? defaultWorkerId
        : (workers.find(({ workerId }) => bridge.isConnected(workerId))
            ?.workerId ?? null);
    if (!workerId || !bridge.isConnected(workerId)) {
      return reply.send(
        providerConnectionTestResultSchema.parse({
          ok: false,
          stage: "worker-placement",
          message: request.query.workerId
            ? "The selected worker is offline or unavailable."
            : "No compatible online worker could run the test.",
          workerId: workerId ?? requestedWorkerId ?? null,
          modelName: runtime.model.name,
          durationMs: Date.now() - startedAtMs,
        }),
      );
    }

    try {
      workerProviderConnectionTestResultSchema.parse(
        await bridge.request(
          workerId,
          {
            type: "model.provider.test",
            model: runtime.model,
            provider: runtime.provider,
          },
          { ownerId, timeoutMs: 120_000 },
        ),
      );
      return reply.send(
        providerConnectionTestResultSchema.parse({
          ok: true,
          stage: "completed",
          message: `Connected to Z.ai through bundled Codex using ${runtime.model.name}.`,
          workerId,
          modelName: runtime.model.name,
          durationMs: Date.now() - startedAtMs,
        }),
      );
    } catch (error) {
      const detail = errorMessage(error);
      const stage = providerConnectionFailureStage(detail);
      return reply.send(
        providerConnectionTestResultSchema.parse({
          ok: false,
          stage,
          message: providerConnectionFailureMessage(stage, detail),
          workerId,
          modelName: runtime.model.name,
          durationMs: Date.now() - startedAtMs,
        }),
      );
    }
  });

  app.post("/api/settings/models", async (request, reply) => {
    const input = modelProfileCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      const model = await repository.createModelProfile(
        applicationOwnerId(),
        input.data,
      );
      if (!model) {
        return reply.code(404).send({ error: "Provider not found." });
      }
      return reply.code(201).send(modelProfileSummarySchema.parse(model));
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { modelId: string } }>(
    "/api/settings/models/:modelId/reasoning",
    async (request, reply) => {
      const modelId = request.params.modelId.trim();
      const runtimes = await repository.getModelRuntimes(
        applicationOwnerId(),
        modelId,
      );
      if (!runtimes.length) {
        return reply.code(404).send({ error: "Model not found." });
      }
      const reasoningEffort =
        (await repository.getModelReasoningDefault(
          applicationOwnerId(),
          modelId,
        )) ?? null;
      return reply.send(
        chatReasoningStateSchema.parse(
          configurationReasoningStateForRuntimes(
            modelId,
            reasoningEffort,
            runtimes,
          ),
        ),
      );
    },
  );

  app.get("/api/settings/task-workers", async (_request, reply) => {
    const taskWorkers =
      await repository.taskScheduling.listTaskWorkers(applicationOwnerId());
    return reply.send(taskWorkerListSchema.parse(taskWorkers));
  });

  app.post("/api/settings/task-workers", async (request, reply) => {
    const input = taskWorkerCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      const taskWorker = await repository.taskScheduling.createTaskWorker(
        applicationOwnerId(),
        input.data,
      );
      publishLiveInvalidation("settings", { entityId: taskWorker.id });
      return reply.code(201).send(taskWorkerSummarySchema.parse(taskWorker));
    } catch (error) {
      if (error instanceof TaskSchedulingConflictError) {
        return reply.code(409).send({ code: error.code, error: error.message });
      }
      throw error;
    }
  });

  app.patch<{ Params: { taskWorkerId: string } }>(
    "/api/settings/task-workers/:taskWorkerId",
    async (request, reply) => {
      const input = taskWorkerUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const taskWorker = await repository.taskScheduling.updateTaskWorker(
          applicationOwnerId(),
          request.params.taskWorkerId,
          input.data,
        );
        if (taskWorker) {
          publishLiveInvalidation("settings", { entityId: taskWorker.id });
        }
        return taskWorker
          ? reply.send(taskWorkerSummarySchema.parse(taskWorker))
          : reply.code(404).send({ error: "Task Worker not found." });
      } catch (error) {
        if (error instanceof TaskSchedulingConflictError) {
          return reply
            .code(409)
            .send({ code: error.code, error: error.message });
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: { taskWorkerId: string } }>(
    "/api/settings/task-workers/:taskWorkerId",
    async (request, reply) => {
      const input = taskWorkerDeleteSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const deleted = await repository.taskScheduling.deleteTaskWorker(
          applicationOwnerId(),
          request.params.taskWorkerId,
          input.data.rowVersion,
        );
        if (deleted) {
          publishLiveInvalidation("settings", {
            entityId: request.params.taskWorkerId,
          });
        }
        return deleted
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Task Worker not found." });
      } catch (error) {
        if (error instanceof TaskSchedulingConflictError) {
          return reply
            .code(409)
            .send({ code: error.code, error: error.message });
        }
        throw error;
      }
    },
  );

  app.put("/api/settings/task-workers/order", async (request, reply) => {
    const input = taskWorkerOrderUpdateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      const taskWorkers = await repository.taskScheduling.reorderTaskWorkers(
        applicationOwnerId(),
        input.data,
      );
      publishLiveInvalidation("settings");
      return reply.send(taskWorkerListSchema.parse(taskWorkers));
    } catch (error) {
      if (error instanceof TaskSchedulingConflictError) {
        return reply.code(409).send({ code: error.code, error: error.message });
      }
      throw error;
    }
  });

  app.delete<{ Params: { modelId: string } }>(
    "/api/settings/models/:modelId",
    async (request, reply) => {
      try {
        const deleted = await repository.deleteModelProfile(
          applicationOwnerId(),
          request.params.modelId,
        );
        return deleted
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Model not found." });
      } catch {
        return reply.code(409).send({
          error: "This model is the default or selected by an existing chat.",
        });
      }
    },
  );

  app.patch<{ Params: { modelId: string } }>(
    "/api/settings/models/:modelId",
    async (request, reply) => {
      const input = modelProfileUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const model = await repository.updateModelProfile(
          applicationOwnerId(),
          request.params.modelId,
          input.data,
        );
        return model
          ? reply.send(modelProfileSummarySchema.parse(model))
          : reply.code(404).send({ error: "Model or provider not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  return {
    catalogWorkers,
    loadProviderCatalog,
    refreshWorkerScopedCatalogs,
    workerCatalogRefreshTimer,
  };
}
