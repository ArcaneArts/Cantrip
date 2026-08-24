import {
  RUN_CONFIGURATION_FILE_SCHEMA,
  RUN_CONFIGURATION_FILE_VERSION,
  runConfigurationFileSchema,
  type RunConfigurationFile,
  type RunConfigurationNodeDocument,
  type RunConfigurationProviderKind,
  type RunConfigurationShellDocument,
} from "@cantrip/protocol/run-configuration-definitions";

function commonDocument(id: string) {
  return {
    schema:
      RUN_CONFIGURATION_FILE_SCHEMA as typeof RUN_CONFIGURATION_FILE_SCHEMA,
    version:
      RUN_CONFIGURATION_FILE_VERSION as typeof RUN_CONFIGURATION_FILE_VERSION,
    id,
    name: "",
    workingDirectory: ".",
    commandOverride: null,
    arguments: [],
    environment: {
      includeCodexEnvironment: true,
      files: [],
      variables: [],
      secrets: [],
    },
    beforeLaunch: [],
    platformOverrides: {},
    stop: { gracePeriodMs: 3_000 },
  };
}

export function createShellRunConfigurationDocument(
  id = crypto.randomUUID(),
): RunConfigurationShellDocument {
  return {
    ...commonDocument(id),
    provider: "shell",
    target: { kind: "command", command: "" },
    options: { shell: "automatic", login: true },
  };
}

export function createNodeRunConfigurationDocument(
  id = crypto.randomUUID(),
): RunConfigurationNodeDocument {
  return {
    ...commonDocument(id),
    provider: "node",
    target: { kind: "packageScript", script: "start" },
    options: {
      packageManager: "npm",
      runtime: "node",
      runtimeArguments: [],
    },
  };
}

export function createRunConfigurationDocument(
  provider: Extract<RunConfigurationProviderKind, "node" | "shell">,
  id = crypto.randomUUID(),
): RunConfigurationFile {
  return provider === "node"
    ? createNodeRunConfigurationDocument(id)
    : createShellRunConfigurationDocument(id);
}

function quoteArgument(argument: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(argument)
    ? argument
    : JSON.stringify(argument);
}

export function shellRunConfigurationEffectiveCommand(
  document: RunConfigurationShellDocument,
): { command: string; overridden: boolean } {
  const base = document.commandOverride
    ? document.commandOverride
    : document.target.kind === "command"
      ? document.target.command
      : [document.target.interpreter, document.target.path]
          .filter(Boolean)
          .join(" ");
  return {
    command: [base, ...document.arguments.map(quoteArgument)]
      .filter(Boolean)
      .join(" "),
    overridden: document.commandOverride !== null,
  };
}

export function nodeRunConfigurationEffectiveCommand(
  document: RunConfigurationNodeDocument,
): { command: string; overridden: boolean } {
  if (document.commandOverride !== null) {
    return {
      command: [
        document.commandOverride,
        ...document.arguments.map(quoteArgument),
      ].join(" "),
      overridden: true,
    };
  }
  if (document.target.kind === "packageScript") {
    return {
      command: [
        document.options.packageManager,
        "run",
        quoteArgument(document.target.script),
        ...(document.arguments.length
          ? ["--", ...document.arguments.map(quoteArgument)]
          : []),
      ].join(" "),
      overridden: false,
    };
  }
  return {
    command: [
      document.options.runtime,
      ...document.options.runtimeArguments.map(quoteArgument),
      quoteArgument(document.target.path),
      ...document.arguments.map(quoteArgument),
    ].join(" "),
    overridden: false,
  };
}

export function runConfigurationEffectiveCommand(
  document: RunConfigurationFile,
): { command: string; overridden: boolean } {
  return document.provider === "node"
    ? nodeRunConfigurationEffectiveCommand(document)
    : shellRunConfigurationEffectiveCommand(document);
}

export function parseRunConfigurationEditorDocument(
  document: RunConfigurationFile,
  platformOverrides: string,
) {
  let parsedOverrides: unknown;
  try {
    parsedOverrides = JSON.parse(platformOverrides || "{}");
  } catch {
    return {
      success: false as const,
      errors: ["Platform overrides must be valid JSON."],
    };
  }
  const parsed = runConfigurationFileSchema.safeParse({
    ...document,
    platformOverrides: parsedOverrides,
  });
  if (!parsed.success) {
    return {
      success: false as const,
      errors: parsed.error.issues.map(
        ({ message, path }) =>
          `${path.length ? `${path.join(".")}: ` : ""}${message}`,
      ),
    };
  }
  return { success: true as const, document: parsed.data };
}

export function parseShellRunConfigurationEditorDocument(
  document: RunConfigurationShellDocument,
  platformOverrides: string,
) {
  return parseRunConfigurationEditorDocument(document, platformOverrides);
}
