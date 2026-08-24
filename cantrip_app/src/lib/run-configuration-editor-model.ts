import {
  RUN_CONFIGURATION_FILE_SCHEMA,
  RUN_CONFIGURATION_FILE_VERSION,
  runConfigurationShellDocumentSchema,
  type RunConfigurationShellDocument,
} from "@cantrip/protocol/run-configuration-definitions";

export function createShellRunConfigurationDocument(
  id = crypto.randomUUID(),
): RunConfigurationShellDocument {
  return {
    schema: RUN_CONFIGURATION_FILE_SCHEMA,
    version: RUN_CONFIGURATION_FILE_VERSION,
    id,
    name: "",
    provider: "shell",
    workingDirectory: ".",
    target: { kind: "command", command: "" },
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
    options: { shell: "automatic", login: true },
    stop: { gracePeriodMs: 3_000 },
  };
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

export function parseShellRunConfigurationEditorDocument(
  document: RunConfigurationShellDocument,
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
  const parsed = runConfigurationShellDocumentSchema.safeParse({
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
