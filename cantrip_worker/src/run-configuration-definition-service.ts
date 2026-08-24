import {
  runConfigurationCapabilitiesResponseSchema,
  runConfigurationDefinitionChangeNotificationSchema,
  runConfigurationDeleteResponseSchema,
  runConfigurationDetectResponseSchema,
  runConfigurationGetResponseSchema,
  runConfigurationListResponseSchema,
  runConfigurationPathsResponseSchema,
  runConfigurationValidateResponseSchema,
  runConfigurationWriteResponseSchema,
  type RunConfigurationDefinitionChangeNotification,
  type RunConfigurationDefinitionWorkerCommand,
  type RunConfigurationOperationResponse,
} from "@cantrip/protocol/run-configuration-operations";
import type {
  RunConfigurationDiagnostic,
  RunConfigurationFile,
} from "@cantrip/protocol/run-configuration-definitions";

import { shellRunConfigurationProvider } from "./run-configuration-provider.js";
import { nodeRunConfigurationProvider } from "./run-configuration-node-provider.js";
import { javaRunConfigurationProvider } from "./run-configuration-java-provider.js";
import { dartRunConfigurationProvider } from "./run-configuration-dart-provider.js";
import { flutterRunConfigurationProvider } from "./run-configuration-flutter-provider.js";
import { rustRunConfigurationProvider } from "./run-configuration-rust-provider.js";
import { discoverRunConfigurationPaths } from "./run-configuration-path-discovery.js";
import { inspectRunConfigurationCodexEnvironmentSource } from "./run-configuration-environment-source.js";
import {
  RunConfigurationRepository,
  type RunConfigurationRepositoryWatcher,
} from "./run-configuration-repository.js";

const MAX_OBSERVED_PROJECTS = 256;

function workerPlatform(): "darwin" | "linux" | "win32" {
  if (process.platform === "darwin" || process.platform === "win32") {
    return process.platform;
  }
  return "linux";
}

async function validateProviderDocument(
  document: RunConfigurationFile,
  sourcePath: string,
) {
  const platform = workerPlatform();
  const providerContext = {
    defaultShell: process.env.SHELL ?? null,
    platform,
    targetRoot: sourcePath,
  };
  let diagnostics: RunConfigurationDiagnostic[];
  let effectiveCommand: string;
  switch (document.provider) {
    case "shell":
      diagnostics = await shellRunConfigurationProvider.validate(
        document,
        providerContext,
      );
      effectiveCommand = shellRunConfigurationProvider.renderEffectiveCommand(
        document,
        platform,
      );
      break;
    case "node":
      diagnostics = await nodeRunConfigurationProvider.validate(
        document,
        providerContext,
      );
      effectiveCommand = nodeRunConfigurationProvider.renderEffectiveCommand(
        document,
        platform,
      );
      break;
    case "java":
      diagnostics = await javaRunConfigurationProvider.validate(
        document,
        providerContext,
      );
      effectiveCommand = javaRunConfigurationProvider.renderEffectiveCommand(
        document,
        platform,
      );
      break;
    case "dart":
      diagnostics = await dartRunConfigurationProvider.validate(
        document,
        providerContext,
      );
      effectiveCommand = dartRunConfigurationProvider.renderEffectiveCommand(
        document,
        platform,
      );
      break;
    case "flutter":
      diagnostics = await flutterRunConfigurationProvider.validate(
        document,
        providerContext,
      );
      effectiveCommand = flutterRunConfigurationProvider.renderEffectiveCommand(
        document,
        platform,
      );
      break;
    case "rust":
      diagnostics = await rustRunConfigurationProvider.validate(
        document,
        providerContext,
      );
      effectiveCommand = rustRunConfigurationProvider.renderEffectiveCommand(
        document,
        platform,
      );
      break;
  }
  return {
    configurationId: document.id,
    provider: document.provider,
    platform,
    effectiveCommand,
    valid: diagnostics.every(({ severity }) => severity !== "error"),
    diagnostics,
  };
}

interface ObservedRepository {
  repository: RunConfigurationRepository;
  watcher: RunConfigurationRepositoryWatcher;
}

export class RunConfigurationDefinitionService {
  readonly #emit: (
    notification: RunConfigurationDefinitionChangeNotification,
  ) => boolean | void | Promise<boolean | void>;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #repositories = new Map<string, ObservedRepository>();
  #closed = false;

  constructor(options: {
    emit: (
      notification: RunConfigurationDefinitionChangeNotification,
    ) => boolean | void | Promise<boolean | void>;
  }) {
    this.#emit = options.emit;
  }

  async execute(
    command: RunConfigurationDefinitionWorkerCommand,
  ): Promise<RunConfigurationOperationResponse> {
    if (this.#closed) {
      throw new Error("The Run configuration definition service is closed.");
    }
    const repository = await this.#repositoryFor(
      command.projectId,
      command.sourcePath,
    );
    const context = {
      operationId: command.operationId,
      projectId: command.projectId,
    };
    switch (command.type) {
      case "project.run-configuration-definitions.list":
        return runConfigurationListResponseSchema.parse({
          operation: "list",
          ...context,
          inventory: await repository.scan(),
        });
      case "project.run-configuration-definitions.get": {
        const result = await repository.read(command.configurationId);
        const document =
          result.found && result.entry.status === "ready"
            ? result.entry.document
            : null;
        const platform = workerPlatform();
        const enabled = document
          ? (document.platformOverrides[platform]?.environment
              ?.includeCodexEnvironment ??
            document.environment.includeCodexEnvironment)
          : false;
        return runConfigurationGetResponseSchema.parse({
          operation: "get",
          ...context,
          result,
          codexEnvironment: await inspectRunConfigurationCodexEnvironmentSource(
            {
              enabled,
              platform,
              sourceRoot: command.sourcePath,
            },
          ),
          secretReferences: [],
        });
      }
      case "project.run-configuration-definitions.capabilities":
        return runConfigurationCapabilitiesResponseSchema.parse({
          operation: "capabilities",
          ...context,
          capabilities: [
            shellRunConfigurationProvider.capability,
            nodeRunConfigurationProvider.capability,
            javaRunConfigurationProvider.capability,
            dartRunConfigurationProvider.capability,
            flutterRunConfigurationProvider.capability,
            rustRunConfigurationProvider.capability,
          ],
        });
      case "project.run-configuration-definitions.detect": {
        const providerContext = {
          defaultShell: process.env.SHELL ?? null,
          platform: workerPlatform(),
          targetRoot: command.sourcePath,
        };
        const candidates = [];
        if (command.providerKind === null || command.providerKind === "node") {
          candidates.push(
            ...(
              await nodeRunConfigurationProvider.discover(providerContext)
            ).map((candidate) => ({
              ...candidate,
              provider: "node" as const,
              effectiveCommand:
                nodeRunConfigurationProvider.renderEffectiveCommand(
                  candidate.document,
                  providerContext.platform,
                ),
            })),
          );
        }
        if (command.providerKind === null || command.providerKind === "java") {
          candidates.push(
            ...(
              await javaRunConfigurationProvider.discover(providerContext)
            ).map((candidate) => ({
              ...candidate,
              provider: "java" as const,
              effectiveCommand:
                javaRunConfigurationProvider.renderEffectiveCommand(
                  candidate.document,
                  providerContext.platform,
                ),
            })),
          );
        }
        if (command.providerKind === null || command.providerKind === "dart") {
          candidates.push(
            ...(
              await dartRunConfigurationProvider.discover(providerContext)
            ).map((candidate) => ({
              ...candidate,
              provider: "dart" as const,
              effectiveCommand:
                dartRunConfigurationProvider.renderEffectiveCommand(
                  candidate.document,
                  providerContext.platform,
                ),
            })),
          );
        }
        if (
          command.providerKind === null ||
          command.providerKind === "flutter"
        ) {
          candidates.push(
            ...(
              await flutterRunConfigurationProvider.discover(providerContext)
            ).map((candidate) => ({
              ...candidate,
              provider: "flutter" as const,
              effectiveCommand:
                flutterRunConfigurationProvider.renderEffectiveCommand(
                  candidate.document,
                  providerContext.platform,
                ),
            })),
          );
        }
        if (command.providerKind === null || command.providerKind === "rust") {
          candidates.push(
            ...(
              await rustRunConfigurationProvider.discover(providerContext)
            ).map((candidate) => ({
              ...candidate,
              provider: "rust" as const,
              effectiveCommand:
                rustRunConfigurationProvider.renderEffectiveCommand(
                  candidate.document,
                  providerContext.platform,
                ),
            })),
          );
        }
        const diagnostics =
          command.providerKind &&
          !["shell", "node", "java", "dart", "flutter", "rust"].includes(
            command.providerKind,
          )
            ? [
                {
                  severity: "warning" as const,
                  code: "provider-unavailable",
                  message: `The ${command.providerKind} Run configuration provider is not installed on this worker.`,
                  relativePath: null,
                  field: "provider",
                },
              ]
            : [];
        return runConfigurationDetectResponseSchema.parse({
          operation: "detect",
          ...context,
          candidates,
          diagnostics,
        });
      }
      case "project.run-configuration-definitions.paths":
        return runConfigurationPathsResponseSchema.parse({
          operation: "paths",
          ...context,
          purpose: command.purpose,
          query: command.query,
          ...(await discoverRunConfigurationPaths({
            purpose: command.purpose,
            query: command.query,
            sourceRoot: command.sourcePath,
          })),
        });
      case "project.run-configuration-definitions.validate":
        return runConfigurationValidateResponseSchema.parse({
          operation: "validate",
          ...context,
          validation: await validateProviderDocument(
            command.document,
            command.sourcePath,
          ),
        });
      case "project.run-configuration-definitions.write":
        return runConfigurationWriteResponseSchema.parse({
          operation: "write",
          ...context,
          result: await repository.write(command.request),
        });
      case "project.run-configuration-definitions.delete":
        return runConfigurationDeleteResponseSchema.parse({
          operation: "delete",
          ...context,
          result: await repository.delete(command.request),
        });
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const { watcher } of this.#repositories.values()) watcher.close();
    this.#repositories.clear();
  }

  async #repositoryFor(
    projectId: string,
    sourcePath: string,
  ): Promise<RunConfigurationRepository> {
    return this.#serialize(projectId, async () => {
      const opened = await RunConfigurationRepository.open(sourcePath);
      const current = this.#repositories.get(projectId);
      if (current?.repository.root === opened.root) {
        this.#repositories.delete(projectId);
        this.#repositories.set(projectId, current);
        return current.repository;
      }

      const watcher = await opened.watch(async (change) => {
        try {
          await this.#emit(
            runConfigurationDefinitionChangeNotificationSchema.parse({
              type: "project.run-configuration-definitions.changed",
              projectId,
              sourcePath: opened.root,
              change,
            }),
          );
        } catch {
          // A disconnected command channel is recovered by list-on-focus and
          // list-on-reconnect. Definition watching must remain alive meanwhile.
        }
      });
      current?.watcher.close();
      this.#repositories.delete(projectId);
      this.#repositories.set(projectId, { repository: opened, watcher });
      this.#evictInactiveProjects(projectId);
      return opened;
    });
  }

  #evictInactiveProjects(activeProjectId: string): void {
    while (this.#repositories.size > MAX_OBSERVED_PROJECTS) {
      const candidate = this.#repositories.entries().next().value as
        [string, ObservedRepository] | undefined;
      if (!candidate) return;
      const [projectId, observed] = candidate;
      if (projectId === activeProjectId) {
        this.#repositories.delete(projectId);
        this.#repositories.set(projectId, observed);
        continue;
      }
      observed.watcher.close();
      this.#repositories.delete(projectId);
    }
  }

  async #serialize<T>(
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#locks.get(projectId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#locks.set(projectId, current);
    await previous;
    try {
      if (this.#closed) {
        throw new Error("The Run configuration definition service is closed.");
      }
      return await operation();
    } finally {
      release();
      if (this.#locks.get(projectId) === current) {
        this.#locks.delete(projectId);
      }
    }
  }
}
