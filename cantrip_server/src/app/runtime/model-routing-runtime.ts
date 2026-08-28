import {
  NATIVE_SUBAGENT_PROTOCOL_VERSION,
  customizationContentScopeSchema,
  modelConfigurationFailureSchema,
  nativeSubagentCapabilityCompatible,
  protectedCustomizationRequestSchema,
  protectedCustomizationResponseSchema,
  skillSettingsContextSchema,
  type ModelConfiguration,
  type ProviderQuotaSnapshot,
  type ReasoningEffort,
} from "@cantrip/protocol";
import type {
  CustomizationContentOperation,
  CustomizationContentScope,
} from "@cantrip/protocol/customization-content";
import { cantripVersion } from "@cantrip/version";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { ModelBehaviorTracker } from "../../analytics/model-behavior.js";
import type {
  ChatExecutionContext,
  ModelRuntime,
  ServerRepository,
} from "../../db/repository.js";
import { errorMessage } from "../../http/request-helpers.js";
import { isAccountProviderKind } from "../../models/account-provider.js";
import { resolveAccountProviderRuntimes } from "../../models/chatgpt-account-routing.js";
import { evaluateModelRouteAvailability } from "../../models/model-route-availability.js";
import type { OpenRouterRuntimeCatalogHydrator } from "../../models/openrouter-runtime-catalog.js";
import { readAndPersistProviderQuotaSnapshot } from "../../models/provider-quota.js";
import {
  prepareRuntimesForReasoning,
  reasoningStateForRuntimes,
} from "../../models/reasoning.js";
import {
  ModelConfigurationResolutionError,
  modelConfigurationFailure,
  resolveModelRoutePairs,
  type ResolvedModelRoutePair,
} from "../../models/subagent-routing.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import { serverLogger } from "../../logger.js";
import { SkillSettingsRequestError } from "../shared/errors.js";

export interface ModelRoutingRuntimeDependencies {
  app: Pick<FastifyInstance, "log">;
  applicationOwnerId: () => string;
  bridge: LimitedWorkerCommandBus;
  openRouterRuntimeCatalogs: OpenRouterRuntimeCatalogHydrator;
  publishProjectTokenUsageChange: (
    ownerId: string,
    projectId: string,
    immediate: boolean,
  ) => void;
  repository: ServerRepository;
  routeCooldowns: Map<string, number>;
  runtimeCooldownKey: (runtime: ModelRuntime) => string;
}

/**
 * Owns model route selection, reasoning preparation, protected customization,
 * analytics persistence, and provider quota sampling.
 */
export function createModelRoutingRuntime({
  app,
  applicationOwnerId,
  bridge,
  openRouterRuntimeCatalogs,
  publishProjectTokenUsageChange,
  repository,
  routeCooldowns,
  runtimeCooldownKey,
}: ModelRoutingRuntimeDependencies) {
  const resolveModelId = async (
    context: ChatExecutionContext,
    requestedModelId?: string,
  ): Promise<string> => {
    const defaultModelId = context.modelId
      ? null
      : (await repository.getUserSettings(applicationOwnerId())).defaultModelId;
    const modelId = requestedModelId ?? context.modelId ?? defaultModelId;
    if (!modelId) {
      throw new Error(
        "Choose a model or configure a default model in Settings.",
      );
    }
    return modelId;
  };

  const availableModelRuntimes = async (
    context: { providerAccountId?: string | null; workerId: string },
    modelId: string,
  ): Promise<ModelRuntime[]> => {
    let runtimes = await repository.getModelRuntimes(
      applicationOwnerId(),
      modelId,
    );
    if (await openRouterRuntimeCatalogs.hydrate(runtimes)) {
      // Catalog reconciliation binds legacy name-only routes and supplies the
      // reasoning/capability metadata used by both the composer and Codex.
      runtimes = await repository.getModelRuntimes(
        applicationOwnerId(),
        modelId,
      );
    }
    if (!runtimes.length) {
      throw new Error("The selected model has no enabled provider routes.");
    }
    const now = Date.now();
    const available: ModelRuntime[] = [];
    const unavailable: string[] = [];
    for (const runtime of runtimes) {
      if (!isAccountProviderKind(runtime.provider.kind)) {
        const catalogAvailability = runtime.model.providerModelId
          ? await repository.listProviderModelAvailability(
              applicationOwnerId(),
              runtime.provider.id,
              runtime.model.providerModelId,
            )
          : [];
        const eligibility = evaluateModelRouteAvailability(
          runtime,
          catalogAvailability,
          context.workerId,
        );
        if (!eligibility.available) {
          unavailable.push(
            `${runtime.provider.name}: ${eligibility.reason ?? "model unavailable"}`,
          );
          continue;
        }
        const cooldownUntil =
          routeCooldowns.get(runtimeCooldownKey(runtime)) ?? 0;
        if (cooldownUntil > now) {
          unavailable.push(`${runtime.provider.name} is cooling down`);
          continue;
        }
        available.push(runtime);
        continue;
      }

      const accountRouting = await resolveAccountProviderRuntimes({
        ownerId: applicationOwnerId(),
        preferredAccountId: context.providerAccountId,
        repository,
        runtime,
        workerId: context.workerId,
      });
      unavailable.push(...accountRouting.unavailable);
      for (const accountRuntime of accountRouting.runtimes) {
        const cooldownUntil =
          routeCooldowns.get(runtimeCooldownKey(accountRuntime)) ?? 0;
        if (cooldownUntil > now) {
          unavailable.push(`${runtime.provider.name} account is cooling down`);
          continue;
        }
        available.push(accountRuntime);
      }
    }
    if (!available.length) {
      serverLogger.rateLimited(
        `provider-routing-unavailable:${context.workerId}:${context.providerAccountId ?? "automatic"}`,
        "warn",
        "No provider route is currently available",
        {
          event: "provider.routing.unavailable",
          subsystem: "provider-routing",
          operation: "resolve-routes",
          reasonCode: "no-eligible-routes",
          status: "unavailable",
          workerId: context.workerId,
          counts: {
            configuredRoutes: runtimes.length,
            unavailableRoutes: unavailable.length,
          },
        },
        { summaryEvery: 10, windowMs: 60_000 },
      );
      throw new Error(
        `No provider route is currently available${unavailable.length ? `: ${unavailable.join("; ")}` : "."}`,
      );
    }
    serverLogger.sampled(
      `provider-routing-resolved:${context.workerId}`,
      20,
      "debug",
      "Provider routes resolved",
      {
        event: "provider.routing.resolved",
        subsystem: "provider-routing",
        operation: "resolve-routes",
        status: "ready",
        workerId: context.workerId,
        counts: {
          configuredRoutes: runtimes.length,
          availableRoutes: available.length,
          unavailableRoutes: unavailable.length,
        },
      },
    );
    return available;
  };

  const routePairsForConfiguration = async (
    context: ChatExecutionContext,
    configuration: ModelConfiguration,
    rootRuntimes?: ModelRuntime[],
  ): Promise<ResolvedModelRoutePair[]> => {
    if (!bridge.isConnected(context.workerId)) {
      return resolveModelRoutePairs({
        configuration,
        rootRuntimes: [],
        workerConnected: false,
      });
    }
    if (!configuration.modelId) {
      return resolveModelRoutePairs({ configuration, rootRuntimes: [] });
    }
    if (configuration.customSubagentModel) {
      const worker = await repository.getWorker(
        applicationOwnerId(),
        context.workerId,
      );
      if (
        !worker ||
        !nativeSubagentCapabilityCompatible(worker.codexRuntime.nativeSubagents)
      ) {
        const capability = worker?.codexRuntime.nativeSubagents;
        throw new ModelConfigurationResolutionError({
          code: "worker-subagents-unavailable",
          error:
            capability?.available === true &&
            capability.protocolVersion !== null
              ? `The selected worker reports native subagent protocol ${capability.protocolVersion}, but this server supports protocol ${NATIVE_SUBAGENT_PROTOCOL_VERSION}.`
              : (capability?.reason ??
                "The selected worker does not support native subagents."),
          field: "customSubagentModel",
          retryable: false,
        });
      }
    }

    let availableRoots: ModelRuntime[];
    try {
      availableRoots =
        rootRuntimes ??
        (await availableModelRuntimes(context, configuration.modelId));
    } catch (error) {
      throw new ModelConfigurationResolutionError({
        code: "root-model-unavailable",
        error: errorMessage(error),
        field: "modelId",
        retryable: true,
      });
    }

    let availableSubagents: ModelRuntime[] | undefined;
    if (configuration.customSubagentModel) {
      if (!configuration.subagentModelId) {
        availableSubagents = [];
      } else {
        try {
          availableSubagents = await availableModelRuntimes(
            { ...context, providerAccountId: null },
            configuration.subagentModelId,
          );
        } catch (error) {
          throw new ModelConfigurationResolutionError({
            code: "subagent-model-unavailable",
            error: errorMessage(error),
            field: "subagentModelId",
            retryable: true,
          });
        }
      }
    }
    return resolveModelRoutePairs({
      configuration,
      rootRuntimes: availableRoots,
      subagentRuntimes: availableSubagents,
    });
  };

  const configuredRoutePairsForDefaults = async (
    configuration: ModelConfiguration,
  ): Promise<ResolvedModelRoutePair[]> => {
    if (!configuration.modelId) {
      return configuration.customSubagentModel
        ? resolveModelRoutePairs({ configuration, rootRuntimes: [] })
        : [];
    }
    const [rootRuntimes, subagentRuntimes] = await Promise.all([
      repository.getModelRuntimes(applicationOwnerId(), configuration.modelId),
      configuration.customSubagentModel && configuration.subagentModelId
        ? repository.getModelRuntimes(
            applicationOwnerId(),
            configuration.subagentModelId,
          )
        : Promise.resolve(undefined),
    ]);
    return resolveModelRoutePairs({
      configuration,
      rootRuntimes,
      subagentRuntimes,
    });
  };

  const sendModelConfigurationResolutionFailure = (
    reply: FastifyReply,
    error: unknown,
  ) => {
    const failure = modelConfigurationFailure(error);
    if (!failure) return null;
    return reply
      .code(failure.code === "worker-offline" ? 503 : 409)
      .send(modelConfigurationFailureSchema.parse(failure));
  };

  const runtimeForContext = async (
    context: ChatExecutionContext,
  ): Promise<ModelRuntime | null> => {
    if (context.modelRouteId) {
      const active = await repository.getModelRuntimeByRoute(
        applicationOwnerId(),
        context.modelRouteId,
      );
      if (active) {
        const selected = (
          await availableModelRuntimes(context, active.model.id)
        ).find((runtime) => runtime.routeId === active.routeId);
        return selected
          ? prepareRuntimesForReasoning([selected], context.reasoningEffort)[0]!
              .runtime
          : null;
      }
    }
    const modelId = await resolveModelId(context);
    const runtimes = await availableModelRuntimes(context, modelId);
    return (
      prepareRuntimesForReasoning(runtimes, context.reasoningEffort)[0]
        ?.runtime ?? null
    );
  };

  const reasoningStateForContext = async (
    context: ChatExecutionContext,
    requestedModelId?: string,
    requestedReasoningEffort: ReasoningEffort | null = context.reasoningEffort,
  ) => {
    const modelId = requestedModelId ?? (await resolveModelId(context));
    return reasoningStateForRuntimes(
      modelId,
      requestedReasoningEffort,
      await availableModelRuntimes(context, modelId),
    );
  };

  const runtimeCanResumeContext = (
    context: ChatExecutionContext,
    runtime: ModelRuntime,
  ): boolean =>
    runtime.routeId === context.modelRouteId &&
    runtime.provider.accountId === context.providerAccountId;

  const recordRuntimeTokenUsage = async (
    sourceKey: string,
    projectId: string | null,
    chatId: string | null,
    runtime: ModelRuntime,
    usage:
      | {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
          cachedInputTokens?: number;
          reasoningOutputTokens?: number;
          cacheWriteInputTokens?: number;
        }
      | undefined,
    attribution: {
      workerId?: string | null;
      turnId?: string | null;
      executionAttemptId?: string | null;
      attemptKind?: string;
      attemptStatus?:
        | "running"
        | "completed"
        | "failed"
        | "cancelled"
        | "interrupted"
        | "compacted";
      startedAt?: Date;
      completedAt?: Date | null;
      finalizedAt?: Date | null;
      codexVersion?: string | null;
    } = {},
  ): Promise<void> => {
    try {
      const ownerId = applicationOwnerId();
      await repository.recordTokenUsage(ownerId, {
        sourceKey,
        projectId,
        chatId,
        modelRouteId: runtime.routeId,
        providerAccountId: runtime.provider.accountId,
        workerId: attribution.workerId,
        turnId: attribution.turnId,
        executionAttemptId: attribution.executionAttemptId,
        attemptKind: attribution.attemptKind,
        attemptStatus: attribution.attemptStatus,
        reasoningEffort: runtime.model.reasoningEffort,
        workerVersion: null,
        serverVersion: cantripVersion.version,
        codexVersion: attribution.codexVersion,
        startedAt: attribution.startedAt,
        completedAt: attribution.completedAt,
        finalizedAt: attribution.finalizedAt,
        usage,
      });
      if (projectId) {
        publishProjectTokenUsageChange(
          ownerId,
          projectId,
          attribution.attemptStatus !== undefined &&
            attribution.attemptStatus !== "running",
        );
      }
    } catch (error) {
      app.log.warn(
        { err: error, sourceKey },
        "Unable to persist token usage analytics",
      );
    }
  };

  const recordRuntimeModelBehavior = async (
    sourceKey: string,
    execution: ChatExecutionContext,
    runtime: ModelRuntime,
    tracker: ModelBehaviorTracker,
    attribution: {
      executionAttemptId: string;
      attemptStatus:
        "running" | "completed" | "failed" | "cancelled" | "interrupted";
      routeAttemptIndex: number;
      retryFailoverCount: number;
      startedAt: Date;
      completedAt?: Date | null;
      finalizedAt?: Date | null;
      durationMs?: number | null;
      turnId?: string | null;
      userInterrupted?: boolean;
      userRetryRegeneration?: boolean;
      immediateCorrectiveFollowup?: boolean;
      codexVersion?: string | null;
    },
  ): Promise<void> => {
    try {
      await repository.recordModelBehaviorObservation(applicationOwnerId(), {
        sourceKey,
        projectId: execution.projectId,
        chatId: execution.chatId,
        modelRouteId: runtime.routeId,
        providerAccountId: runtime.provider.accountId,
        workerId: execution.workerId,
        executionAttemptId: attribution.executionAttemptId,
        attemptKind: "chat-turn",
        attemptStatus: attribution.attemptStatus,
        reasoningEffort: runtime.model.reasoningEffort,
        routeAttemptIndex: attribution.routeAttemptIndex,
        retryFailoverCount: attribution.retryFailoverCount,
        startedAt: attribution.startedAt,
        completedAt: attribution.completedAt,
        finalizedAt: attribution.finalizedAt,
        durationMs: attribution.durationMs,
        turnId: attribution.turnId,
        userInterrupted: attribution.userInterrupted,
        userRetryRegeneration: attribution.userRetryRegeneration,
        immediateCorrectiveFollowup: attribution.immediateCorrectiveFollowup,
        workerVersion: null,
        serverVersion: cantripVersion.version,
        codexVersion: attribution.codexVersion,
        signalAvailability: {
          fork: true,
          copy: false,
          rating: false,
          userRetryRegeneration: true,
          immediateCorrectiveFollowup: true,
        },
        ...tracker.snapshot(),
      });
    } catch (error) {
      app.log.warn(
        { err: error, sourceKey },
        "Unable to persist model behavior analytics",
      );
    }
  };

  const quotaObservationTimers = new Set<NodeJS.Timeout>();
  const quotaResetObservationKeys = new Set<string>();
  const captureRuntimeQuota = (
    runtime: ModelRuntime,
    execution: ChatExecutionContext,
    trigger: string,
    executionAttemptId: string,
    turnId: string | null = null,
  ): void => {
    if (
      !runtime.provider.accountId ||
      !runtime.provider.credentialHomeKey ||
      !isAccountProviderKind(runtime.provider.kind)
    ) {
      return;
    }
    const accountId = runtime.provider.accountId;
    void readAndPersistProviderQuotaSnapshot(repository, bridge, {
      ownerId: applicationOwnerId(),
      providerId: runtime.provider.id,
      accountId,
      accountPlanType: null,
      workerId: execution.workerId,
      trigger,
      chatId: execution.chatId,
      turnId,
      executionAttemptId,
      provider: {
        name: runtime.provider.name,
        kind: runtime.provider.kind,
        baseUrl: runtime.provider.baseUrl,
        credentialHomeKey: runtime.provider.credentialHomeKey,
      },
    })
      .then(({ snapshot }) => {
        scheduleKnownResetQuotaSamples(
          runtime,
          execution,
          executionAttemptId,
          turnId,
          snapshot,
        );
      })
      .catch((error) => {
        app.log.debug(
          {
            err: error,
            providerId: runtime.provider.id,
            providerAccountId: accountId,
            trigger,
            workerId: execution.workerId,
          },
          "Provider quota sample unavailable",
        );
      });
  };

  function scheduleKnownResetQuotaSamples(
    runtime: ModelRuntime,
    execution: ChatExecutionContext,
    executionAttemptId: string,
    turnId: string | null,
    snapshot: ProviderQuotaSnapshot,
  ): void {
    if (!runtime.provider.accountId) return;
    const now = Date.now();
    for (const window of snapshot.windows) {
      if (window.resetsAt === null) continue;
      const resetAtMs = window.resetsAt * 1_000;
      for (const phase of [
        { name: "before", atMs: resetAtMs - 5_000 },
        { name: "after", atMs: resetAtMs + 2_000 },
      ]) {
        const delayMs = phase.atMs - now;
        if (delayMs <= 0 || delayMs > 2_147_000_000) continue;
        const key = `${runtime.provider.accountId}:${window.limitId ?? "unknown"}:${window.windowKind}:${window.resetsAt}:${phase.name}`;
        if (quotaResetObservationKeys.has(key)) continue;
        quotaResetObservationKeys.add(key);
        const timer = setTimeout(() => {
          quotaObservationTimers.delete(timer);
          quotaResetObservationKeys.delete(key);
          captureRuntimeQuota(
            runtime,
            execution,
            `reset-window-${phase.name}`,
            executionAttemptId,
            turnId,
          );
        }, delayMs);
        timer.unref();
        quotaObservationTimers.add(timer);
      }
    }
  }

  const scheduleRuntimeQuotaSamples = (
    runtime: ModelRuntime,
    execution: ChatExecutionContext,
    executionAttemptId: string,
    turnId: string | null,
  ): void => {
    captureRuntimeQuota(
      runtime,
      execution,
      "turn-completed",
      executionAttemptId,
      turnId,
    );
    for (const delayMs of [5_000, 15_000, 45_000]) {
      const timer = setTimeout(() => {
        quotaObservationTimers.delete(timer);
        captureRuntimeQuota(
          runtime,
          execution,
          `turn-completed-plus-${delayMs / 1_000}s`,
          executionAttemptId,
          turnId,
        );
      }, delayMs);
      timer.unref();
      quotaObservationTimers.add(timer);
    }
  };

  const skillSettingsTarget = async (input: {
    projectId: string | null;
    providerId: string;
    workerId: string;
  }) => {
    const provider = await repository.getModelProvider(
      applicationOwnerId(),
      input.providerId,
    );
    if (!provider) {
      throw new SkillSettingsRequestError(404, "Model provider not found.");
    }
    const source = input.projectId
      ? await repository.getProjectSource(applicationOwnerId(), input.projectId)
      : null;
    if (input.projectId && !source) {
      throw new SkillSettingsRequestError(404, "Project source not found.");
    }
    if (source && source.workerId !== input.workerId) {
      throw new SkillSettingsRequestError(
        409,
        "The selected project belongs to a different worker.",
      );
    }
    const workerId = source?.workerId ?? input.workerId;
    if (
      !source &&
      !(await repository.getWorker(applicationOwnerId(), workerId))
    ) {
      throw new SkillSettingsRequestError(404, "Worker not found.");
    }
    if (!bridge.isConnected(workerId)) {
      throw new SkillSettingsRequestError(503, "Selected worker is offline.");
    }
    return {
      cwd: source?.cwd ?? null,
      workerId,
      providerId: provider.id,
      providerKind: provider.kind,
    };
  };

  const settingsCustomizationScope = (input: {
    projectId: string | null;
    providerId: string;
    workerId: string;
  }) =>
    customizationContentScopeSchema.parse({
      workerId: input.workerId,
      projectId: input.projectId,
      chatId: null,
      providerId: input.providerId,
    });

  const settingsContextFromCustomizationScope = (
    scope: CustomizationContentScope,
  ) => {
    if (scope.chatId !== null || scope.providerId === null) {
      throw new Error("Protected skill settings scope is invalid.");
    }
    return skillSettingsContextSchema.parse({
      workerId: scope.workerId,
      projectId: scope.projectId,
      providerId: scope.providerId,
    });
  };

  const chatCustomizationScope = (
    context: ChatExecutionContext,
    runtime: ModelRuntime,
  ) =>
    customizationContentScopeSchema.parse({
      workerId: context.workerId,
      projectId: context.projectId,
      chatId: context.chatId,
      providerId: runtime.provider.id,
    });

  const customizationScopesMatch = (
    left: CustomizationContentScope,
    right: CustomizationContentScope,
  ) => JSON.stringify(left) === JSON.stringify(right);

  const checkedCustomizationResponse = (input: {
    raw: unknown;
    operationId: string;
    operation: CustomizationContentOperation;
    scope: CustomizationContentScope;
  }) => {
    const wire = protectedCustomizationResponseSchema.parse(input.raw);
    if (
      wire.operationId !== input.operationId ||
      wire.operation !== input.operation ||
      !customizationScopesMatch(wire.scope, input.scope)
    ) {
      throw new Error(
        "Protected customization response targets another operation.",
      );
    }
    return wire;
  };

  const checkedCustomizationRequest = (input: {
    raw: unknown;
    operation: CustomizationContentOperation;
  }) => {
    const wire = protectedCustomizationRequestSchema.parse(input.raw);
    if (wire.operation !== input.operation) {
      throw new Error(
        "Protected customization request targets another operation.",
      );
    }
    return wire;
  };

  return {
    availableModelRuntimes,
    captureRuntimeQuota,
    chatCustomizationScope,
    checkedCustomizationRequest,
    checkedCustomizationResponse,
    close(): void {
      for (const timer of quotaObservationTimers) clearTimeout(timer);
      quotaObservationTimers.clear();
      quotaResetObservationKeys.clear();
    },
    configuredRoutePairsForDefaults,
    customizationScopesMatch,
    reasoningStateForContext,
    recordRuntimeModelBehavior,
    recordRuntimeTokenUsage,
    resolveModelId,
    routePairsForConfiguration,
    runtimeCanResumeContext,
    runtimeForContext,
    scheduleRuntimeQuotaSamples,
    sendModelConfigurationResolutionFailure,
    settingsContextFromCustomizationScope,
    settingsCustomizationScope,
    skillSettingsTarget,
  };
}
