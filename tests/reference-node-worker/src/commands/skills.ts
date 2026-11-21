import {
  protectWorkerCustomizationResponse,
  openWorkerCustomizationRequest,
} from "../customization-content-encryption.js";
import {
  skillListSchema,
  skillSettingsInventorySchema,
  skillSettingsFileRequestSchema,
  skillSettingsDocumentSchema,
  skillSettingsFileUpdateSchema,
  skillSettingsMutationResultSchema,
  skillSettingsDeleteRequestSchema,
  skillSettingsConfigUpdateSchema,
  skillSettingsConfigResultSchema,
} from "@cantrip/protocol";
import { managedRuntimeTarget } from "../codex/managed-runtime-namespaces.js";
import type { WorkerCommand } from "@cantrip/protocol";
import type { WorkerConfig } from "../config.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import type { SkillManager } from "../skill-manager.js";
import type { CustomizationContentReplayGuard } from "../customization-content-encryption.js";
import type { CommandRuntimeFor } from "./runtime.js";
import type { RuntimeProvider } from "../protected-secrets.js";

export type SkillsCommand = Extract<
  WorkerCommand,
  {
    type:
      | "skills.list"
      | "skills.settings.list"
      | "skills.settings.read"
      | "skills.settings.write"
      | "skills.settings.delete"
      | "skills.settings.configure";
  }
>;
export interface SkillsCommandDependencies {
  config: Pick<WorkerConfig, "workerId" | "dataDirectory">;
  workerEncryption: WorkerEncryptionService;
  runtimeFor: CommandRuntimeFor;
  provider: () => RuntimeProvider;
  skillManager: Pick<
    SkillManager,
    "list" | "read" | "write" | "delete" | "configurationPath"
  >;
  customizationContentReplay: Pick<CustomizationContentReplayGuard, "reserve">;
}

// Services are owned by the worker entry point; this handler only executes commands.
export async function handleSkillsCommand(
  command: SkillsCommand,
  dependencies: SkillsCommandDependencies,
): Promise<unknown> {
  const {
    config,
    workerEncryption,
    runtimeFor,
    provider,
    skillManager,
    customizationContentReplay,
  } = dependencies;
  switch (command.type) {
    case "skills.list":
      return protectWorkerCustomizationResponse({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        schema: skillListSchema,
        service: workerEncryption,
        execute: () =>
          runtimeFor({
            ...managedRuntimeTarget(command),
            model: command.model,
            provider: provider(),
          }).listSkills({
            cwd: command.cwd,
            model: command.model,
            provider: provider(),
          }),
      });
    case "skills.settings.list":
      return protectWorkerCustomizationResponse({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        schema: skillSettingsInventorySchema,
        service: workerEncryption,
        execute: async () => {
          if (!command.model || !command.provider) {
            return skillManager.list(command);
          }
          const runtime = runtimeFor({
            ...managedRuntimeTarget(command),
            model: command.model,
            provider: provider(),
          });
          const codexSkills = await runtime.listSkillInventory(
            {
              cwd: command.cwd ?? config.dataDirectory,
              model: command.model,
              provider: provider(),
            },
            true,
          );
          return skillManager.list(command, codexSkills);
        },
      });
    case "skills.settings.read": {
      const input = await openWorkerCustomizationRequest({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        opaque: command.protectedRequest,
        schema: skillSettingsFileRequestSchema.pick({
          skillId: true,
          file: true,
        }),
        service: workerEncryption,
      });
      return protectWorkerCustomizationResponse({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        schema: skillSettingsDocumentSchema,
        service: workerEncryption,
        execute: () => skillManager.read(command, input.skillId, input.file),
      });
    }
    case "skills.settings.write": {
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
        schema: skillSettingsFileUpdateSchema.pick({
          skillId: true,
          file: true,
          content: true,
        }),
        service: workerEncryption,
      });
      return protectWorkerCustomizationResponse({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        schema: skillSettingsMutationResultSchema,
        service: workerEncryption,
        execute: () =>
          skillManager.write(command, input.skillId, input.file, input.content),
      });
    }
    case "skills.settings.delete": {
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
        schema: skillSettingsDeleteRequestSchema.pick({ skillId: true }),
        service: workerEncryption,
      });
      return protectWorkerCustomizationResponse({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        schema: skillSettingsMutationResultSchema,
        service: workerEncryption,
        execute: () => skillManager.delete(command, input.skillId),
      });
    }
    case "skills.settings.configure": {
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
        schema: skillSettingsConfigUpdateSchema.pick({
          skillId: true,
          enabled: true,
        }),
        service: workerEncryption,
      });
      return protectWorkerCustomizationResponse({
        serverId: command.serverId,
        workerId: config.workerId,
        scope: command.scope,
        operationId: command.operationId,
        operation: command.type,
        schema: skillSettingsConfigResultSchema,
        service: workerEncryption,
        execute: async () => {
          const skillPath = await skillManager.configurationPath(
            command,
            input.skillId,
          );
          const result = await runtimeFor({
            ...managedRuntimeTarget(command),
            model: command.model,
            provider: provider(),
          }).configureSkill({
            cwd: command.cwd ?? config.dataDirectory,
            model: command.model,
            provider: provider(),
            path: skillPath,
            enabled: input.enabled,
          });
          return skillSettingsConfigResultSchema.parse({
            skillId: input.skillId,
            effectiveEnabled: result.effectiveEnabled,
          });
        },
      });
    }
  }
}
