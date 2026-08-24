import { z } from "zod";

export const RUN_CONFIGURATION_REPOSITORY_DIRECTORY =
  ".cantrip/run-configurations" as const;
export const RUN_CONFIGURATION_FILE_SCHEMA =
  "cantrip.run-configuration" as const;
export const RUN_CONFIGURATION_FILE_VERSION = 1 as const;
export const RUN_CONFIGURATION_MAX_FILES = 128 as const;
export const RUN_CONFIGURATION_MAX_FILE_BYTES = 512 * 1024;
export const RUN_CONFIGURATION_MAX_DIAGNOSTICS = 200 as const;

const MAX_COMMAND_CHARACTERS = 100_000;
const MAX_ARGUMENT_CHARACTERS = 16_384;
const MAX_ENVIRONMENT_VALUE_CHARACTERS = 16_384;

export const runConfigurationIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    "Expected a lowercase RFC 9562 UUID.",
  );

export const runConfigurationRevisionSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "Expected a SHA-256 revision.");

export const runConfigurationProviderKindSchema = z.enum([
  "shell",
  "node",
  "java",
  "dart",
  "flutter",
  "rust",
]);

export const runConfigurationPlatformSchema = z.enum([
  "win32",
  "darwin",
  "linux",
]);

function isPortableRepositoryPath(value: string, allowRoot: boolean): boolean {
  if (
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[a-zA-Z]:/u.test(value)
  ) {
    return false;
  }
  if (value === ".") return allowRoot;
  return value
    .split("/")
    .every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );
}

export const runConfigurationWorkingDirectorySchema = z
  .string()
  .max(512)
  .refine(
    (value) => isPortableRepositoryPath(value, true),
    "Expected a normalized repository-relative directory.",
  );

export const runConfigurationRepositoryPathSchema = z
  .string()
  .max(512)
  .refine(
    (value) => isPortableRepositoryPath(value, false),
    "Expected a normalized repository-relative path.",
  );

const noNulString = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => !value.includes("\0"), {
      message: "Values cannot contain NUL characters.",
    });

export const runConfigurationCommandSchema = noNulString(
  MAX_COMMAND_CHARACTERS,
).refine((value) => value.trim().length > 0, {
  message: "Commands cannot be blank.",
});

export const runConfigurationArgumentSchema = noNulString(
  MAX_ARGUMENT_CHARACTERS,
);

export const runConfigurationEnvironmentNameSchema = z
  .string()
  .max(256)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/u,
    "Environment names must be portable shell identifiers.",
  );

export const runConfigurationSecretReferenceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u,
    "Secret references may contain letters, digits, dots, underscores, slashes, and hyphens.",
  )
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      value
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        ),
    "Secret references must be normalized relative names.",
  );

export const runConfigurationEnvironmentVariableSchema = z
  .object({
    name: runConfigurationEnvironmentNameSchema,
    value: noNulString(MAX_ENVIRONMENT_VALUE_CHARACTERS),
    enabled: z.boolean().default(true),
  })
  .strict();

export const runConfigurationEnvironmentSecretSchema = z
  .object({
    name: runConfigurationEnvironmentNameSchema,
    secret: runConfigurationSecretReferenceSchema,
    enabled: z.boolean().default(true),
  })
  .strict();

function addDuplicateEnvironmentIssues(
  environment: {
    variables?: Array<{ name: string }>;
    secrets?: Array<{ name: string }>;
  },
  context: z.RefinementCtx,
): void {
  const names = new Map<string, ["variables" | "secrets", number]>();
  for (const [collection, values] of [
    ["variables", environment.variables ?? []],
    ["secrets", environment.secrets ?? []],
  ] as const) {
    values.forEach((value, index) => {
      const normalized = value.name.toLowerCase();
      if (names.has(normalized)) {
        context.addIssue({
          code: "custom",
          message: "Environment name " + value.name + " is already declared.",
          path: [collection, index, "name"],
        });
      } else {
        names.set(normalized, [collection, index]);
      }
    });
  }
}

export const runConfigurationEnvironmentSchema = z
  .object({
    includeCodexEnvironment: z.boolean().default(true),
    files: z.array(runConfigurationRepositoryPathSchema).max(32).default([]),
    variables: z
      .array(runConfigurationEnvironmentVariableSchema)
      .max(256)
      .default([]),
    secrets: z
      .array(runConfigurationEnvironmentSecretSchema)
      .max(256)
      .default([]),
  })
  .strict()
  .superRefine(addDuplicateEnvironmentIssues);

const runConfigurationEnvironmentOverrideSchema = z
  .object({
    includeCodexEnvironment: z.boolean().optional(),
    files: z.array(runConfigurationRepositoryPathSchema).max(32).optional(),
    variables: z
      .array(runConfigurationEnvironmentVariableSchema)
      .max(256)
      .optional(),
    secrets: z
      .array(runConfigurationEnvironmentSecretSchema)
      .max(256)
      .optional(),
  })
  .strict()
  .superRefine(addDuplicateEnvironmentIssues);

export const runConfigurationBeforeLaunchStepSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("command"),
        command: runConfigurationCommandSchema,
        workingDirectory: runConfigurationWorkingDirectorySchema.default("."),
      })
      .strict(),
    z
      .object({
        kind: z.literal("providerTask"),
        task: z.string().trim().min(1).max(200),
      })
      .strict(),
  ],
);

export const runConfigurationStopSchema = z
  .object({
    gracePeriodMs: z.number().int().min(0).max(60_000).default(3_000),
  })
  .strict();

export const runConfigurationShellKindSchema = z.enum([
  "automatic",
  "powershell",
  "cmd",
  "sh",
  "bash",
  "zsh",
]);

export const runConfigurationShellTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("command"),
      command: runConfigurationCommandSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("script"),
      path: runConfigurationRepositoryPathSchema,
      interpreter: noNulString(512)
        .refine((value) => value.trim().length > 0, {
          message: "Interpreters cannot be blank.",
        })
        .nullable()
        .default(null),
    })
    .strict(),
]);

export const runConfigurationShellOptionsSchema = z
  .object({
    shell: runConfigurationShellKindSchema.default("automatic"),
    login: z.boolean().default(true),
  })
  .strict();

const runConfigurationArgumentsSchema = z
  .array(runConfigurationArgumentSchema)
  .max(256);

const runConfigurationShellPlatformOverrideSchema = z
  .object({
    workingDirectory: runConfigurationWorkingDirectorySchema.optional(),
    commandOverride: runConfigurationCommandSchema.nullable().optional(),
    arguments: runConfigurationArgumentsSchema.optional(),
    environment: runConfigurationEnvironmentOverrideSchema.optional(),
    options: z
      .object({
        shell: runConfigurationShellKindSchema.optional(),
        login: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const runConfigurationShellPlatformOverridesSchema = z
  .object({
    win32: runConfigurationShellPlatformOverrideSchema.optional(),
    darwin: runConfigurationShellPlatformOverrideSchema.optional(),
    linux: runConfigurationShellPlatformOverrideSchema.optional(),
  })
  .strict();

export const runConfigurationShellDocumentSchema = z
  .object({
    schema: z.literal(RUN_CONFIGURATION_FILE_SCHEMA),
    version: z.literal(RUN_CONFIGURATION_FILE_VERSION),
    id: runConfigurationIdSchema,
    name: z.string().trim().min(1).max(200),
    provider: z.literal("shell"),
    workingDirectory: runConfigurationWorkingDirectorySchema.default("."),
    target: runConfigurationShellTargetSchema,
    commandOverride: runConfigurationCommandSchema.nullable().default(null),
    arguments: runConfigurationArgumentsSchema.default([]),
    environment: runConfigurationEnvironmentSchema.default({
      includeCodexEnvironment: true,
      files: [],
      variables: [],
      secrets: [],
    }),
    beforeLaunch: z
      .array(runConfigurationBeforeLaunchStepSchema)
      .max(32)
      .default([]),
    platformOverrides: runConfigurationShellPlatformOverridesSchema.default({}),
    options: runConfigurationShellOptionsSchema.default({
      shell: "automatic",
      login: true,
    }),
    stop: runConfigurationStopSchema.default({ gracePeriodMs: 3_000 }),
  })
  .strict()
  .superRefine((document, context) => {
    const bytes = new TextEncoder().encode(JSON.stringify(document)).byteLength;
    if (bytes > RUN_CONFIGURATION_MAX_FILE_BYTES) {
      context.addIssue({
        code: "custom",
        message:
          "Run configuration documents cannot exceed " +
          RUN_CONFIGURATION_MAX_FILE_BYTES +
          " encoded bytes.",
      });
    }
  });

export const runConfigurationNodePackageManagerSchema = z.enum([
  "npm",
  "pnpm",
  "yarn",
  "bun",
]);

export const runConfigurationNodeRuntimeSchema = z.enum(["node", "bun"]);

export const runConfigurationNodeTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("packageScript"),
      script: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("entry"),
      path: runConfigurationRepositoryPathSchema,
    })
    .strict(),
]);

export const runConfigurationNodeOptionsSchema = z
  .object({
    packageManager: runConfigurationNodePackageManagerSchema.default("npm"),
    runtime: runConfigurationNodeRuntimeSchema.default("node"),
    runtimeArguments: runConfigurationArgumentsSchema.max(128).default([]),
  })
  .strict();

const runConfigurationNodePlatformOverrideSchema = z
  .object({
    workingDirectory: runConfigurationWorkingDirectorySchema.optional(),
    commandOverride: runConfigurationCommandSchema.nullable().optional(),
    arguments: runConfigurationArgumentsSchema.optional(),
    environment: runConfigurationEnvironmentOverrideSchema.optional(),
    options: z
      .object({
        packageManager: runConfigurationNodePackageManagerSchema.optional(),
        runtime: runConfigurationNodeRuntimeSchema.optional(),
        runtimeArguments: runConfigurationArgumentsSchema.max(128).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const runConfigurationNodePlatformOverridesSchema = z
  .object({
    win32: runConfigurationNodePlatformOverrideSchema.optional(),
    darwin: runConfigurationNodePlatformOverrideSchema.optional(),
    linux: runConfigurationNodePlatformOverrideSchema.optional(),
  })
  .strict();

export const runConfigurationNodeDocumentSchema = z
  .object({
    schema: z.literal(RUN_CONFIGURATION_FILE_SCHEMA),
    version: z.literal(RUN_CONFIGURATION_FILE_VERSION),
    id: runConfigurationIdSchema,
    name: z.string().trim().min(1).max(200),
    provider: z.literal("node"),
    workingDirectory: runConfigurationWorkingDirectorySchema.default("."),
    target: runConfigurationNodeTargetSchema,
    commandOverride: runConfigurationCommandSchema.nullable().default(null),
    arguments: runConfigurationArgumentsSchema.default([]),
    environment: runConfigurationEnvironmentSchema.default({
      includeCodexEnvironment: true,
      files: [],
      variables: [],
      secrets: [],
    }),
    beforeLaunch: z
      .array(runConfigurationBeforeLaunchStepSchema)
      .max(32)
      .default([]),
    platformOverrides: runConfigurationNodePlatformOverridesSchema.default({}),
    options: runConfigurationNodeOptionsSchema.default({
      packageManager: "npm",
      runtime: "node",
      runtimeArguments: [],
    }),
    stop: runConfigurationStopSchema.default({ gracePeriodMs: 3_000 }),
  })
  .strict()
  .superRefine((document, context) => {
    const bytes = new TextEncoder().encode(JSON.stringify(document)).byteLength;
    if (bytes > RUN_CONFIGURATION_MAX_FILE_BYTES) {
      context.addIssue({
        code: "custom",
        message:
          "Run configuration documents cannot exceed " +
          RUN_CONFIGURATION_MAX_FILE_BYTES +
          " encoded bytes.",
      });
    }
  });

export const runConfigurationJavaBuildSystemSchema = z.enum([
  "gradle",
  "maven",
]);

export const runConfigurationJavaClassNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(
    /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u,
    "Expected a fully qualified Java class name.",
  );

export const runConfigurationGradleProjectPathSchema = z
  .string()
  .trim()
  .max(512)
  .regex(
    /^:(?:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*)?$/u,
    "Expected a Gradle project path such as : or :app.",
  );

const runConfigurationBuildTaskSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(
    /^:?[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*$/u,
    "Expected a build-tool task or goal without command-line options.",
  );

export const runConfigurationMavenModuleSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(
    /^(?!-)(?::?[A-Za-z0-9_.+@-]+(?::[A-Za-z0-9_.+@-]+)*|[A-Za-z0-9_.+@-]+(?:\/[A-Za-z0-9_.+@-]+)*)$/u,
    "Expected a Maven module selector or normalized relative module path.",
  );

export const runConfigurationJavaTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("gradleTask"),
      projectPath: runConfigurationGradleProjectPathSchema.default(":"),
      task: runConfigurationBuildTaskSchema.default("run"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("gradleMainClass"),
      projectPath: runConfigurationGradleProjectPathSchema.default(":"),
      className: runConfigurationJavaClassNameSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("mavenGoal"),
      module: runConfigurationMavenModuleSchema.nullable().default(null),
      goal: runConfigurationBuildTaskSchema.default("spring-boot:run"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("mavenMainClass"),
      module: runConfigurationMavenModuleSchema.nullable().default(null),
      className: runConfigurationJavaClassNameSchema,
    })
    .strict(),
]);

const runConfigurationJdkHomeSchema = noNulString(1_024)
  .trim()
  .min(1)
  .nullable();

export const runConfigurationJavaOptionsSchema = z
  .object({
    jdkHome: runConfigurationJdkHomeSchema.default(null),
    useWrapper: z.boolean().default(true),
    buildToolArguments: runConfigurationArgumentsSchema.max(128).default([]),
    vmArguments: runConfigurationArgumentsSchema.max(128).default([]),
  })
  .strict();

const runConfigurationJavaPlatformOverrideSchema = z
  .object({
    workingDirectory: runConfigurationWorkingDirectorySchema.optional(),
    commandOverride: runConfigurationCommandSchema.nullable().optional(),
    arguments: runConfigurationArgumentsSchema.optional(),
    environment: runConfigurationEnvironmentOverrideSchema.optional(),
    options: z
      .object({
        jdkHome: runConfigurationJdkHomeSchema.optional(),
        useWrapper: z.boolean().optional(),
        buildToolArguments: runConfigurationArgumentsSchema.max(128).optional(),
        vmArguments: runConfigurationArgumentsSchema.max(128).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const runConfigurationJavaPlatformOverridesSchema = z
  .object({
    win32: runConfigurationJavaPlatformOverrideSchema.optional(),
    darwin: runConfigurationJavaPlatformOverrideSchema.optional(),
    linux: runConfigurationJavaPlatformOverrideSchema.optional(),
  })
  .strict();

export const runConfigurationJavaDocumentSchema = z
  .object({
    schema: z.literal(RUN_CONFIGURATION_FILE_SCHEMA),
    version: z.literal(RUN_CONFIGURATION_FILE_VERSION),
    id: runConfigurationIdSchema,
    name: z.string().trim().min(1).max(200),
    provider: z.literal("java"),
    workingDirectory: runConfigurationWorkingDirectorySchema.default("."),
    target: runConfigurationJavaTargetSchema,
    commandOverride: runConfigurationCommandSchema.nullable().default(null),
    arguments: runConfigurationArgumentsSchema.default([]),
    environment: runConfigurationEnvironmentSchema.default({
      includeCodexEnvironment: true,
      files: [],
      variables: [],
      secrets: [],
    }),
    beforeLaunch: z
      .array(runConfigurationBeforeLaunchStepSchema)
      .max(32)
      .default([]),
    platformOverrides: runConfigurationJavaPlatformOverridesSchema.default({}),
    options: runConfigurationJavaOptionsSchema.default({
      jdkHome: null,
      useWrapper: true,
      buildToolArguments: [],
      vmArguments: [],
    }),
    stop: runConfigurationStopSchema.default({ gracePeriodMs: 3_000 }),
  })
  .strict()
  .superRefine((document, context) => {
    const bytes = new TextEncoder().encode(JSON.stringify(document)).byteLength;
    if (bytes > RUN_CONFIGURATION_MAX_FILE_BYTES) {
      context.addIssue({
        code: "custom",
        message:
          "Run configuration documents cannot exceed " +
          RUN_CONFIGURATION_MAX_FILE_BYTES +
          " encoded bytes.",
      });
    }
  });

export const runConfigurationDartEntrypointSchema =
  runConfigurationRepositoryPathSchema.refine(
    (value) => value.endsWith(".dart"),
    "Expected a repository-relative Dart entrypoint path.",
  );

export const runConfigurationDartTargetSchema = z
  .object({
    kind: z.literal("entrypoint"),
    path: runConfigurationDartEntrypointSchema,
  })
  .strict();

const runConfigurationDartSdkHomeSchema = noNulString(1_024)
  .trim()
  .min(1)
  .nullable();

export const runConfigurationDartOptionsSchema = z
  .object({
    sdkHome: runConfigurationDartSdkHomeSchema.default(null),
    vmArguments: runConfigurationArgumentsSchema.max(128).default([]),
  })
  .strict();

const runConfigurationDartPlatformOverrideSchema = z
  .object({
    workingDirectory: runConfigurationWorkingDirectorySchema.optional(),
    commandOverride: runConfigurationCommandSchema.nullable().optional(),
    arguments: runConfigurationArgumentsSchema.optional(),
    environment: runConfigurationEnvironmentOverrideSchema.optional(),
    options: z
      .object({
        sdkHome: runConfigurationDartSdkHomeSchema.optional(),
        vmArguments: runConfigurationArgumentsSchema.max(128).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const runConfigurationDartPlatformOverridesSchema = z
  .object({
    win32: runConfigurationDartPlatformOverrideSchema.optional(),
    darwin: runConfigurationDartPlatformOverrideSchema.optional(),
    linux: runConfigurationDartPlatformOverrideSchema.optional(),
  })
  .strict();

export const runConfigurationDartDocumentSchema = z
  .object({
    schema: z.literal(RUN_CONFIGURATION_FILE_SCHEMA),
    version: z.literal(RUN_CONFIGURATION_FILE_VERSION),
    id: runConfigurationIdSchema,
    name: z.string().trim().min(1).max(200),
    provider: z.literal("dart"),
    workingDirectory: runConfigurationWorkingDirectorySchema.default("."),
    target: runConfigurationDartTargetSchema,
    commandOverride: runConfigurationCommandSchema.nullable().default(null),
    arguments: runConfigurationArgumentsSchema.default([]),
    environment: runConfigurationEnvironmentSchema.default({
      includeCodexEnvironment: true,
      files: [],
      variables: [],
      secrets: [],
    }),
    beforeLaunch: z
      .array(runConfigurationBeforeLaunchStepSchema)
      .max(32)
      .default([]),
    platformOverrides: runConfigurationDartPlatformOverridesSchema.default({}),
    options: runConfigurationDartOptionsSchema.default({
      sdkHome: null,
      vmArguments: [],
    }),
    stop: runConfigurationStopSchema.default({ gracePeriodMs: 3_000 }),
  })
  .strict()
  .superRefine((document, context) => {
    const bytes = new TextEncoder().encode(JSON.stringify(document)).byteLength;
    if (bytes > RUN_CONFIGURATION_MAX_FILE_BYTES) {
      context.addIssue({
        code: "custom",
        message:
          "Run configuration documents cannot exceed " +
          RUN_CONFIGURATION_MAX_FILE_BYTES +
          " encoded bytes.",
      });
    }
  });

export const runConfigurationFileSchema = z.discriminatedUnion("provider", [
  runConfigurationShellDocumentSchema,
  runConfigurationNodeDocumentSchema,
  runConfigurationJavaDocumentSchema,
  runConfigurationDartDocumentSchema,
]);

export const runConfigurationDiagnosticSchema = z
  .object({
    severity: z.enum(["error", "warning"]),
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(2_000),
    relativePath: z.string().min(1).max(512).nullable().default(null),
    field: z.string().min(1).max(512).nullable().default(null),
  })
  .strict();

export const runConfigurationRepositoryEntryStatusSchema = z.enum([
  "ready",
  "invalid",
  "unsupported",
]);

export const runConfigurationRepositoryEntrySchema = z
  .object({
    relativePath: z.string().min(1).max(512),
    revision: runConfigurationRevisionSchema.nullable(),
    id: runConfigurationIdSchema.nullable(),
    status: runConfigurationRepositoryEntryStatusSchema,
    document: runConfigurationFileSchema.nullable(),
    diagnostics: z
      .array(runConfigurationDiagnosticSchema)
      .max(RUN_CONFIGURATION_MAX_DIAGNOSTICS),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.status === "ready" && (!entry.document || !entry.revision)) {
      context.addIssue({
        code: "custom",
        message: "Ready entries require a document and revision.",
      });
    }
    if (entry.status !== "ready" && entry.diagnostics.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Non-ready entries require at least one diagnostic.",
        path: ["diagnostics"],
      });
    }
    if (entry.document && entry.id !== entry.document.id) {
      context.addIssue({
        code: "custom",
        message: "Entry identity must match its document.",
        path: ["id"],
      });
    }
  });

export const runConfigurationRepositoryInventorySchema = z
  .object({
    directory: z.literal(RUN_CONFIGURATION_REPOSITORY_DIRECTORY),
    entries: z
      .array(runConfigurationRepositoryEntrySchema)
      .max(RUN_CONFIGURATION_MAX_FILES),
    diagnostics: z
      .array(runConfigurationDiagnosticSchema)
      .max(RUN_CONFIGURATION_MAX_DIAGNOSTICS),
  })
  .strict();

export const runConfigurationReadResultSchema = z.discriminatedUnion("found", [
  z
    .object({
      found: z.literal(false),
      id: runConfigurationIdSchema,
    })
    .strict(),
  z
    .object({
      found: z.literal(true),
      entry: runConfigurationRepositoryEntrySchema,
    })
    .strict(),
]);

export const runConfigurationWriteRequestSchema = z
  .object({
    expectedRevision: runConfigurationRevisionSchema.nullable(),
    document: runConfigurationFileSchema,
  })
  .strict();

const runConfigurationWriteSuccessSchema = z
  .object({
    outcome: z.enum(["created", "updated", "unchanged"]),
    entry: runConfigurationRepositoryEntrySchema.refine(
      (entry) => entry.status === "ready",
      "Successful writes require a ready repository entry.",
    ),
  })
  .strict();

const runConfigurationWriteFailureSchema = z
  .object({
    outcome: z.enum([
      "already-exists",
      "not-found",
      "revision-mismatch",
      "name-conflict",
    ]),
    id: runConfigurationIdSchema,
    currentRevision: runConfigurationRevisionSchema.nullable(),
    conflictingId: runConfigurationIdSchema.nullable().default(null),
  })
  .strict();

export const runConfigurationWriteResultSchema = z.union([
  runConfigurationWriteSuccessSchema,
  runConfigurationWriteFailureSchema,
]);

export const runConfigurationDeleteRequestSchema = z
  .object({
    id: runConfigurationIdSchema,
    expectedRevision: runConfigurationRevisionSchema,
  })
  .strict();

export const runConfigurationDeleteResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("deleted"),
        id: runConfigurationIdSchema,
        revision: runConfigurationRevisionSchema,
      })
      .strict(),
    z
      .object({
        outcome: z.enum(["not-found", "revision-mismatch"]),
        id: runConfigurationIdSchema,
        currentRevision: runConfigurationRevisionSchema.nullable(),
      })
      .strict(),
  ],
);

export const runConfigurationRepositoryChangeSchema = z
  .object({
    kind: z.enum(["created", "updated", "deleted", "unknown"]),
    id: runConfigurationIdSchema.nullable(),
    relativePath: z.string().min(1).max(512).nullable(),
    revision: runConfigurationRevisionSchema.nullable(),
  })
  .strict();

export const runConfigurationProviderCapabilitySchema = z
  .object({
    provider: runConfigurationProviderKindSchema,
    label: z.string().trim().min(1).max(100),
    icon: z.string().trim().min(1).max(100),
    available: z.boolean(),
    supportsDiscovery: z.boolean(),
    supportsCommandOverride: z.boolean(),
    supportsBeforeLaunch: z.boolean(),
    supportsPlatformOverrides: z.boolean(),
  })
  .strict();

export const runConfigurationDetectionCandidateSchema = z
  .object({
    provider: runConfigurationProviderKindSchema,
    confidence: z.enum(["high", "medium", "low"]),
    reason: z.string().trim().min(1).max(1_000),
    effectiveCommand: z.string().trim().min(1).max(MAX_COMMAND_CHARACTERS),
    document: runConfigurationFileSchema,
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.provider !== candidate.document.provider) {
      context.addIssue({
        code: "custom",
        message: "The detected provider must match its document.",
        path: ["provider"],
      });
    }
  });

export type RunConfigurationId = z.infer<typeof runConfigurationIdSchema>;
export type RunConfigurationRevision = z.infer<
  typeof runConfigurationRevisionSchema
>;
export type RunConfigurationProviderKind = z.infer<
  typeof runConfigurationProviderKindSchema
>;
export type RunConfigurationPlatform = z.infer<
  typeof runConfigurationPlatformSchema
>;
export type RunConfigurationEnvironment = z.infer<
  typeof runConfigurationEnvironmentSchema
>;
export type RunConfigurationBeforeLaunchStep = z.infer<
  typeof runConfigurationBeforeLaunchStepSchema
>;
export type RunConfigurationShellDocument = z.infer<
  typeof runConfigurationShellDocumentSchema
>;
export type RunConfigurationNodeDocument = z.infer<
  typeof runConfigurationNodeDocumentSchema
>;
export type RunConfigurationJavaDocument = z.infer<
  typeof runConfigurationJavaDocumentSchema
>;
export type RunConfigurationDartDocument = z.infer<
  typeof runConfigurationDartDocumentSchema
>;
export type RunConfigurationFile = z.infer<typeof runConfigurationFileSchema>;
export type RunConfigurationDiagnostic = z.infer<
  typeof runConfigurationDiagnosticSchema
>;
export type RunConfigurationRepositoryEntry = z.infer<
  typeof runConfigurationRepositoryEntrySchema
>;
export type RunConfigurationRepositoryInventory = z.infer<
  typeof runConfigurationRepositoryInventorySchema
>;
export type RunConfigurationReadResult = z.infer<
  typeof runConfigurationReadResultSchema
>;
export type RunConfigurationWriteRequest = z.infer<
  typeof runConfigurationWriteRequestSchema
>;
export type RunConfigurationWriteResult = z.infer<
  typeof runConfigurationWriteResultSchema
>;
export type RunConfigurationDeleteRequest = z.infer<
  typeof runConfigurationDeleteRequestSchema
>;
export type RunConfigurationDeleteResult = z.infer<
  typeof runConfigurationDeleteResultSchema
>;
export type RunConfigurationRepositoryChange = z.infer<
  typeof runConfigurationRepositoryChangeSchema
>;
export type RunConfigurationProviderCapability = z.infer<
  typeof runConfigurationProviderCapabilitySchema
>;
export type RunConfigurationDetectionCandidate = z.infer<
  typeof runConfigurationDetectionCandidateSchema
>;
