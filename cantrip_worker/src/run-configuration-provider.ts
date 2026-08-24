import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import {
  RUN_CONFIGURATION_FILE_SCHEMA,
  runConfigurationDiagnosticSchema,
  runConfigurationProviderCapabilitySchema,
  runConfigurationShellDocumentSchema,
  type RunConfigurationDiagnostic,
  type RunConfigurationEnvironment,
  type RunConfigurationFile,
  type RunConfigurationPlatform,
  type RunConfigurationProviderCapability,
  type RunConfigurationShellDocument,
} from "@cantrip/protocol/run-configuration-definitions";

export interface RunConfigurationProviderContext {
  defaultShell: string | null;
  platform: RunConfigurationPlatform;
  targetRoot: string;
}

export interface RunConfigurationProviderCandidate<
  TDocument extends RunConfigurationFile = RunConfigurationFile,
> {
  confidence: "high" | "medium" | "low";
  document: TDocument;
  reason: string;
}

export interface MaterializedRunCommand {
  arguments: string[];
  executable: string;
  workingDirectory: string;
}

export interface MaterializedRunConfiguration extends MaterializedRunCommand {
  beforeLaunch: MaterializedRunCommand[];
  effectiveCommand: string;
  environment: RunConfigurationEnvironment;
  environmentAdditions?: Record<string, string>;
}

export interface RunConfigurationProvider<
  TDocument extends RunConfigurationFile = RunConfigurationFile,
> {
  readonly capability: RunConfigurationProviderCapability;
  createDefault(input: { id: string; name: string }): TDocument;
  discover(
    context: RunConfigurationProviderContext,
  ): Promise<RunConfigurationProviderCandidate<TDocument>[]>;
  renderEffectiveCommand(
    document: TDocument,
    platform: RunConfigurationPlatform,
  ): string;
  validate(
    document: TDocument,
    context: RunConfigurationProviderContext,
  ): Promise<RunConfigurationDiagnostic[]>;
  materialize(
    document: TDocument,
    context: RunConfigurationProviderContext,
  ): Promise<MaterializedRunConfiguration>;
}

interface ResolvedShellConfiguration {
  arguments: string[];
  commandOverride: string | null;
  environment: RunConfigurationEnvironment;
  login: boolean;
  shell: RunConfigurationShellDocument["options"]["shell"];
  workingDirectory: string;
}

type ShellPlatformOverride = NonNullable<
  RunConfigurationShellDocument["platformOverrides"]["win32"]
>;

export function runConfigurationProviderDiagnostic(
  code: string,
  message: string,
  field: string,
): RunConfigurationDiagnostic {
  return runConfigurationDiagnosticSchema.parse({
    severity: "error",
    code,
    message,
    relativePath: null,
    field,
  });
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export async function resolveRealDirectory(
  targetRoot: string,
  relativeDirectory: string,
): Promise<string> {
  const root = await realpath(targetRoot);
  const candidate = path.resolve(root, ...relativeDirectory.split("/"));
  if (!isInside(root, candidate)) {
    throw new Error("The working directory resolves outside the target root.");
  }
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("The working directory does not exist.");
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("The working directory must be a real directory.");
  }
  const canonical = await realpath(candidate);
  if (!isInside(root, canonical)) {
    throw new Error("The working directory resolves outside the target root.");
  }
  return canonical;
}

export async function validateRealScript(
  targetRoot: string,
  relativePath: string,
): Promise<string> {
  const root = await realpath(targetRoot);
  const candidate = path.resolve(root, ...relativePath.split("/"));
  if (!isInside(root, candidate)) {
    throw new Error("The script resolves outside the target root.");
  }
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("The script does not exist.");
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("The script must be a real file.");
  }
  const canonical = await realpath(candidate);
  if (!isInside(root, canonical)) {
    throw new Error("The script resolves outside the target root.");
  }
  return canonical;
}

function mergeEnvironment(
  base: RunConfigurationEnvironment,
  override: ShellPlatformOverride["environment"],
): RunConfigurationEnvironment {
  if (!override) return base;
  return {
    includeCodexEnvironment:
      override.includeCodexEnvironment ?? base.includeCodexEnvironment,
    files: override.files ?? base.files,
    variables: override.variables ?? base.variables,
    secrets: override.secrets ?? base.secrets,
  };
}

function resolveConfiguration(
  document: RunConfigurationShellDocument,
  platform: RunConfigurationPlatform,
): ResolvedShellConfiguration {
  const override = document.platformOverrides[platform];
  return {
    workingDirectory: override?.workingDirectory ?? document.workingDirectory,
    commandOverride:
      override && Object.hasOwn(override, "commandOverride")
        ? (override.commandOverride ?? null)
        : document.commandOverride,
    arguments: override?.arguments ?? document.arguments,
    environment: mergeEnvironment(document.environment, override?.environment),
    shell: override?.options?.shell ?? document.options.shell,
    login: override?.options?.login ?? document.options.login,
  };
}

function quotePosix(value: string): string {
  if (value.length === 0) return "''";
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function quotePowerShell(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function quoteCmd(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/u.test(value)) return value;
  return '"' + value.replaceAll('"', '""') + '"';
}

function commandWithArguments(
  command: string,
  values: string[],
  platform: RunConfigurationPlatform,
  shell: ResolvedShellConfiguration["shell"],
): string {
  if (values.length === 0) return command;
  const quote =
    platform === "win32"
      ? shell === "cmd"
        ? quoteCmd
        : quotePowerShell
      : quotePosix;
  return command + " " + values.map(quote).join(" ");
}

function targetCommand(
  document: RunConfigurationShellDocument,
  resolved: ResolvedShellConfiguration,
  platform: RunConfigurationPlatform,
  scriptPath = document.target.kind === "script"
    ? document.target.path
    : undefined,
): string {
  if (resolved.commandOverride !== null) {
    return commandWithArguments(
      resolved.commandOverride,
      resolved.arguments,
      platform,
      resolved.shell,
    );
  }
  if (document.target.kind === "command") {
    return commandWithArguments(
      document.target.command,
      resolved.arguments,
      platform,
      resolved.shell,
    );
  }
  const quote =
    platform === "win32"
      ? resolved.shell === "cmd"
        ? quoteCmd
        : quotePowerShell
      : quotePosix;
  const resolvedScriptPath = scriptPath ?? document.target.path;
  const command = document.target.interpreter
    ? document.target.interpreter + " " + quote(resolvedScriptPath)
    : platform === "win32" && resolved.shell !== "cmd"
      ? "& " + quote(resolvedScriptPath)
      : quote(resolvedScriptPath);
  return commandWithArguments(
    command,
    resolved.arguments,
    platform,
    resolved.shell,
  );
}

export interface RunConfigurationShellInvocationOptions {
  login: boolean;
  shell: RunConfigurationShellDocument["options"]["shell"];
}

export function shellCommandInvocation(
  command: string,
  context: RunConfigurationProviderContext,
  options: RunConfigurationShellInvocationOptions = {
    shell: "automatic",
    login: true,
  },
): Pick<MaterializedRunCommand, "arguments" | "executable"> {
  const selected =
    options.shell === "automatic"
      ? context.platform === "win32"
        ? "powershell"
        : context.defaultShell || "/bin/sh"
      : options.shell;

  if (selected === "powershell") {
    if (context.platform !== "win32") {
      throw new Error("PowerShell Run configurations require Windows.");
    }
    return {
      executable: "powershell.exe",
      arguments: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        command,
      ],
    };
  }
  if (selected === "cmd") {
    if (context.platform !== "win32") {
      throw new Error("Command Prompt Run configurations require Windows.");
    }
    return {
      executable: "cmd.exe",
      arguments: ["/d", "/s", "/c", command],
    };
  }
  if (context.platform === "win32") {
    throw new Error(
      "POSIX shell Run configurations are unavailable on Windows.",
    );
  }
  return {
    executable: selected,
    arguments: [options.login ? "-lc" : "-c", command],
  };
}

function shellInvocation(
  command: string,
  resolved: Pick<ResolvedShellConfiguration, "login" | "shell">,
  context: RunConfigurationProviderContext,
): Pick<MaterializedRunCommand, "arguments" | "executable"> {
  return shellCommandInvocation(command, context, resolved);
}

async function materializeBeforeLaunch(
  document: RunConfigurationShellDocument,
  context: RunConfigurationProviderContext,
  resolved: ResolvedShellConfiguration,
): Promise<MaterializedRunCommand[]> {
  const commands: MaterializedRunCommand[] = [];
  for (const step of document.beforeLaunch) {
    if (step.kind !== "command") {
      throw new Error(
        "Shell Run configurations do not support provider before-launch tasks.",
      );
    }
    commands.push({
      ...shellInvocation(step.command, resolved, context),
      workingDirectory: await resolveRealDirectory(
        context.targetRoot,
        step.workingDirectory,
      ),
    });
  }
  return commands;
}

export const shellRunConfigurationProvider: RunConfigurationProvider<RunConfigurationShellDocument> =
  {
    capability: runConfigurationProviderCapabilitySchema.parse({
      provider: "shell",
      label: "Shell",
      icon: "terminal",
      available: true,
      supportsDiscovery: false,
      supportsCommandOverride: true,
      supportsBeforeLaunch: true,
      supportsPlatformOverrides: true,
    }),

    createDefault({ id, name }) {
      return runConfigurationShellDocumentSchema.parse({
        schema: RUN_CONFIGURATION_FILE_SCHEMA,
        version: 1,
        id,
        name,
        provider: "shell",
        target: { kind: "command", command: "echo Ready" },
      });
    },

    async discover() {
      return [];
    },

    renderEffectiveCommand(document, platform) {
      const parsed = runConfigurationShellDocumentSchema.parse(document);
      return targetCommand(
        parsed,
        resolveConfiguration(parsed, platform),
        platform,
      );
    },

    async validate(document, context) {
      const parsed = runConfigurationShellDocumentSchema.parse(document);
      const resolved = resolveConfiguration(parsed, context.platform);
      const diagnostics: RunConfigurationDiagnostic[] = [];
      try {
        await resolveRealDirectory(
          context.targetRoot,
          resolved.workingDirectory,
        );
      } catch (error) {
        diagnostics.push(
          runConfigurationProviderDiagnostic(
            "working-directory-invalid",
            error instanceof Error ? error.message : String(error),
            "workingDirectory",
          ),
        );
      }
      if (
        resolved.commandOverride === null &&
        parsed.target.kind === "script"
      ) {
        try {
          await validateRealScript(context.targetRoot, parsed.target.path);
        } catch (error) {
          diagnostics.push(
            runConfigurationProviderDiagnostic(
              "script-invalid",
              error instanceof Error ? error.message : String(error),
              "target.path",
            ),
          );
        }
      }
      for (let index = 0; index < parsed.beforeLaunch.length; index += 1) {
        const step = parsed.beforeLaunch[index]!;
        if (step.kind === "providerTask") {
          diagnostics.push(
            runConfigurationProviderDiagnostic(
              "provider-task-unsupported",
              "Shell Run configurations do not support provider before-launch tasks.",
              "beforeLaunch[" + index + "]",
            ),
          );
          continue;
        }
        try {
          await resolveRealDirectory(context.targetRoot, step.workingDirectory);
        } catch (error) {
          diagnostics.push(
            runConfigurationProviderDiagnostic(
              "before-launch-directory-invalid",
              error instanceof Error ? error.message : String(error),
              "beforeLaunch[" + index + "].workingDirectory",
            ),
          );
        }
      }
      try {
        shellInvocation(
          targetCommand(parsed, resolved, context.platform),
          resolved,
          context,
        );
      } catch (error) {
        diagnostics.push(
          runConfigurationProviderDiagnostic(
            "shell-unavailable",
            error instanceof Error ? error.message : String(error),
            "options.shell",
          ),
        );
      }
      return diagnostics;
    },

    async materialize(document, context) {
      const parsed = runConfigurationShellDocumentSchema.parse(document);
      const diagnostics = await this.validate(parsed, context);
      if (diagnostics.length > 0) {
        throw new Error(diagnostics.map(({ message }) => message).join(" "));
      }
      const resolved = resolveConfiguration(parsed, context.platform);
      const effectiveCommand = targetCommand(
        parsed,
        resolved,
        context.platform,
      );
      const launchCommand =
        resolved.commandOverride === null && parsed.target.kind === "script"
          ? targetCommand(
              parsed,
              resolved,
              context.platform,
              await validateRealScript(context.targetRoot, parsed.target.path),
            )
          : effectiveCommand;
      return {
        ...shellInvocation(launchCommand, resolved, context),
        workingDirectory: await resolveRealDirectory(
          context.targetRoot,
          resolved.workingDirectory,
        ),
        beforeLaunch: await materializeBeforeLaunch(parsed, context, resolved),
        effectiveCommand,
        environment: resolved.environment,
      };
    },
  };
