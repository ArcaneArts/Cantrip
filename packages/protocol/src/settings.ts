import { z } from "zod";

import {
  DEFAULT_ELITE_REVEAL_CONFIG,
  eliteRevealConfigSchema,
} from "./elite.js";
import {
  modelProfileListSchema,
  modelProviderListSchema,
  modelProviderWireListSchema,
  reasoningEffortSchema,
} from "./providers.js";
import { workspaceLayoutProfileSchema } from "./workspace-layout-profiles.js";

export const themePreferenceSchema = z.enum(["system", "light", "dark"]);

export const DEFAULT_SIDEBAR_WIDTH = 288;
export const MIN_SIDEBAR_WIDTH = 192;
export const MAX_SIDEBAR_WIDTH = 480;
export const sidebarWidthPreferenceSchema = z
  .number()
  .int()
  .min(MIN_SIDEBAR_WIDTH)
  .max(MAX_SIDEBAR_WIDTH);

export const mobileProjectTabConfigurationsSchema = z
  .record(
    z.string().min(1).max(200),
    z.array(z.string().min(1).max(200).nullable()).min(1).max(20),
  )
  .refine((configurations) => Object.keys(configurations).length <= 200, {
    message: "Mobile tab configurations cannot contain more than 200 projects.",
  });

export const DEFAULT_PERMISSION_PROFILE_ID = ":workspace" as const;
export const configurablePermissionProfileIdSchema = z.enum([
  ":read-only",
  ":workspace",
  ":danger-full-access",
  ":yolo",
]);

export const userSettingsSchema = z.object({
  theme: themePreferenceSchema,
  highContrast: z.boolean(),
  proMode: z.boolean(),
  proModeOpacity: z.number().int().min(0).max(100),
  contentGutters: z.boolean().default(false),
  eliteMode: z.boolean().default(true),
  eliteRevealConfig: eliteRevealConfigSchema.default(
    DEFAULT_ELITE_REVEAL_CONFIG,
  ),
  sidebarWidth: sidebarWidthPreferenceSchema,
  workspaceLayoutProfile: workspaceLayoutProfileSchema.default("hybrid"),
  showChatPromptOverlay: z.boolean().default(true),
  randomAgentNames: z.boolean().default(false),
  desktopFrameRate: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  desktopStreamQuality: z.enum(["adaptive", "data-saver", "balanced", "sharp"]),
  defaultModelId: z.string().min(1).nullable(),
  defaultReasoningEffort: reasoningEffortSchema.nullable().default(null),
  defaultCustomSubagentModel: z.boolean().default(false),
  defaultSubagentModelId: z.string().min(1).nullable().default(null),
  defaultSubagentReasoningEffort: reasoningEffortSchema
    .nullable()
    .default(null),
  defaultPermissionProfileId: configurablePermissionProfileIdSchema.default(
    DEFAULT_PERMISSION_PROFILE_ID,
  ),
  defaultChatModelId: z.string().min(1).nullable().default(null),
  defaultChatReasoningEffort: reasoningEffortSchema.nullable().default(null),
  defaultChatPermissionProfileId: configurablePermissionProfileIdSchema.default(
    DEFAULT_PERMISSION_PROFILE_ID,
  ),
  defaultWorkerId: z.string().min(1).nullable().default(null),
  lastAppMode: z.enum(["ide", "chat"]).nullable().default(null),
  lastIdeProjectId: z.string().min(1).nullable().default(null),
  lastIdeWorkspaceId: z.string().min(1).nullable().default(null),
  lastStandaloneChatId: z.string().min(1).nullable().default(null),
  destinationRevision: z.number().int().positive().default(1),
  automaticReplicaProvisioning: z.boolean().default(false),
  automaticReplicaSynchronization: z
    .enum(["off", "verify-only", "fast-forward-primary"])
    .default("off"),
  mobileProjectTabConfigurations: mobileProjectTabConfigurationsSchema.default(
    {},
  ),
});

export const userSettingsUpdateSchema = userSettingsSchema
  .partial()
  .omit({
    lastAppMode: true,
    lastIdeProjectId: true,
    lastIdeWorkspaceId: true,
    lastStandaloneChatId: true,
    destinationRevision: true,
  })
  .extend({
    contentGutters: z.boolean().optional(),
    eliteMode: z.boolean().optional(),
    eliteRevealConfig: eliteRevealConfigSchema.optional(),
    defaultReasoningEffort: reasoningEffortSchema.nullable().optional(),
    defaultCustomSubagentModel: z.boolean().optional(),
    defaultSubagentModelId: z.string().min(1).nullable().optional(),
    defaultSubagentReasoningEffort: reasoningEffortSchema.nullable().optional(),
    defaultPermissionProfileId:
      configurablePermissionProfileIdSchema.optional(),
    defaultChatModelId: z.string().min(1).nullable().optional(),
    defaultChatReasoningEffort: reasoningEffortSchema.nullable().optional(),
    defaultChatPermissionProfileId:
      configurablePermissionProfileIdSchema.optional(),
    defaultWorkerId: z.string().min(1).nullable().optional(),
    showChatPromptOverlay: z.boolean().optional(),
    randomAgentNames: z.boolean().optional(),
    automaticReplicaProvisioning: z.boolean().optional(),
    automaticReplicaSynchronization: z
      .enum(["off", "verify-only", "fast-forward-primary"])
      .optional(),
    workspaceLayoutProfile: workspaceLayoutProfileSchema.optional(),
    mobileProjectTabConfigurations:
      mobileProjectTabConfigurationsSchema.optional(),
  });

export const appModeSchema = z.enum(["ide", "chat"]);

export const appDestinationSchema = z
  .object({
    lastAppMode: appModeSchema.nullable(),
    lastIdeProjectId: z.string().min(1).nullable(),
    lastIdeWorkspaceId: z.string().min(1).nullable(),
    lastStandaloneChatId: z.string().min(1).nullable(),
    revision: z.number().int().positive(),
  })
  .strict();

export const appDestinationUpdateSchema = appDestinationSchema
  .omit({ revision: true })
  .partial()
  .extend({ expectedRevision: z.number().int().positive() })
  .strict()
  .refine(
    (value) =>
      value.lastAppMode !== undefined ||
      value.lastIdeProjectId !== undefined ||
      value.lastIdeWorkspaceId !== undefined ||
      value.lastStandaloneChatId !== undefined,
    { message: "At least one destination field must be updated." },
  );

export const settingsBundleSchema = z.object({
  preferences: userSettingsSchema,
  providers: modelProviderListSchema,
  models: modelProfileListSchema,
});

export const settingsBundleWireSchema = settingsBundleSchema
  .omit({ providers: true })
  .extend({ providers: modelProviderWireListSchema })
  .strict();

export type ThemePreference = z.infer<typeof themePreferenceSchema>;

export type MobileProjectTabConfigurations = z.infer<
  typeof mobileProjectTabConfigurationsSchema
>;

export type UserSettings = z.infer<typeof userSettingsSchema>;

export type UserSettingsUpdate = z.infer<typeof userSettingsUpdateSchema>;

export type AppMode = z.infer<typeof appModeSchema>;

export type AppDestination = z.infer<typeof appDestinationSchema>;

export type AppDestinationUpdate = z.infer<typeof appDestinationUpdateSchema>;

export type SettingsBundle = z.infer<typeof settingsBundleSchema>;

export type SettingsBundleWire = z.infer<typeof settingsBundleWireSchema>;
