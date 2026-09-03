import { randomUUID } from "node:crypto";

import {
  browserPrivateStateOpaqueSchema,
  browserServiceListSchema,
  cantripCliCommandResultSchema,
  cantripMcpClientFocusProjectInputSchema,
  cantripMcpClientFocusSurfaceInputSchema,
  cantripMcpClientShowInteractionInputSchema,
  cantripMcpRunConfigurationCreateInputSchema,
  cantripMcpRunConfigurationDeleteInputSchema,
  cantripMcpRunConfigurationDetectInputSchema,
  cantripMcpRunConfigurationGetInputSchema,
  cantripMcpRunConfigurationListInputSchema,
  cantripMcpRunConfigurationReadOutputInputSchema,
  cantripMcpRunConfigurationRestartInputSchema,
  cantripMcpRunConfigurationStartInputSchema,
  cantripMcpRunConfigurationStatusInputSchema,
  cantripMcpRunConfigurationStopInputSchema,
  cantripMcpRunConfigurationUpdateInputSchema,
  encryptedBrowserUpdateSchema,
  executionTargetResourceKindSchema,
  executionTargetSchema,
  protectedClientNotificationSchema,
  worktreeRemoveResultSchema,
  worktreeStatusResultSchema,
  type AppLiveResource,
  type CantripAgentOperationRequest,
  type CantripAgentOperationResult,
  type EncryptedBrowserUpdate,
} from "@cantrip/protocol";
import {
  policyCliWireListResultSchema,
  policyCliWireReadResultSchema,
} from "@cantrip/protocol/policies";
import {
  runConfigurationSecretSetRequestSchema,
  runConfigurationSecretSetResultSchema,
} from "@cantrip/protocol/run-configuration-secrets";
import {
  surfaceStreamWireRequestSchema,
  surfaceStreamWireResponseSchema,
} from "@cantrip/protocol/surface-stream";

import { CliCommandRequestError } from "../../agent-tools/errors.js";
import { createCantripAgentOperationExecutor } from "../../agent-tools/executor.js";
import { visibleWorktreeLeases } from "../../agent-tools/worktree-list.js";
import { effectivePermissionProfile } from "../../chats/execution-helpers.js";
import {
  ExecutionLaneConflictError,
  type ChatExecutionContext,
  type ServerRepository,
} from "../../db/repository.js";
import {
  optionalToolString,
  requiredToolString,
} from "../../http/request-helpers.js";
import type { AppLiveHub } from "../../live/hub.js";
import type { ProjectWorktreeCoordinator } from "../../worktrees/coordinator.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import type {
  createRunConfigurationRuntime,
  ExecutionOperationContext,
} from "./run-configuration-runtime.js";

type RunConfigurationRuntime = ReturnType<typeof createRunConfigurationRuntime>;

type RunOperationDependencies = Pick<
  RunConfigurationRuntime,
  | "deleteRunConfigurationDefinition"
  | "detectRunConfigurationDefinitions"
  | "getRunConfigurationDefinition"
  | "listRunConfigurationDefinitions"
  | "operateRunConfigurationRuntime"
  | "queryRunConfigurationRuntimeStatus"
  | "readRunConfigurationRuntimeOutput"
  | "resolvePrimaryRunConfigurationSource"
  | "resolveRunConfigurationRuntimeTarget"
  | "retireRunConfigurationRuntimes"
  | "writeRunConfigurationDefinition"
>;

export interface AgentOperationRuntimeDependencies extends RunOperationDependencies {
  applicationOwnerId: () => string;
  applyBrowserUpdate: (
    ownerId: string,
    browserId: string,
    input: EncryptedBrowserUpdate,
    options?: { expectedWorkerId?: string; requireOnline?: boolean },
  ) => Promise<Awaited<ReturnType<ServerRepository["updateBrowser"]>>>;
  bridge: LimitedWorkerCommandBus;
  liveHub: Pick<AppLiveHub, "requestClientControl">;
  publishLiveInvalidation: (
    resource: AppLiveResource,
    input?: {
      chatId?: string | null;
      entityId?: string | null;
      projectId?: string | null;
    },
  ) => void;
  repository: ServerRepository;
  serverId: string;
  updateTerminalStatus: (
    terminalId: string,
    status: Parameters<ServerRepository["setTerminalStatus"]>[1],
  ) => ReturnType<ServerRepository["setTerminalStatus"]>;
  worktreeCoordinator: ProjectWorktreeCoordinator;
}

/** Owns the transport-neutral Cantrip agent operation implementation. */
export function createAgentOperationRuntime({
  applicationOwnerId,
  applyBrowserUpdate,
  bridge,
  deleteRunConfigurationDefinition,
  detectRunConfigurationDefinitions,
  getRunConfigurationDefinition,
  listRunConfigurationDefinitions,
  liveHub,
  operateRunConfigurationRuntime,
  publishLiveInvalidation,
  queryRunConfigurationRuntimeStatus,
  readRunConfigurationRuntimeOutput,
  repository,
  resolvePrimaryRunConfigurationSource,
  resolveRunConfigurationRuntimeTarget,
  retireRunConfigurationRuntimes,
  serverId,
  updateTerminalStatus,
  worktreeCoordinator,
  writeRunConfigurationDefinition,
}: AgentOperationRuntimeDependencies) {
  const createAgentWorktree = async (
    projectId: string,
    input: Record<string, unknown>,
  ) => {
    const name = requiredToolString(input, "name");
    const intent = requiredToolString(input, "intent");
    const branch = optionalToolString(input, "branch");
    const baseRevision = optionalToolString(input, "baseRevision");
    const mode =
      intent === "newBranch"
        ? {
            type: "newBranch" as const,
            branch: branch ?? requiredToolString(input, "branch"),
            startPoint: baseRevision,
          }
        : intent === "existingBranch"
          ? {
              type: "existingBranch" as const,
              branch: branch ?? requiredToolString(input, "branch"),
            }
          : intent === "detached"
            ? {
                type: "detached" as const,
                revision:
                  baseRevision ?? requiredToolString(input, "baseRevision"),
              }
            : (() => {
                throw new Error(
                  "intent must be newBranch, existingBranch, or detached.",
                );
              })();
    const created = await worktreeCoordinator.create(
      applicationOwnerId(),
      projectId,
      {
        mode,
        name,
        origin: "agent",
      },
    );
    if (!created) throw new Error("Project source not found.");
    return created;
  };

  const executionTargetArgument = (input: Record<string, unknown>) => {
    const target = executionTargetSchema.safeParse(input.target);
    if (!target.success)
      throw new Error("A valid execution target is required.");
    return target.data;
  };
  const surfaceTargetArgument = (
    input: Record<string, unknown>,
    surfaceKind: "browser" | "explorer" | "terminal",
  ) => {
    const target = executionTargetArgument(input);
    if (target.kind !== "surface" || target.surfaceKind !== surfaceKind) {
      throw new Error(`An exact ${surfaceKind} surface target is required.`);
    }
    return target;
  };

  const surfaceStreamWireArgument = (input: Record<string, unknown>) =>
    surfaceStreamWireRequestSchema.parse({
      operationId: input.operationId,
      sequence: input.sequence,
      protectedRequest: input.protectedRequest,
    });
  const boundedToolInteger = (
    input: Record<string, unknown>,
    key: string,
    defaultValue: number,
    maximum: number,
  ) => {
    const value = input[key] ?? defaultValue;
    if (
      !Number.isInteger(value) ||
      Number(value) < 1 ||
      Number(value) > maximum
    ) {
      throw new Error(`${key} must be an integer from 1 to ${maximum}.`);
    }
    return Number(value);
  };
  const boundedToolCursor = (
    input: Record<string, unknown>,
    maximum: number,
  ) => {
    const value = input.cursor ?? 0;
    if (
      !Number.isInteger(value) ||
      Number(value) < 0 ||
      Number(value) > maximum
    ) {
      throw new Error(`cursor must be an integer from 0 to ${maximum}.`);
    }
    return Number(value);
  };
  const executeExecutionOperation = async (
    context: ExecutionOperationContext,
    call: CantripAgentOperationRequest,
  ): Promise<CantripAgentOperationResult> => {
    if (
      call.operation === "worktree.list" ||
      call.operation.startsWith("worktree.")
    ) {
      const project = await repository.getProject(
        applicationOwnerId(),
        context.projectId,
      );
      if (!project?.capabilities.worktrees) {
        throw new CliCommandRequestError(
          "unsupported-capability",
          409,
          "This worker-managed folder does not support Cantrip worktree commands.",
        );
      }
    }
    const worktrees = () =>
      repository.listProjectWorktrees(applicationOwnerId(), context.projectId);
    const worktreeContext = async (worktreeId: string) => {
      const target = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        context.projectId,
        worktreeId,
      );
      if (!target) throw new Error("Worktree not found.");
      return target;
    };
    const requireRunMutation = () => {
      if (context.permissionProfileId === ":read-only") {
        throw new CliCommandRequestError(
          "conflict",
          409,
          "Run mutations are unavailable in a read-only execution context.",
        );
      }
    };
    const resolveTarget = (
      target: Parameters<typeof repository.resolveExecutionTarget>[2],
      allowUnavailable = false,
    ) =>
      repository.resolveExecutionTarget(
        applicationOwnerId(),
        context.projectId,
        target,
        (workerId) => bridge.isConnected(workerId),
        allowUnavailable,
      );
    const schedule = async (
      worktreeId: string,
      transitionKind: "switch" | "release",
      purpose: string,
    ) => {
      if (!context.chatId || !context.executionLaneId) {
        throw new ExecutionLaneConflictError(
          "This operation must run inside an active Cantrip chat.",
        );
      }
      const pending = await repository.scheduleChatWorktreeTransition(
        applicationOwnerId(),
        context.chatId,
        context.executionLaneId,
        worktreeId,
        transitionKind,
        purpose,
      );
      if (!pending) throw new Error("Target worktree is not ready.");
      return pending;
    };
    const requireBoundRunConfigurationWorker = (workerId: string) => {
      if (workerId !== context.workerId) {
        throw new ExecutionLaneConflictError(
          "The Run configuration target is outside the managed MCP worker binding.",
        );
      }
    };
    const runConfigurationProjectTarget = {
      kind: "project" as const,
      projectId: context.projectId,
    };

    switch (call.operation) {
      case "context.get": {
        const worker = await repository.getWorker(
          applicationOwnerId(),
          context.workerId,
        );
        if (!worker) {
          throw new CliCommandRequestError(
            "not-found",
            404,
            "The connected worker is no longer registered.",
          );
        }
        return cantripCliCommandResultSchema.parse({
          summary: `Connected through ${worker.name}; project context is ready.`,
          worktreeId: context.worktreeId,
          data: {
            worker: {
              id: worker.workerId,
              name: worker.name,
              online: bridge.isConnected(context.workerId),
            },
            context,
          },
        });
      }
      case "policy.list": {
        const effective = await repository.policies.resolveEffective(
          applicationOwnerId(),
          context.projectId,
        );
        if (!effective) {
          throw new CliCommandRequestError(
            "not-found",
            404,
            "The current project no longer exists.",
          );
        }
        return cantripCliCommandResultSchema.parse({
          summary: "Returned opaque effective policy metadata.",
          worktreeId: context.worktreeId,
          data: policyCliWireListResultSchema.parse(effective),
        });
      }
      case "policy.read": {
        const policyId = requiredToolString(call.arguments, "policyId");
        const effective = await repository.policies.resolveEffective(
          applicationOwnerId(),
          context.projectId,
        );
        if (!effective?.policies.some((policy) => policy.id === policyId)) {
          throw new CliCommandRequestError(
            "not-found",
            404,
            "That policy is not effective for the current project.",
          );
        }
        const current = await repository.policies.get(
          applicationOwnerId(),
          policyId,
        );
        if (!current?.enabled) {
          throw new CliCommandRequestError(
            "not-found",
            404,
            "That policy is not effective for the current project.",
          );
        }
        return cantripCliCommandResultSchema.parse({
          summary: "Returned opaque policy content.",
          worktreeId: context.worktreeId,
          data: policyCliWireReadResultSchema.parse({ policy: current }),
        });
      }
      case "run-configuration.list": {
        cantripMcpRunConfigurationListInputSchema.parse(call.arguments);
        const { result, source } = await listRunConfigurationDefinitions(
          applicationOwnerId(),
          context.projectId,
          randomUUID(),
        );
        requireBoundRunConfigurationWorker(source.workerId);
        const runtimes = await repository.listRunConfigurationRuntimes(
          applicationOwnerId(),
          context.projectId,
          { limit: 256 },
        );
        const activeConfigurationIds = new Set(
          runtimes
            .filter(({ state }) =>
              ["starting", "running", "restarting", "stopping"].includes(state),
            )
            .map(({ configurationId }) => configurationId),
        );
        const entries = [...result.inventory.entries].sort(
          (left, right) =>
            Number(activeConfigurationIds.has(right.id ?? "")) -
            Number(activeConfigurationIds.has(left.id ?? "")),
        );
        return cantripCliCommandResultSchema.parse({
          summary: `Found ${entries.length} project Run configuration${entries.length === 1 ? "" : "s"}.`,
          target: runConfigurationProjectTarget,
          worktreeId: source.worktreeId,
          data: {
            ...result,
            inventory: { ...result.inventory, entries },
            runtimes,
          },
        });
      }
      case "run-configuration.get": {
        const input = cantripMcpRunConfigurationGetInputSchema.parse(
          call.arguments,
        );
        const { result, source } = await getRunConfigurationDefinition(
          applicationOwnerId(),
          context.projectId,
          randomUUID(),
          input.configurationId,
        );
        requireBoundRunConfigurationWorker(source.workerId);
        if (!result.result.found) {
          throw new CliCommandRequestError(
            "not-found",
            404,
            `Run configuration ${input.configurationId} was not found.`,
          );
        }
        return cantripCliCommandResultSchema.parse({
          summary: `Read Run configuration ${input.configurationId}.`,
          target: runConfigurationProjectTarget,
          worktreeId: source.worktreeId,
          data: result,
        });
      }
      case "run-configuration.detect": {
        const input = cantripMcpRunConfigurationDetectInputSchema.parse(
          call.arguments,
        );
        const { result, source } = await detectRunConfigurationDefinitions(
          applicationOwnerId(),
          context.projectId,
          randomUUID(),
          input.provider,
        );
        requireBoundRunConfigurationWorker(source.workerId);
        return cantripCliCommandResultSchema.parse({
          summary: `Detected ${result.candidates.length} Run configuration candidate${result.candidates.length === 1 ? "" : "s"}.`,
          target: runConfigurationProjectTarget,
          worktreeId: source.worktreeId,
          data: result,
        });
      }
      case "run-configuration.create":
      case "run-configuration.update": {
        requireRunMutation();
        const boundSource = await resolvePrimaryRunConfigurationSource(
          applicationOwnerId(),
          context.projectId,
        );
        requireBoundRunConfigurationWorker(boundSource.workerId);
        const input =
          call.operation === "run-configuration.create"
            ? {
                ...cantripMcpRunConfigurationCreateInputSchema.parse(
                  call.arguments,
                ),
                expectedRevision: null,
              }
            : cantripMcpRunConfigurationUpdateInputSchema.parse(call.arguments);
        const { result, source } = await writeRunConfigurationDefinition(
          applicationOwnerId(),
          context.projectId,
          input.operationId,
          input.expectedRevision,
          input.document,
        );
        requireBoundRunConfigurationWorker(source.workerId);
        if (!("entry" in result.result)) {
          throw new CliCommandRequestError(
            "conflict",
            409,
            `Run configuration write was rejected: ${result.result.outcome}.`,
          );
        }
        return cantripCliCommandResultSchema.parse({
          summary: `${result.result.outcome === "created" ? "Created" : "Updated"} Run configuration ${result.result.entry.id}.`,
          target: runConfigurationProjectTarget,
          worktreeId: source.worktreeId,
          mutated: result.result.outcome !== "unchanged",
          data: result,
        });
      }
      case "run-configuration.delete": {
        requireRunMutation();
        const boundSource = await resolvePrimaryRunConfigurationSource(
          applicationOwnerId(),
          context.projectId,
        );
        requireBoundRunConfigurationWorker(boundSource.workerId);
        const input = cantripMcpRunConfigurationDeleteInputSchema.parse(
          call.arguments,
        );
        const { result, source } = await deleteRunConfigurationDefinition(
          applicationOwnerId(),
          context.projectId,
          input.operationId,
          input.configurationId,
          input.expectedRevision,
        );
        requireBoundRunConfigurationWorker(source.workerId);
        if (result.result.outcome !== "deleted") {
          throw new CliCommandRequestError(
            result.result.outcome === "not-found" ? "not-found" : "conflict",
            result.result.outcome === "not-found" ? 404 : 409,
            `Run configuration delete was rejected: ${result.result.outcome}.`,
          );
        }
        return cantripCliCommandResultSchema.parse({
          summary: `Deleted Run configuration ${input.configurationId}.`,
          target: runConfigurationProjectTarget,
          worktreeId: source.worktreeId,
          mutated: true,
          data: result,
        });
      }
      case "run-configuration.start":
      case "run-configuration.restart":
      case "run-configuration.stop": {
        requireRunMutation();
        const input =
          call.operation === "run-configuration.start"
            ? cantripMcpRunConfigurationStartInputSchema.parse(call.arguments)
            : call.operation === "run-configuration.restart"
              ? cantripMcpRunConfigurationRestartInputSchema.parse(
                  call.arguments,
                )
              : cantripMcpRunConfigurationStopInputSchema.parse(call.arguments);
        const target = await resolveRunConfigurationRuntimeTarget(
          applicationOwnerId(),
          context.projectId,
          input.worktreeId,
        );
        requireBoundRunConfigurationWorker(target.workerId);
        const operation = call.operation.slice("run-configuration.".length) as
          "start" | "restart" | "stop";
        const result = await operateRunConfigurationRuntime(
          applicationOwnerId(),
          {
            operationId: input.operationId,
            projectId: context.projectId,
            configurationId: input.configurationId,
            targetWorktreeId: target.worktree.id,
            operation,
          },
        );
        return cantripCliCommandResultSchema.parse({
          summary: `${operation} ${result.operation.outcome} for Run configuration ${input.configurationId}.`,
          target: {
            kind: "worktree",
            projectId: context.projectId,
            worktreeId: result.operation.worktreeId,
          },
          worktreeId: result.operation.worktreeId,
          mutated: result.operation.outcome === "accepted",
          data: result,
        });
      }
      case "run-configuration.status": {
        const input = cantripMcpRunConfigurationStatusInputSchema.parse(
          call.arguments,
        );
        if (input.worktreeId) {
          const target = await resolveRunConfigurationRuntimeTarget(
            applicationOwnerId(),
            context.projectId,
            input.worktreeId,
          );
          requireBoundRunConfigurationWorker(target.workerId);
        }
        const result = await queryRunConfigurationRuntimeStatus(
          applicationOwnerId(),
          {
            operationId: randomUUID(),
            projectId: context.projectId,
            configurationId: input.configurationId,
            targetWorktreeId: input.worktreeId,
            limit: input.limit,
          },
        );
        return cantripCliCommandResultSchema.parse({
          summary: `Found ${result.runtimes.length} Run configuration runtime${result.runtimes.length === 1 ? "" : "s"}.`,
          target: runConfigurationProjectTarget,
          worktreeId: input.worktreeId,
          data: result,
        });
      }
      case "run-configuration.read-output": {
        const input = cantripMcpRunConfigurationReadOutputInputSchema.parse(
          call.arguments,
        );
        const target = await resolveRunConfigurationRuntimeTarget(
          applicationOwnerId(),
          context.projectId,
          input.worktreeId,
        );
        requireBoundRunConfigurationWorker(target.workerId);
        const result = await readRunConfigurationRuntimeOutput(
          applicationOwnerId(),
          {
            operationId: input.operationId,
            projectId: context.projectId,
            configurationId: input.configurationId,
            worktreeId: target.worktree.id,
            tail: input.tail,
          },
        );
        return cantripCliCommandResultSchema.parse({
          summary: `Read Run configuration ${result.configurationId} output.`,
          target: {
            kind: "worktree",
            projectId: context.projectId,
            worktreeId: target.worktree.id,
          },
          worktreeId: target.worktree.id,
          data: result,
        });
      }
      case "run-configuration.secret-set": {
        requireRunMutation();
        const boundSource = await resolvePrimaryRunConfigurationSource(
          applicationOwnerId(),
          context.projectId,
        );
        requireBoundRunConfigurationWorker(boundSource.workerId);
        const input = runConfigurationSecretSetRequestSchema.parse({
          operationId: call.arguments.operationId,
          reference: call.arguments.reference,
          protectedValue: call.arguments.protectedValue,
        });
        const result = runConfigurationSecretSetResultSchema.parse(
          await repository.setRunConfigurationSecret(
            applicationOwnerId(),
            context.projectId,
            input,
          ),
        );
        publishLiveInvalidation("run-configuration", {
          entityId: null,
          projectId: context.projectId,
        });
        return cantripCliCommandResultSchema.parse({
          summary: `Stored Run configuration secret ${result.secret.reference}.`,
          target: runConfigurationProjectTarget,
          worktreeId: null,
          mutated: !result.replayed,
          data: result,
        });
      }
      case "target.list": {
        const catalog = await repository.listProjectExecutionTargets(
          applicationOwnerId(),
          context.projectId,
          (workerId) => bridge.isConnected(workerId),
        );
        if (!catalog) throw new Error("Project not found.");
        const kindValue = optionalToolString(call.arguments, "kind");
        const kind = kindValue
          ? executionTargetResourceKindSchema.parse(kindValue)
          : null;
        const matchingTargets = kind
          ? catalog.targets.filter(({ resourceKind }) => resourceKind === kind)
          : catalog.targets;
        if (
          call.arguments.cursor === undefined &&
          call.arguments.limit === undefined
        ) {
          return cantripCliCommandResultSchema.parse({
            summary: `Found ${matchingTargets.length} authorized target${matchingTargets.length === 1 ? "" : "s"}.`,
            worktreeId: context.worktreeId,
            data: { ...catalog, targets: matchingTargets },
          });
        }
        const cursor = boundedToolCursor(call.arguments, 1_999);
        const limit = boundedToolInteger(call.arguments, "limit", 100, 200);
        const targets = matchingTargets.slice(cursor, cursor + limit);
        const nextCursor =
          cursor + targets.length < matchingTargets.length
            ? cursor + targets.length
            : null;
        return cantripCliCommandResultSchema.parse({
          summary: `Found ${targets.length} authorized execution target${targets.length === 1 ? "" : "s"}${nextCursor !== null || catalog.truncated ? "; more targets are available" : ""}.`,
          worktreeId: context.worktreeId,
          data: {
            projectId: catalog.projectId,
            targets,
            cursor,
            nextCursor,
            total: matchingTargets.length,
            truncated: catalog.truncated || nextCursor !== null,
          },
        });
      }
      case "target.inspect": {
        const target = executionTargetArgument(call.arguments);
        const resolution = await resolveTarget(target, true);
        const browserContext =
          target.kind === "surface" && target.surfaceKind === "browser"
            ? await repository.getRemoteSurfaceExecutionContext(
                applicationOwnerId(),
                target.surfaceId,
              )
            : null;
        return cantripCliCommandResultSchema.parse({
          summary:
            resolution.availability === "available"
              ? `${resolution.worker.name} can serve this target.`
              : (resolution.unavailableReason ?? "The target is unavailable."),
          target,
          worktreeId: resolution.placement.worktreeId,
          data: {
            ...resolution,
            serverId,
            stateRevision: browserContext?.surface.stateRevision ?? null,
          },
        });
      }
      case "explorer.list": {
        const target = surfaceTargetArgument(call.arguments, "explorer");
        const resolution = await resolveTarget(target);
        const explorer = await repository.getExplorerExecutionContext(
          applicationOwnerId(),
          target.surfaceId,
        );
        if (
          !explorer ||
          explorer.workerId !== resolution.placement.workerId ||
          explorer.worktreeId !== resolution.placement.worktreeId
        ) {
          throw new Error("Explorer placement changed before the read.");
        }
        const wire = surfaceStreamWireArgument(call.arguments);
        const result = surfaceStreamWireResponseSchema.parse(
          await bridge.request(resolution.placement.workerId, {
            type: "explorer.operation",
            explorerId: explorer.explorerId,
            serverId,
            root: explorer.root,
            ...wire,
          }),
        );
        return cantripCliCommandResultSchema.parse({
          summary: "Encrypted Explorer operation completed.",
          target,
          worktreeId: resolution.placement.worktreeId,
          data: result,
        });
      }
      case "explorer.read": {
        const target = surfaceTargetArgument(call.arguments, "explorer");
        const resolution = await resolveTarget(target);
        const explorer = await repository.getExplorerExecutionContext(
          applicationOwnerId(),
          target.surfaceId,
        );
        if (
          !explorer ||
          explorer.workerId !== resolution.placement.workerId ||
          explorer.worktreeId !== resolution.placement.worktreeId
        ) {
          throw new Error("Explorer placement changed before the read.");
        }
        const wire = surfaceStreamWireArgument(call.arguments);
        const result = surfaceStreamWireResponseSchema.parse(
          await bridge.request(resolution.placement.workerId, {
            type: "explorer.operation",
            explorerId: explorer.explorerId,
            serverId,
            root: explorer.root,
            ...wire,
          }),
        );
        return cantripCliCommandResultSchema.parse({
          summary: "Encrypted Explorer operation completed.",
          target,
          worktreeId: resolution.placement.worktreeId,
          data: result,
        });
      }
      case "terminal.read": {
        const target = surfaceTargetArgument(call.arguments, "terminal");
        const resolution = await resolveTarget(target);
        const wire = surfaceStreamWireArgument(call.arguments);
        const result = surfaceStreamWireResponseSchema.parse(
          await bridge.request(resolution.placement.workerId, {
            type: "terminal.snapshot",
            terminalId: target.surfaceId,
            serverId,
            ...wire,
          }),
        );
        return cantripCliCommandResultSchema.parse({
          summary: "Encrypted terminal snapshot completed.",
          target,
          worktreeId: resolution.placement.worktreeId,
          data: result,
        });
      }
      case "browser.services": {
        const target = surfaceTargetArgument(call.arguments, "browser");
        const resolution = await resolveTarget(target);
        const discovered = browserServiceListSchema.parse(
          await bridge.request(
            resolution.placement.workerId,
            { type: "browser.services.discover" },
            { timeoutMs: 20_000 },
          ),
        );
        const services = browserServiceListSchema.parse(
          discovered.map((service) => ({
            ...service,
            workerId: resolution.placement.workerId,
          })),
        );
        return cantripCliCommandResultSchema.parse({
          summary: `Found ${services.length} browser service${services.length === 1 ? "" : "s"} on ${resolution.worker.name}.`,
          target,
          worktreeId: resolution.placement.worktreeId,
          data: services,
        });
      }
      case "explorer.write": {
        const target = surfaceTargetArgument(call.arguments, "explorer");
        const resolution = await resolveTarget(target);
        const explorer = await repository.getExplorerExecutionContext(
          applicationOwnerId(),
          target.surfaceId,
        );
        if (
          !explorer ||
          explorer.workerId !== resolution.placement.workerId ||
          explorer.worktreeId !== resolution.placement.worktreeId
        ) {
          throw new Error("Explorer placement changed before the write.");
        }
        const wire = surfaceStreamWireArgument(call.arguments);
        const result = surfaceStreamWireResponseSchema.parse(
          await bridge.request(resolution.placement.workerId, {
            type: "explorer.operation",
            explorerId: explorer.explorerId,
            serverId,
            root: explorer.root,
            ...wire,
          }),
        );
        publishLiveInvalidation("explorer", {
          entityId: target.surfaceId,
          projectId: context.projectId,
        });
        return cantripCliCommandResultSchema.parse({
          summary: "Encrypted Explorer write completed.",
          target,
          worktreeId: resolution.placement.worktreeId,
          mutated: true,
          data: result,
        });
      }
      case "terminal.send": {
        const target = surfaceTargetArgument(call.arguments, "terminal");
        const resolution = await resolveTarget(target);
        const terminal = await repository.getTerminalExecutionContext(
          applicationOwnerId(),
          target.surfaceId,
        );
        if (
          !terminal ||
          terminal.workerId !== resolution.placement.workerId ||
          terminal.worktreeId !== resolution.placement.worktreeId
        ) {
          throw new Error("Terminal placement changed before input.");
        }
        if (terminal.kind === "run-configuration") {
          throw new CliCommandRequestError(
            "conflict",
            409,
            "Run configuration terminals are read-only. Use the Run configuration lifecycle and output operations instead.",
          );
        }
        const wire = surfaceStreamWireArgument(call.arguments);
        const result = surfaceStreamWireResponseSchema.parse(
          await bridge.request(
            resolution.placement.workerId,
            {
              type: "terminal.input",
              terminalId: target.surfaceId,
              serverId,
              operationId: wire.operationId,
              sequence: wire.sequence,
              protectedData: wire.protectedRequest,
              complete: true,
            },
            { timeoutMs: 30_000 },
          ),
        );
        return cantripCliCommandResultSchema.parse({
          summary: "Encrypted terminal input completed.",
          target,
          worktreeId: resolution.placement.worktreeId,
          mutated: true,
          data: result,
        });
      }
      case "terminal.restart": {
        const target = surfaceTargetArgument(call.arguments, "terminal");
        const resolution = await resolveTarget(target);
        const terminal = await repository.getTerminalExecutionContext(
          applicationOwnerId(),
          target.surfaceId,
        );
        if (
          !terminal ||
          terminal.workerId !== resolution.placement.workerId ||
          terminal.worktreeId !== resolution.placement.worktreeId
        ) {
          throw new Error("Terminal placement changed before restart.");
        }
        if (!terminal.serviceEnabled) {
          throw new Error("Terminal service is disabled.");
        }
        await bridge.request(
          resolution.placement.workerId,
          {
            type: "terminal.service.restart",
            terminalId: target.surfaceId,
          },
          { timeoutMs: 30_000 },
        );
        await updateTerminalStatus(target.surfaceId, "running");
        return cantripCliCommandResultSchema.parse({
          summary: `Restarted the terminal service on ${resolution.worker.name}.`,
          target,
          worktreeId: resolution.placement.worktreeId,
          mutated: true,
        });
      }
      case "browser.open": {
        const target = surfaceTargetArgument(call.arguments, "browser");
        const resolution = await resolveTarget(target);
        const browser = await applyBrowserUpdate(
          applicationOwnerId(),
          target.surfaceId,
          encryptedBrowserUpdateSchema.parse({
            expectedStateRevision: call.arguments.expectedStateRevision,
            stateProtection: browserPrivateStateOpaqueSchema.parse(
              call.arguments.stateProtection,
            ),
          }),
          {
            expectedWorkerId: resolution.placement.workerId,
            requireOnline: true,
          },
        );
        if (!browser) throw new Error("Browser not found.");
        return cantripCliCommandResultSchema.parse({
          summary: `Navigated the browser on ${resolution.worker.name}.`,
          target,
          mutated: true,
          data: browser,
        });
      }
      case "client.notify": {
        const input = protectedClientNotificationSchema.parse(call.arguments);
        const target = {
          kind: "project" as const,
          projectId: context.projectId,
        };
        const result = await liveHub.requestClientControl(
          applicationOwnerId(),
          {
            kind: "notify",
            projectId: context.projectId,
            workerId: context.workerId,
            ...input,
          },
        );
        return cantripCliCommandResultSchema.parse({
          summary: `Client notification ${result.status}.`,
          target,
          worktreeId: context.worktreeId,
          mutated: result.status === "applied",
          data: result,
        });
      }
      case "client.focus-project": {
        cantripMcpClientFocusProjectInputSchema.parse(call.arguments);
        const target = {
          kind: "project" as const,
          projectId: context.projectId,
        };
        const result = await liveHub.requestClientControl(
          applicationOwnerId(),
          { kind: "focus-project", projectId: context.projectId },
        );
        return cantripCliCommandResultSchema.parse({
          summary: `Client project focus ${result.status}.`,
          target,
          worktreeId: context.worktreeId,
          mutated: result.status === "applied",
          data: result,
        });
      }
      case "client.focus-surface": {
        const input = cantripMcpClientFocusSurfaceInputSchema.parse(
          call.arguments,
        );
        if (input.target.projectId !== context.projectId) {
          throw new Error(
            "The client-control target is outside the bound Cantrip project.",
          );
        }
        const resolution = await resolveTarget(input.target);
        const result = await liveHub.requestClientControl(
          applicationOwnerId(),
          {
            kind: "focus-surface",
            projectId: context.projectId,
            surfaceKind: input.target.surfaceKind,
            surfaceId: input.target.surfaceId,
          },
        );
        return cantripCliCommandResultSchema.parse({
          summary: `Client surface focus ${result.status}.`,
          target: input.target,
          worktreeId: resolution.placement.worktreeId,
          mutated: result.status === "applied",
          data: result,
        });
      }
      case "client.show-interaction": {
        if (!context.chatId) {
          throw new Error("Client interaction focus requires a chat binding.");
        }
        const input = cantripMcpClientShowInteractionInputSchema.parse(
          call.arguments,
        );
        const interaction = await repository.getAgentInteractionRequest(
          applicationOwnerId(),
          input.interactionId,
        );
        if (
          !interaction ||
          interaction.projectId !== context.projectId ||
          interaction.provenance.chatId !== context.chatId ||
          interaction.status !== "pending"
        ) {
          throw new Error(
            "The interaction is not pending in the bound Cantrip chat.",
          );
        }
        const target = {
          kind: "surface" as const,
          projectId: context.projectId,
          surfaceKind: "chat" as const,
          surfaceId: context.chatId,
        };
        await resolveTarget(target);
        const result = await liveHub.requestClientControl(
          applicationOwnerId(),
          {
            kind: "show-interaction",
            projectId: context.projectId,
            chatId: context.chatId,
            interactionId: input.interactionId,
          },
        );
        return cantripCliCommandResultSchema.parse({
          summary: `Client interaction focus ${result.status}.`,
          target,
          worktreeId: context.worktreeId,
          mutated: result.status === "applied",
          data: result,
        });
      }
      case "worktree.list": {
        const includeLeaseHistory = call.arguments.includeLeaseHistory === true;
        const [items, leases] = await Promise.all([
          worktrees(),
          repository.listProjectExecutionLanes(
            applicationOwnerId(),
            context.projectId,
            { includeHistory: includeLeaseHistory },
          ),
        ]);
        const visibleLeases = visibleWorktreeLeases(
          items,
          leases,
          includeLeaseHistory,
        );
        if (
          call.arguments.cursor !== undefined ||
          call.arguments.limit !== undefined
        ) {
          const cursor = boundedToolCursor(call.arguments, 1_999);
          const limit = boundedToolInteger(call.arguments, "limit", 100, 200);
          const boundedItems = items.slice(0, 2_000);
          const selected = boundedItems.slice(cursor, cursor + limit);
          const selectedIds = new Set(selected.map(({ id }) => id));
          const nextCursor =
            cursor + selected.length < boundedItems.length
              ? cursor + selected.length
              : null;
          const selectedLeases = visibleLeases.filter(({ worktreeId }) =>
            selectedIds.has(worktreeId),
          );
          return cantripCliCommandResultSchema.parse({
            summary: `Found ${selected.length} validated worktree${selected.length === 1 ? "" : "s"}${nextCursor !== null ? "; more worktrees are available" : ""}.`,
            worktreeId: context.worktreeId,
            data: {
              currentWorktreeId: context.worktreeId,
              worktrees: selected,
              leases: selectedLeases.slice(0, 1_000),
              cursor,
              nextCursor,
              total: boundedItems.length,
              truncated:
                items.length > boundedItems.length ||
                selectedLeases.length > 1_000 ||
                nextCursor !== null,
            },
          });
        }
        return cantripCliCommandResultSchema.parse({
          summary: `Found ${items.length} validated worktree${items.length === 1 ? "" : "s"}.`,
          worktreeId: context.worktreeId,
          data: {
            currentWorktreeId: context.worktreeId,
            worktrees: items,
            leases: visibleLeases,
          },
        });
      }
      case "worktree.status": {
        const requestedTarget = call.arguments.target
          ? executionTargetArgument(call.arguments)
          : {
              kind: "worktree" as const,
              projectId: context.projectId,
              worktreeId:
                optionalToolString(call.arguments, "worktreeId") ??
                context.worktreeId,
            };
        if (requestedTarget.kind !== "worktree") {
          throw new Error("Worktree status requires a worktree target.");
        }
        const resolution = await resolveTarget(requestedTarget);
        const worktreeId = resolution.placement.worktreeId!;
        const targetContext = await worktreeContext(worktreeId);
        const status = worktreeStatusResultSchema.parse(
          await bridge.request(targetContext.workerId, {
            type: "worktree.status",
            sourcePath: targetContext.sourcePath,
            worktreePath: targetContext.worktree.path,
          }),
        );
        if (status.worktree.path !== targetContext.worktree.path) {
          throw new Error("Worker returned status for a different worktree.");
        }
        if (
          call.arguments.fileLimit !== undefined ||
          call.arguments.branchLimit !== undefined
        ) {
          const fileLimit = boundedToolInteger(
            call.arguments,
            "fileLimit",
            500,
            2_000,
          );
          const branchLimit = boundedToolInteger(
            call.arguments,
            "branchLimit",
            200,
            500,
          );
          return cantripCliCommandResultSchema.parse({
            summary: `${targetContext.worktree.name} is ${status.status.files.length ? "dirty" : "clean"} on ${status.status.branch || "detached HEAD"}.`,
            target: {
              kind: "worktree",
              projectId: context.projectId,
              worktreeId,
            },
            worktreeId,
            data: {
              worktree: status.worktree,
              status: {
                ...status.status,
                files: status.status.files.slice(0, fileLimit),
                branches: status.status.branches.slice(0, branchLimit),
              },
              filesTruncated: status.status.files.length > fileLimit,
              branchesTruncated: status.status.branches.length > branchLimit,
            },
          });
        }
        return cantripCliCommandResultSchema.parse({
          summary: `${targetContext.worktree.name} is ${status.status.files.length ? "dirty" : "clean"} on ${status.status.branch || "detached HEAD"}.`,
          target: {
            kind: "worktree",
            projectId: context.projectId,
            worktreeId,
          },
          worktreeId,
          data: status,
        });
      }
      case "worktree.create": {
        const created = await createAgentWorktree(
          context.projectId,
          call.arguments,
        );
        return cantripCliCommandResultSchema.parse({
          summary: `Created ${created.name} on ${created.branch ?? "detached HEAD"}.`,
          worktreeId: created.id,
          mutated: true,
          data: created,
        });
      }
      case "worktree.acquire": {
        if (context.worktreeMode === "pinned") {
          throw new Error(
            "This chat is pinned. Return it to Agent managed before acquiring another worktree.",
          );
        }
        const created = await createAgentWorktree(
          context.projectId,
          call.arguments,
        );
        const pending = await schedule(
          created.id,
          "switch",
          requiredToolString(call.arguments, "purpose"),
        );
        return cantripCliCommandResultSchema.parse({
          summary: `Created ${created.name}; continuation is scheduled in that worktree. Finish this turn now.`,
          worktreeId: created.id,
          continuationScheduled: true,
          mutated: true,
          data: { worktree: created, lane: pending.lane },
        });
      }
      case "worktree.switch": {
        const requestedTarget = call.arguments.target
          ? executionTargetArgument(call.arguments)
          : {
              kind: "worktree" as const,
              projectId: context.projectId,
              worktreeId: requiredToolString(call.arguments, "worktreeId"),
            };
        if (requestedTarget.kind !== "worktree") {
          throw new Error("Worktree switching requires a worktree target.");
        }
        const resolution = await resolveTarget(requestedTarget);
        const worktreeId = resolution.placement.worktreeId!;
        const pending = await schedule(
          worktreeId,
          "switch",
          requiredToolString(call.arguments, "purpose"),
        );
        return cantripCliCommandResultSchema.parse({
          summary: `Continuation is scheduled in ${pending.worktree.name}. Finish this turn now.`,
          worktreeId,
          continuationScheduled: true,
          mutated: true,
          data: { lane: pending.lane, worktree: pending.worktree },
        });
      }
      case "worktree.release": {
        const currentTarget = await worktreeContext(context.worktreeId);
        if (currentTarget.worktree.isPrimary) {
          throw new Error(
            "Primary does not have a releasable secondary lease.",
          );
        }
        const currentStatus = worktreeStatusResultSchema.parse(
          await bridge.request(currentTarget.workerId, {
            type: "worktree.status",
            sourcePath: currentTarget.sourcePath,
            worktreePath: currentTarget.worktree.path,
          }),
        );
        if (currentStatus.status.files.length > 0) {
          throw new Error(
            "The current worktree is dirty. Commit or restore its changes before releasing it.",
          );
        }
        const primary = (await worktrees()).find(({ isPrimary }) => isPrimary);
        if (!primary) throw new Error("Primary worktree not found.");
        const pending = await schedule(
          primary.id,
          "release",
          requiredToolString(call.arguments, "purpose"),
        );
        return cantripCliCommandResultSchema.parse({
          summary: `Release is scheduled; continuation will return to ${primary.name}. Finish this turn now.`,
          worktreeId: primary.id,
          continuationScheduled: true,
          mutated: true,
          data: { lane: pending.lane, worktree: pending.worktree },
        });
      }
      case "worktree.remove": {
        const requestedTarget = call.arguments.target
          ? executionTargetArgument(call.arguments)
          : {
              kind: "worktree" as const,
              projectId: context.projectId,
              worktreeId: requiredToolString(call.arguments, "worktreeId"),
            };
        if (requestedTarget.kind !== "worktree") {
          throw new Error("Worktree removal requires a worktree target.");
        }
        const resolution = await resolveTarget(requestedTarget);
        const worktreeId = resolution.placement.worktreeId!;
        const target = await worktreeContext(worktreeId);
        if (target.worktree.isPrimary) {
          throw new Error("Primary cannot be removed as a worktree.");
        }
        if (target.worktree.origin !== "agent") {
          throw new Error(
            "Agents may remove only agent-created worktrees; user and external worktrees require explicit user authorization.",
          );
        }
        if (context.worktreeId === worktreeId) {
          throw new Error("Release or switch away from this worktree first.");
        }
        const blockers = await repository.getWorktreeRemovalBlockers(
          applicationOwnerId(),
          context.projectId,
          worktreeId,
        );
        if (
          blockers &&
          (blockers.activeChatIds.length ||
            blockers.activeLeaseChatIds.length ||
            blockers.boundCodeTabIds.length ||
            blockers.runningTerminalIds.length)
        ) {
          throw new Error(
            "The worktree is still used by a chat, Code tab, or terminal. Retarget or delete bound Code tabs before removal.",
          );
        }
        const status = worktreeStatusResultSchema.parse(
          await bridge.request(target.workerId, {
            type: "worktree.status",
            sourcePath: target.sourcePath,
            worktreePath: target.worktree.path,
          }),
        );
        if (status.status.files.length > 0) {
          throw new Error("Dirty worktrees cannot be removed by an agent.");
        }
        const removed = await worktreeCoordinator.serialize(
          context.projectId,
          async () => {
            await retireRunConfigurationRuntimes(
              applicationOwnerId(),
              context.projectId,
              { worktreeId },
            );
            const result = worktreeRemoveResultSchema.parse(
              await bridge.request(target.workerId, {
                type: "worktree.remove",
                sourcePath: target.sourcePath,
                worktreePath: target.worktree.path,
                force: false,
                allowExternal: false,
              }),
            );
            await repository.reconcileProjectWorktrees(
              applicationOwnerId(),
              context.projectId,
              target.workerId,
              result.inventory,
            );
            return result;
          },
        );
        return cantripCliCommandResultSchema.parse({
          summary: `Removed ${target.worktree.name}; its Git branch was retained.`,
          worktreeId,
          mutated: true,
          data: removed,
        });
      }
      default:
        throw new Error(
          `Unsupported Cantrip agent operation: ${call.operation}`,
        );
    }
  };

  const agentOperationExecutor = createCantripAgentOperationExecutor(
    executeExecutionOperation,
  );

  const chatOperationContext = (
    context: ChatExecutionContext,
  ): ExecutionOperationContext => {
    if (context.contextKind !== "project") {
      throw new CliCommandRequestError(
        "unsupported-capability",
        409,
        "Standalone Chats do not support IDE execution operations.",
      );
    }
    return {
      chatId: context.chatId,
      executionLaneId: context.executionLaneId,
      permissionProfileId: effectivePermissionProfile(context).effectiveId,
      projectId: context.projectId,
      rootKind: context.rootKind,
      terminalId: null,
      workerId: context.workerId,
      worktreeId: context.worktreeId,
      worktreeMode: context.worktreeMode,
    };
  };

  return {
    agentOperationExecutor,
    chatOperationContext,
  };
}
