import {
  protectWorkerCustomizationResponse,
  openWorkerCustomizationRequest,
} from "../customization-content-encryption.js";
import {
  codexCustomizationInventorySchema,
  codexExternalImportPreviewSchema,
  codexMcpResourceReadRequestSchema,
  codexMcpResourceReadSchema,
  codexSkillConfigUpdateSchema,
  codexSkillConfigResultSchema,
  codexSkillRootsUpdateSchema,
  codexSkillRootsResultSchema,
  codexMcpOauthStartSchema,
  codexMcpOauthStartResultSchema,
  codexMcpOauthStatusSchema,
  codexMcpReloadRequestSchema,
  codexMcpReloadResultSchema,
  codexExternalImportApplySchema,
  codexExternalImportStatusSchema,
} from "@cantrip/protocol";
import { managedRuntimeTarget } from "../codex/managed-runtime-namespaces.js";
import type { WorkerCommand } from "@cantrip/protocol";
import type { WorkerConfig } from "../config.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import type { CustomizationContentReplayGuard } from "../customization-content-encryption.js";
import type { CommandRuntimeFor } from "./runtime.js";
import type { RuntimeProvider } from "../protected-secrets.js";

export type CustomizationCommand = Extract<
  WorkerCommand,
  {
    type:
      | "customization.inventory.read"
      | "customization.external.preview"
      | "customization.mcp.resource.read"
      | "customization.skill.configure"
      | "customization.skill-roots.set"
      | "customization.mcp.oauth.start"
      | "customization.mcp.oauth.status"
      | "customization.mcp.reload"
      | "customization.external.apply"
      | "customization.external.status";
  }
>;
export interface CustomizationCommandDependencies {
  config: Pick<WorkerConfig, "workerId">;
  workerEncryption: WorkerEncryptionService;
  runtimeFor: CommandRuntimeFor;
  provider: () => RuntimeProvider;
  customizationContentReplay: Pick<CustomizationContentReplayGuard, "reserve">;
}

// Services are owned by the worker entry point; this handler only executes commands.
export async function handleCustomizationCommand(
  command: CustomizationCommand,
  dependencies: CustomizationCommandDependencies,
): Promise<unknown> {
  const {
    config,
    workerEncryption,
    runtimeFor,
    provider,
    customizationContentReplay,
  } = dependencies;
  switch (command.type) {
    case "customization.inventory.read":
      return protectWorkerCustomizationResponse({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        schema: codexCustomizationInventorySchema,
        service: workerEncryption,
        execute: () =>
          runtimeFor({
            ...managedRuntimeTarget(command),
            model: command.model,
            provider: provider(),
          }).readCustomizationInventory(
            {
              cwd: command.cwd,
              threadId: command.threadId,
              model: command.model,
              provider: provider(),
            },
            command.forceReload,
          ),
      });
    case "customization.external.preview":
      return protectWorkerCustomizationResponse({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        schema: codexExternalImportPreviewSchema,
        service: workerEncryption,
        execute: () =>
          runtimeFor({
            ...managedRuntimeTarget(command),
            model: command.model,
            provider: provider(),
          }).previewExternalAgentConfig({
            cwd: command.cwd,
            model: command.model,
            provider: provider(),
          }),
      });
    case "customization.mcp.resource.read": {
      const input = await openWorkerCustomizationRequest({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        opaque: command.protectedRequest,
        schema: codexMcpResourceReadRequestSchema,
        service: workerEncryption,
      });
      return protectWorkerCustomizationResponse({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        schema: codexMcpResourceReadSchema,
        service: workerEncryption,
        execute: () =>
          runtimeFor({
            ...managedRuntimeTarget(command),
            model: command.model,
            provider: provider(),
          }).readMcpResource({
            cwd: command.cwd,
            threadId: command.threadId,
            model: command.model,
            provider: provider(),
            server: input.server,
            uri: input.uri,
          }),
      });
    }
    case "customization.skill.configure": {
      customizationContentReplay.reserve({
        serverId: command.serverId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
      });
      const input = await openWorkerCustomizationRequest({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        opaque: command.protectedRequest,
        schema: codexSkillConfigUpdateSchema,
        service: workerEncryption,
      });
      return protectWorkerCustomizationResponse({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        schema: codexSkillConfigResultSchema,
        service: workerEncryption,
        execute: () =>
          runtimeFor({
            ...managedRuntimeTarget(command),
            model: command.model,
            provider: provider(),
          }).configureSkill({
            cwd: command.cwd,
            model: command.model,
            provider: provider(),
            path: input.path,
            enabled: input.enabled,
          }),
      });
    }
    case "customization.skill-roots.set": {
      customizationContentReplay.reserve({
        serverId: command.serverId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
      });
      const input = await openWorkerCustomizationRequest({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        opaque: command.protectedRequest,
        schema: codexSkillRootsUpdateSchema,
        service: workerEncryption,
      });
      return protectWorkerCustomizationResponse({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        schema: codexSkillRootsResultSchema,
        service: workerEncryption,
        execute: () =>
          runtimeFor({
            ...managedRuntimeTarget(command),
            model: command.model,
            provider: provider(),
          }).setSkillRoots({
            cwd: command.cwd,
            model: command.model,
            provider: provider(),
            roots: input.roots,
          }),
      });
    }
    case "customization.mcp.oauth.start": {
      customizationContentReplay.reserve({
        serverId: command.serverId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
      });
      const input = await openWorkerCustomizationRequest({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        opaque: command.protectedRequest,
        schema: codexMcpOauthStartSchema,
        service: workerEncryption,
      });
      return protectWorkerCustomizationResponse({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        schema: codexMcpOauthStartResultSchema,
        service: workerEncryption,
        lifecycle: () => "pending",
        execute: () =>
          runtimeFor({
            ...managedRuntimeTarget(command),
            model: command.model,
            provider: provider(),
          }).startMcpOauth({
            cwd: command.cwd,
            model: command.model,
            provider: provider(),
            server: input.server,
          }),
      });
    }
    case "customization.mcp.oauth.status": {
      const input = await openWorkerCustomizationRequest({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        opaque: command.protectedRequest,
        schema: codexMcpOauthStartSchema,
        service: workerEncryption,
      });
      return protectWorkerCustomizationResponse({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        schema: codexMcpOauthStatusSchema,
        service: workerEncryption,
        lifecycle: (status) =>
          status.status === "pending"
            ? "pending"
            : status.status === "unknown"
              ? "unknown"
              : "completed",
        execute: () =>
          runtimeFor({
            ...managedRuntimeTarget(command),
            model: command.model,
            provider: provider(),
          }).mcpOauthStatus(input.server),
      });
    }
    case "customization.mcp.reload": {
      customizationContentReplay.reserve({
        serverId: command.serverId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
      });
      await openWorkerCustomizationRequest({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        opaque: command.protectedRequest,
        schema: codexMcpReloadRequestSchema,
        service: workerEncryption,
      });
      return protectWorkerCustomizationResponse({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        schema: codexMcpReloadResultSchema,
        service: workerEncryption,
        execute: () =>
          runtimeFor({
            ...managedRuntimeTarget(command),
            model: command.model,
            provider: provider(),
          }).reloadMcpServers({
            cwd: command.cwd,
            model: command.model,
            provider: provider(),
          }),
      });
    }
    case "customization.external.apply": {
      customizationContentReplay.reserve({
        serverId: command.serverId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
      });
      const input = await openWorkerCustomizationRequest({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        opaque: command.protectedRequest,
        schema: codexExternalImportApplySchema,
        service: workerEncryption,
      });
      return protectWorkerCustomizationResponse({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        schema: codexExternalImportStatusSchema,
        service: workerEncryption,
        lifecycle: (status) => status.status,
        execute: () =>
          runtimeFor({
            ...managedRuntimeTarget(command),
            model: command.model,
            provider: provider(),
          }).applyExternalAgentConfig({
            cwd: command.cwd,
            model: command.model,
            provider: provider(),
            itemIds: input.itemIds,
          }),
      });
    }
    case "customization.external.status": {
      const input = await openWorkerCustomizationRequest({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        opaque: command.protectedRequest,
        schema: codexExternalImportStatusSchema.pick({ importId: true }),
        service: workerEncryption,
      });
      return protectWorkerCustomizationResponse({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        schema: codexExternalImportStatusSchema,
        service: workerEncryption,
        lifecycle: (status) => status.status,
        execute: () =>
          runtimeFor({
            ...managedRuntimeTarget(command),
            model: command.model,
            provider: provider(),
          }).externalImportStatus(input.importId),
      });
    }
  }
}
