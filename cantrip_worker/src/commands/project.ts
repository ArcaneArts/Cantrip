import { discoverScriptCommands } from "../script-command-discovery.js";
import { openTerminalPrivateState } from "../terminal-private-state.js";
import { protectWorkerRepositoryOperationContent } from "../repository-operation-encryption.js";
import { scriptCommandListSchema } from "@cantrip/protocol";
import {
  protectedRunConfigurationRuntimeWorkerOutputSchema,
  runConfigurationRuntimeOutputContentSchema,
} from "@cantrip/protocol/run-configuration-runtime";
import { protectWorkerRunContent } from "../run-content-encryption.js";
import { readProjectRepositoryStats } from "../project-repository-stats.js";
import { readProjectFolderStats } from "../project-folder-stats.js";
import { openWorkerTunnelContentRecord } from "../tunnel-content-encryption.js";
import { assertProjectShareDestinationBinding } from "../project-share-binding.js";
import type { WorkerCommand, WorkerEvent } from "@cantrip/protocol";
import type { GithubClient } from "../github.js";
import type { ManagedFolderManager } from "../managed-folders.js";
import type { RunConfigurationRuntimeSupervisor } from "../run-configuration-runtime-supervisor.js";
import type { ProjectGithubConverter } from "../project-github-conversion.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import type { RunConfigurationDefinitionService } from "../run-configuration-definition-service.js";
import type { ProjectExportManager } from "../project-export-manager.js";
import type { WorkerConfig } from "../config.js";
import type { ChatScratchManager } from "../chat-scratch.js";
import type { ProjectShareManager } from "../project-share-manager.js";

export type ProjectCommand = Extract<
  WorkerCommand,
  {
    type:
      | "project.clone"
      | "project.folder.materialize"
      | "project.folder.delete"
      | "project.folder-conversion.preflight"
      | "project.folder-conversion.execute"
      | "project.replica.provision"
      | "project.replica.synchronize"
      | "project.replica.remove"
      | "project.replica.link.repair"
      | "project.files.delete"
      | "project.script-commands"
      | "project.script-commands.inspect"
      | "project.run-configuration-definitions.list"
      | "project.run-configuration-definitions.get"
      | "project.run-configuration-definitions.capabilities"
      | "project.run-configuration-definitions.detect"
      | "project.run-configuration-definitions.paths"
      | "project.run-configuration-definitions.flutter-devices"
      | "project.run-configuration-definitions.validate"
      | "project.run-configuration-definitions.write"
      | "project.run-configuration-definitions.delete"
      | "project.run-configuration-runtime.start"
      | "project.run-configuration-runtime.restart"
      | "project.run-configuration-runtime.stop"
      | "project.run-configuration-runtime.status"
      | "project.run-configuration-runtime.output"
      | "project.run-configuration-runtime.reconcile"
      | "project.repository-stats"
      | "project.folder-stats"
      | "project.export.target.inspect"
      | "project.export.chat.begin"
      | "project.export.chat.chunk"
      | "project.export.chat.complete"
      | "project.share.open"
      | "project.share.close";
  }
>;
export interface ProjectCommandDependencies {
  github: Pick<
    GithubClient,
    | "cloneRepository"
    | "provisionReplica"
    | "synchronizeReplica"
    | "removeReplica"
    | "repairReplicaLink"
    | "deleteRepository"
  >;
  managedFolders: Pick<ManagedFolderManager, "materialize" | "delete">;
  runConfigurationRuntimes: Pick<
    RunConfigurationRuntimeSupervisor,
    | "stopProject"
    | "stopForPath"
    | "start"
    | "restart"
    | "stop"
    | "status"
    | "output"
    | "reconcile"
  >;
  projectGithubConverter: Pick<ProjectGithubConverter, "preflight" | "execute">;
  workerEncryption: WorkerEncryptionService;
  runConfigurationDefinitions: Pick<
    RunConfigurationDefinitionService,
    "execute"
  >;
  projectExports: Pick<
    ProjectExportManager,
    "inspect" | "begin" | "append" | "complete"
  >;
  config: Pick<WorkerConfig, "workerId">;
  chatScratch: Pick<ChatScratchManager, "resolve">;
  projectShares: Pick<ProjectShareManager, "open" | "close">;
}

// Services are owned by the worker entry point; this handler only executes commands.
export async function handleProjectCommand(
  command: ProjectCommand,
  dependencies: ProjectCommandDependencies,
  emit: (event: WorkerEvent) => void,
): Promise<unknown> {
  const {
    github,
    managedFolders,
    runConfigurationRuntimes,
    projectGithubConverter,
    workerEncryption,
    runConfigurationDefinitions,
    projectExports,
    config,
    chatScratch,
    projectShares,
  } = dependencies;
  switch (command.type) {
    case "project.clone":
      return github.cloneRepository(command.repository.nameWithOwner);
    case "project.folder.materialize":
      return managedFolders.materialize(command);
    case "project.folder.delete": {
      await runConfigurationRuntimes.stopProject(command.projectId);
      return managedFolders.delete(command.projectId, command.workspaceStorage);
    }
    case "project.folder-conversion.preflight":
      return projectGithubConverter.preflight(command);
    case "project.folder-conversion.execute":
      return projectGithubConverter.execute(command);
    case "project.replica.provision":
      return github.provisionReplica(
        {
          jobId: command.jobId,
          attempt: command.attempt,
          projectId: command.projectId ?? command.jobId,
          nameWithOwner: command.repository?.nameWithOwner ?? null,
          workspaceStorage: command.workspaceStorage,
          placement: command.placement ?? { mode: "managed" },
          expectedRevision: command.expectedRevision,
        },
        (progress) =>
          emit({
            type: "project.replica.progress",
            jobId: command.jobId,
            attempt: command.attempt,
            progress,
          }),
      );
    case "project.replica.synchronize":
      return github.synchronizeReplica(
        {
          jobId: command.jobId,
          attempt: command.attempt,
          projectId: command.projectId ?? command.jobId,
          nameWithOwner: command.repository.nameWithOwner,
          sourcePath: command.sourcePath,
          placement: command.placement,
          repositoryFingerprint: command.repositoryFingerprint,
          expectedRevision: command.expectedRevision,
          policy: command.policy,
        },
        (progress) =>
          emit({
            type: "project.replica.progress",
            jobId: command.jobId,
            attempt: command.attempt,
            progress,
          }),
      );
    case "project.replica.remove":
      return github.removeReplica(
        {
          jobId: command.jobId,
          attempt: command.attempt,
          projectId: command.projectId ?? command.jobId,
          nameWithOwner: command.repository?.nameWithOwner ?? null,
          sourcePath: command.sourcePath,
          placement: command.placement,
          repositoryFingerprint: command.repositoryFingerprint,
          deleteLocalFiles: command.deleteLocalFiles,
        },
        (progress) =>
          emit({
            type: "project.replica.progress",
            jobId: command.jobId,
            attempt: command.attempt,
            progress,
          }),
      );
    case "project.replica.link.repair":
      return github.repairReplicaLink({
        projectId: command.projectId,
        nameWithOwner: command.repository.nameWithOwner,
        sourcePath: command.sourcePath,
        linkPath: command.linkPath,
        repositoryFingerprint: command.repositoryFingerprint,
      });
    case "project.files.delete":
      await runConfigurationRuntimes.stopForPath(command.path);
      return github.deleteRepository(command.path);
    case "project.script-commands":
      try {
        const commands = await discoverScriptCommands(
          (
            await openTerminalPrivateState({
              serverId: command.serverId,
              terminalId: command.terminalId,
              worktreePath: command.worktreePath,
              stateProtection: command.stateProtection,
              service: workerEncryption,
            })
          ).cwd,
        );
        return protectWorkerRepositoryOperationContent({
          context: {
            serverId: command.serverId,
            projectId: command.terminalId,
            worktreeId: command.terminalId,
            operationId: command.operationId,
            direction: "response",
          },
          content: commands,
          schema: scriptCommandListSchema,
          service: workerEncryption,
        });
      } catch {
        throw new Error("Could not discover terminal script commands.");
      }
    case "project.script-commands.inspect":
      try {
        return protectWorkerRepositoryOperationContent({
          context: {
            serverId: command.serverId,
            projectId: command.projectId,
            worktreeId: command.worktreeId,
            operationId: command.operationId,
            direction: "response",
          },
          content: await discoverScriptCommands(command.sourcePath),
          schema: scriptCommandListSchema,
          service: workerEncryption,
        });
      } catch {
        throw new Error("Could not discover project script commands.");
      }
    case "project.run-configuration-definitions.list":
    case "project.run-configuration-definitions.get":
    case "project.run-configuration-definitions.capabilities":
    case "project.run-configuration-definitions.detect":
    case "project.run-configuration-definitions.paths":
    case "project.run-configuration-definitions.flutter-devices":
    case "project.run-configuration-definitions.validate":
    case "project.run-configuration-definitions.write":
    case "project.run-configuration-definitions.delete":
      return runConfigurationDefinitions.execute(command);
    case "project.run-configuration-runtime.start":
      return runConfigurationRuntimes.start(command);
    case "project.run-configuration-runtime.restart":
      return runConfigurationRuntimes.restart(command);
    case "project.run-configuration-runtime.stop":
      return runConfigurationRuntimes.stop(command);
    case "project.run-configuration-runtime.status":
      return runConfigurationRuntimes.status(command.identity);
    case "project.run-configuration-runtime.output": {
      const snapshot = runConfigurationRuntimes.output(command);
      return protectedRunConfigurationRuntimeWorkerOutputSchema.parse({
        requestOperationId: command.requestOperationId,
        identity: snapshot.identity,
        protectedOutput: await protectWorkerRunContent({
          serverId: command.serverId,
          projectId: command.identity.projectId,
          worktreeId: command.identity.worktreeId,
          operationId: command.requestOperationId,
          operation: "run.configuration.output",
          content: {
            data: snapshot.data,
            truncated: snapshot.truncated,
          },
          schema: runConfigurationRuntimeOutputContentSchema,
          service: workerEncryption,
        }),
      });
    }
    case "project.run-configuration-runtime.reconcile":
      return runConfigurationRuntimes.reconcile(command.identities);
    case "project.repository-stats":
      return readProjectRepositoryStats(command.cwd);
    case "project.folder-stats":
      return readProjectFolderStats(command.root);
    case "project.export.target.inspect":
      return projectExports.inspect(command.target, command.cwd);
    case "project.export.chat.begin":
      return projectExports.begin(command);
    case "project.export.chat.chunk":
      await projectExports.append(
        command.operationId,
        command.chatId,
        command.chunkIndex,
        Buffer.from(command.data, "base64"),
      );
      return { accepted: true };
    case "project.export.chat.complete":
      return projectExports.complete(command.operationId, command.chatId);
    case "project.share.open": {
      const content = await openWorkerTunnelContentRecord({
        record: command.protectedRecord,
        serverId: workerEncryption.serverIdentity(),
        service: workerEncryption,
        tunnelId: command.shareId,
        workerId: config.workerId,
      });
      assertProjectShareDestinationBinding(
        command,
        content.destination,
        config.workerId,
      );
      if (
        command.protectedRecord.operationId !== command.shareId &&
        command.protectedRecord.revision === 1
      ) {
        throw new Error(
          "Protected project share content belongs to another endpoint.",
        );
      }
      const root =
        content.destination.kind === "worker-chat-share"
          ? (
              await chatScratch.resolve({
                rootId: content.destination.rootId,
                chatId: content.destination.chatId,
              })
            ).path
          : content.destination.root;
      await projectShares.open({
        password: content.destination.password,
        publicBasePath: content.destination.publicBasePath,
        publicOrigin: content.destination.publicOrigin,
        realm: content.destination.realm,
        root,
        shareId: command.shareId,
        username: content.destination.username,
      });
      return { accepted: true as const, shareId: command.shareId };
    }
    case "project.share.close":
      await projectShares.close(command.shareId);
      return { accepted: true };
  }
}
