import {
  RUN_CONFIGURATION_FILE_SCHEMA,
  RUN_CONFIGURATION_FILE_VERSION,
  runConfigurationFileSchema,
  type RunConfigurationDetectionCandidate,
  type RunConfigurationDartDocument,
  type RunConfigurationFile,
  type RunConfigurationFlutterDocument,
  type RunConfigurationJavaDocument,
  type RunConfigurationNodeDocument,
  type RunConfigurationProviderKind,
  type RunConfigurationRustDocument,
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

export function createFlutterRunConfigurationDocument(
  id = crypto.randomUUID(),
): RunConfigurationFlutterDocument {
  return {
    ...commonDocument(id),
    provider: "flutter",
    target: { kind: "entrypoint", path: "lib/main.dart" },
    options: {
      sdkHome: null,
      deviceId: null,
      flavor: null,
      mode: "debug",
      dartDefines: [],
      dartDefineFiles: [],
      usePub: true,
    },
  };
}

export function createRustRunConfigurationDocument(
  id = crypto.randomUUID(),
): RunConfigurationRustDocument {
  return {
    ...commonDocument(id),
    provider: "rust",
    target: { kind: "binary", package: "app", name: "app" },
    options: {
      toolchain: "default",
      features: [],
      allFeatures: false,
      useDefaultFeatures: true,
      targetTriple: null,
      profile: "dev",
      locked: false,
      offline: false,
    },
  };
}

export function createRunConfigurationDocument(
  provider: Extract<
    RunConfigurationProviderKind,
    "dart" | "flutter" | "java" | "node" | "rust" | "shell"
  >,
  id = crypto.randomUUID(),
): RunConfigurationFile {
  if (provider === "node") return createNodeRunConfigurationDocument(id);
  if (provider === "java") return createJavaRunConfigurationDocument(id);
  if (provider === "dart") return createDartRunConfigurationDocument(id);
  if (provider === "flutter") return createFlutterRunConfigurationDocument(id);
  if (provider === "rust") return createRustRunConfigurationDocument(id);
  return createShellRunConfigurationDocument(id);
}

export function runConfigurationTargetLabel(
  document: RunConfigurationFile,
): string {
  if (document.provider === "shell") {
    return document.target.kind === "command"
      ? document.target.command
      : document.target.path;
  }
  if (document.provider === "node") {
    return document.target.kind === "packageScript"
      ? `Package script: ${document.target.script}`
      : `Entrypoint: ${document.target.path}`;
  }
  if (document.provider === "java") {
    switch (document.target.kind) {
      case "gradleTask":
        return `Gradle ${document.target.projectPath} · ${document.target.task}`;
      case "gradleMainClass":
        return `Gradle ${document.target.projectPath} · ${document.target.className}`;
      case "mavenGoal":
        return `Maven ${document.target.module ?? "root"} · ${document.target.goal}`;
      case "mavenMainClass":
        return `Maven ${document.target.module ?? "root"} · ${document.target.className}`;
    }
  }
  if (document.provider === "dart") {
    return `Dart entrypoint: ${document.target.path}`;
  }
  if (document.provider === "flutter") {
    return `Flutter entrypoint: ${document.target.path}`;
  }
  return `Cargo ${document.target.package} · ${document.target.kind} ${document.target.name}`;
}

export function applyRunConfigurationDetectionCandidate(
  current: RunConfigurationFile,
  candidate: RunConfigurationDetectionCandidate,
): RunConfigurationFile {
  const detected = candidate.document;
  if (
    candidate.provider !== current.provider ||
    detected.provider !== current.provider
  ) {
    return current;
  }

  if (current.provider === "shell" && detected.provider === "shell") {
    return {
      ...current,
      workingDirectory: detected.workingDirectory,
      target: detected.target,
    };
  }
  if (current.provider === "node" && detected.provider === "node") {
    return {
      ...current,
      workingDirectory: detected.workingDirectory,
      target: detected.target,
      options: {
        ...current.options,
        packageManager: detected.options.packageManager,
        runtime: detected.options.runtime,
      },
    };
  }
  if (current.provider === "java" && detected.provider === "java") {
    return {
      ...current,
      workingDirectory: detected.workingDirectory,
      target: detected.target,
      options: {
        ...current.options,
        useWrapper: detected.options.useWrapper,
      },
    };
  }
  if (current.provider === "dart" && detected.provider === "dart") {
    return {
      ...current,
      workingDirectory: detected.workingDirectory,
      target: detected.target,
    };
  }
  if (current.provider === "flutter" && detected.provider === "flutter") {
    return {
      ...current,
      workingDirectory: detected.workingDirectory,
      target: detected.target,
      options: {
        ...current.options,
        flavor: current.options.flavor ?? detected.options.flavor,
      },
    };
  }
  if (current.provider === "rust" && detected.provider === "rust") {
    return {
      ...current,
      workingDirectory: detected.workingDirectory,
      target: detected.target,
      options: {
        ...current.options,
        features: [
          ...new Set([
            ...detected.options.features,
            ...current.options.features,
          ]),
        ],
      },
    };
  }
  return current;
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

export function flutterRunConfigurationEffectiveCommand(
  document: RunConfigurationFlutterDocument,
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
    ? `${document.options.sdkHome.replace(/[\\/]+$/u, "")}/bin/flutter`
    : "flutter";
  return {
    command: [
      quoteArgument(executable),
      "run",
      `--${document.options.mode}`,
      quoteArgument(`--target=${document.target.path}`),
      ...(document.options.deviceId
        ? [quoteArgument(`--device-id=${document.options.deviceId}`)]
        : []),
      ...(document.options.flavor
        ? [quoteArgument(`--flavor=${document.options.flavor}`)]
        : []),
      ...document.options.dartDefines.map(({ name, value }) =>
        quoteArgument(`--dart-define=${name}=${value}`),
      ),
      ...document.options.dartDefineFiles.map((file) =>
        quoteArgument(`--dart-define-from-file=${file}`),
      ),
      document.options.usePub ? "--pub" : "--no-pub",
      ...document.arguments.map((argument) =>
        quoteArgument(`--dart-entrypoint-args=${argument}`),
      ),
    ].join(" "),
    overridden: false,
  };
}

export function rustRunConfigurationEffectiveCommand(
  document: RunConfigurationRustDocument,
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
  return {
    command: [
      "cargo",
      ...(document.options.toolchain === "default"
        ? []
        : [`+${document.options.toolchain}`]),
      "run",
      `--package=${quoteArgument(document.target.package)}`,
      document.target.kind === "binary"
        ? `--bin=${quoteArgument(document.target.name)}`
        : `--example=${quoteArgument(document.target.name)}`,
      ...(document.options.allFeatures
        ? ["--all-features"]
        : document.options.features.map(
            (feature) => `--features=${quoteArgument(feature)}`,
          )),
      ...(!document.options.useDefaultFeatures
        ? ["--no-default-features"]
        : []),
      ...(document.options.targetTriple
        ? [`--target=${quoteArgument(document.options.targetTriple)}`]
        : []),
      ...(document.options.profile === "dev"
        ? []
        : document.options.profile === "release"
          ? ["--release"]
          : [`--profile=${quoteArgument(document.options.profile)}`]),
      ...(document.options.locked ? ["--locked"] : []),
      ...(document.options.offline ? ["--offline"] : []),
      ...(document.arguments.length
        ? ["--", ...document.arguments.map(quoteArgument)]
        : []),
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
  if (document.provider === "flutter") {
    return flutterRunConfigurationEffectiveCommand(document);
  }
  if (document.provider === "rust") {
    return rustRunConfigurationEffectiveCommand(document);
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
