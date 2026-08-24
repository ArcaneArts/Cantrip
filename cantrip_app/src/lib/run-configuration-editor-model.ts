import {
  RUN_CONFIGURATION_FILE_SCHEMA,
  RUN_CONFIGURATION_FILE_VERSION,
  runConfigurationFileSchema,
  type RunConfigurationDartDocument,
  type RunConfigurationFile,
  type RunConfigurationJavaDocument,
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

export function createJavaRunConfigurationDocument(
  id = crypto.randomUUID(),
): RunConfigurationJavaDocument {
  return {
    ...commonDocument(id),
    provider: "java",
    target: { kind: "gradleTask", projectPath: ":", task: "run" },
    options: {
      jdkHome: null,
      useWrapper: true,
      buildToolArguments: [],
      vmArguments: [],
    },
  };
}

export function createDartRunConfigurationDocument(
  id = crypto.randomUUID(),
): RunConfigurationDartDocument {
  return {
    ...commonDocument(id),
    provider: "dart",
    target: { kind: "entrypoint", path: "bin/main.dart" },
    options: { sdkHome: null, vmArguments: [] },
  };
}

export function createRunConfigurationDocument(
  provider: Extract<
    RunConfigurationProviderKind,
    "dart" | "java" | "node" | "shell"
  >,
  id = crypto.randomUUID(),
): RunConfigurationFile {
  if (provider === "node") return createNodeRunConfigurationDocument(id);
  if (provider === "java") return createJavaRunConfigurationDocument(id);
  if (provider === "dart") return createDartRunConfigurationDocument(id);
  return createShellRunConfigurationDocument(id);
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

function qualifiedGradleTask(projectPath: string, task: string): string {
  if (task.startsWith(":")) return task;
  return projectPath === ":" ? task : `${projectPath}:${task}`;
}

function javaBuildTool(document: RunConfigurationJavaDocument): string {
  const gradle = document.target.kind.startsWith("gradle");
  if (!document.options.useWrapper) return gradle ? "gradle" : "mvn";
  return gradle ? "./gradlew" : "./mvnw";
}

function joinedArguments(values: string[]): string {
  return values.map(quoteArgument).join(" ");
}

export function javaRunConfigurationEffectiveCommand(
  document: RunConfigurationJavaDocument,
): { command: string; overridden: boolean } {
  if (document.commandOverride !== null) {
    const environment = [
      ...(document.options.jdkHome
        ? [`JAVA_HOME=${quoteArgument(document.options.jdkHome)}`]
        : []),
      ...(document.options.vmArguments.length
        ? [
            `JAVA_TOOL_OPTIONS=${quoteArgument(
              joinedArguments(document.options.vmArguments),
            )}`,
          ]
        : []),
    ];
    return {
      command: [
        ...environment,
        document.commandOverride,
        ...document.arguments.map(quoteArgument),
      ].join(" "),
      overridden: true,
    };
  }
  const tool = javaBuildTool(document);
  const buildArguments = document.options.buildToolArguments.map(quoteArgument);
  let targetArguments: string[];
  switch (document.target.kind) {
    case "gradleTask":
      targetArguments = [
        qualifiedGradleTask(document.target.projectPath, document.target.task),
        ...(document.arguments.length &&
        (document.target.task === "run" || document.target.task === "bootRun")
          ? [`--args=${quoteArgument(joinedArguments(document.arguments))}`]
          : document.arguments.map(quoteArgument)),
      ];
      break;
    case "gradleMainClass":
      targetArguments = [
        "--init-script",
        "<cantrip-java-init.gradle>",
        `-PcantripMainClass=${document.target.className}`,
        qualifiedGradleTask(
          document.target.projectPath,
          "_cantripRunConfigurationJava",
        ),
        ...(document.options.vmArguments.length
          ? [`--vm-options=${joinedArguments(document.options.vmArguments)}`]
          : []),
        ...(document.arguments.length
          ? ["--", ...document.arguments.map(quoteArgument)]
          : []),
      ];
      break;
    case "mavenGoal":
      targetArguments = [
        ...(document.target.module
          ? ["-pl", quoteArgument(document.target.module), "-am"]
          : []),
        document.target.goal,
        ...(document.arguments.length
          ? [
              document.target.goal === "spring-boot:run"
                ? `-Dspring-boot.run.arguments=${quoteArgument(joinedArguments(document.arguments))}`
                : document.target.goal.endsWith("exec:java")
                  ? `-Dexec.args=${quoteArgument(joinedArguments(document.arguments))}`
                  : joinedArguments(document.arguments),
            ]
          : []),
      ];
      break;
    case "mavenMainClass":
      targetArguments = [
        ...(document.target.module
          ? ["-pl", quoteArgument(document.target.module), "-am"]
          : []),
        "org.codehaus.mojo:exec-maven-plugin:3.5.1:java",
        `-Dexec.mainClass=${document.target.className}`,
        ...(document.arguments.length
          ? [
              `-Dexec.args=${quoteArgument(joinedArguments(document.arguments))}`,
            ]
          : []),
      ];
      break;
  }
  const command = [tool, ...buildArguments, ...targetArguments].join(" ");
  const environment = [
    ...(document.options.jdkHome
      ? [`JAVA_HOME=${quoteArgument(document.options.jdkHome)}`]
      : []),
    ...(document.options.vmArguments.length &&
    document.target.kind !== "gradleMainClass"
      ? [
          `JAVA_TOOL_OPTIONS=${quoteArgument(
            joinedArguments(document.options.vmArguments),
          )}`,
        ]
      : []),
  ];
  return {
    command: [...environment, command].join(" "),
    overridden: false,
  };
}

export function dartRunConfigurationEffectiveCommand(
  document: RunConfigurationDartDocument,
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
  const executable = document.options.sdkHome
    ? `${document.options.sdkHome.replace(/[\\/]+$/u, "")}/bin/dart`
    : "dart";
  return {
    command: [
      quoteArgument(executable),
      "run",
      ...document.options.vmArguments.map(quoteArgument),
      quoteArgument(document.target.path),
      ...document.arguments.map(quoteArgument),
    ].join(" "),
    overridden: false,
  };
}

export function runConfigurationEffectiveCommand(
  document: RunConfigurationFile,
): { command: string; overridden: boolean } {
  if (document.provider === "node") {
    return nodeRunConfigurationEffectiveCommand(document);
  }
  if (document.provider === "java") {
    return javaRunConfigurationEffectiveCommand(document);
  }
  if (document.provider === "dart") {
    return dartRunConfigurationEffectiveCommand(document);
  }
  return shellRunConfigurationEffectiveCommand(document);
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
