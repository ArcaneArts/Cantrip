import { z } from "zod";
import { nativeSettingsVersionSchema } from "./native-settings-state.js";

// Preserve native security/profile material and future fields verbatim. Mapping
// these values to authorized Cantrip profiles belongs to the managed controller.
export const nativeThreadSettingsSchema = z
  .object({
    settingsVersion: nativeSettingsVersionSchema.optional(),
    cwd: z.string(),
    approvalPolicy: z.union([z.string(), z.record(z.string(), z.json())]),
    approvalsReviewer: z.string(),
    sandboxPolicy: z.record(z.string(), z.json()),
    activePermissionProfile: z.json(),
    model: z.string(),
    modelProvider: z.string(),
    effort: z.string().nullable(),
    serviceTier: z.string().nullable(),
    summary: z.string().nullable(),
    collaborationMode: z
      .object({
        mode: z.enum(["default", "plan"]),
        settings: z.record(z.string(), z.json()),
      })
      .catchall(z.json()),
    multiAgentMode: z.string().optional(),
    // Absent on older workers means unavailable, not disabled/inherited.
    multiAgentEnabled: z.boolean().optional(),
    subagentModel: z.string().nullable().optional(),
    subagentReasoningEffort: z.string().nullable().optional(),
    personality: z.string().nullable(),
  })
  .catchall(z.json());

export type NativeThreadSettings = z.infer<typeof nativeThreadSettingsSchema>;
