import { z } from "zod";

export const RUN_CONFIGURATION_DIRECTORY = ".codex/environments" as const;
export const RUN_CONFIGURATION_CANONICAL_PATH =
  `${RUN_CONFIGURATION_DIRECTORY}/environment.toml` as const;

export const runConfigurationPlatformSchema = z.enum([
  "win32",
  "darwin",
  "linux",
]);

export const runConfigurationSourceControlStateSchema = z.enum([
  "absent",
  "tracked",
  "ignored",
  "untracked",
]);

export const runConfigurationDiagnosticSchema = z
  .object({
    severity: z.enum(["error", "warning"]),
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(1_000),
    configurationPath: z.string().min(1).max(512).nullable().default(null),
    field: z.string().min(1).max(512).nullable().default(null),
  })
  .strict();

const runConfigurationScriptSchema = z
  .string()
  .min(1)
  .max(100_000)
  .refine((value) => value.trim().length > 0, {
    message: "Run configuration scripts cannot be blank.",
  })
  .refine((value) => !value.includes("\0"), {
    message: "Run configuration scripts cannot contain NUL characters.",
  });

export const runConfigurationSetupSchema = z
  .object({
    command: runConfigurationScriptSchema,
    platform: runConfigurationPlatformSchema.nullable(),
  })
  .strict();

export const runConfigurationActionSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{64}$/u),
    name: z.string().trim().min(1).max(200),
    icon: z.string().trim().min(1).max(100),
    command: runConfigurationScriptSchema,
    platform: runConfigurationPlatformSchema.nullable(),
    configurationPath: z.string().min(1).max(512),
    sourceIndex: z.number().int().nonnegative().max(999),
  })
  .strict();

export const runConfigurationDefinitionSchema = z
  .object({
    relativePath: z.string().min(1).max(512),
    revision: z.string().regex(/^[0-9a-f]{64}$/u),
    version: z.number().int().positive().nullable(),
    name: z.string().trim().min(1).max(200).nullable(),
    sourceControlState: runConfigurationSourceControlStateSchema.exclude([
      "absent",
    ]),
    setup: runConfigurationSetupSchema.nullable(),
    actions: z.array(runConfigurationActionSchema).max(200),
    diagnostics: z.array(runConfigurationDiagnosticSchema).max(200),
  })
  .strict();

export const runConfigurationCanonicalLocationSchema = z
  .object({
    relativePath: z.literal(RUN_CONFIGURATION_CANONICAL_PATH),
    sourceControlState: runConfigurationSourceControlStateSchema,
  })
  .strict();

export const runConfigurationInspectionSchema = z
  .object({
    platform: runConfigurationPlatformSchema,
    canonical: runConfigurationCanonicalLocationSchema,
    configured: z.boolean(),
    valid: z.boolean(),
    configurations: z.array(runConfigurationDefinitionSchema).max(64),
    diagnostics: z.array(runConfigurationDiagnosticSchema).max(200),
  })
  .strict();

export const runConfigurationSelectionSchema = z
  .object({
    configuration: runConfigurationDefinitionSchema,
    action: runConfigurationActionSchema,
  })
  .strict();

export type RunConfigurationPlatform = z.infer<
  typeof runConfigurationPlatformSchema
>;
export type RunConfigurationSourceControlState = z.infer<
  typeof runConfigurationSourceControlStateSchema
>;
export type RunConfigurationDiagnostic = z.infer<
  typeof runConfigurationDiagnosticSchema
>;
export type RunConfigurationSetup = z.infer<typeof runConfigurationSetupSchema>;
export type RunConfigurationAction = z.infer<
  typeof runConfigurationActionSchema
>;
export type RunConfigurationDefinition = z.infer<
  typeof runConfigurationDefinitionSchema
>;
export type RunConfigurationInspection = z.infer<
  typeof runConfigurationInspectionSchema
>;
export type RunConfigurationSelection = z.infer<
  typeof runConfigurationSelectionSchema
>;
