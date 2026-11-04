import { z } from "zod";
import { cantripOsGuestPathSchema } from "@cantrip/protocol";
import { runConfigurationRuntimeLaunchIdentitySchema } from "@cantrip/protocol/run-configuration-runtime";
import { runConfigurationStopSchema } from "@cantrip/protocol/run-configuration-definitions";

const value = z
  .string()
  .max(16 * 1024)
  .refine((value) => !value.includes("\0"));
export const osRunPlanInputSchema = z
  .object({
    identity: runConfigurationRuntimeLaunchIdentitySchema,
    sourceRoot: cantripOsGuestPathSchema,
    targetRoot: cantripOsGuestPathSchema,
    secrets: z
      .array(
        z.object({ reference: z.string().min(1).max(200), value }).strict(),
      )
      .max(256),
  })
  .strict();
export const osRunCommandSchema = z
  .object({
    executable: z.string().min(1).max(8192),
    arguments: z.array(z.string().max(100_000)).max(1024),
    workingDirectory: cantripOsGuestPathSchema,
  })
  .strict();
export const osRunPlanResponseSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("ready"),
      command: osRunCommandSchema,
      beforeLaunch: z.array(osRunCommandSchema).max(32),
      environment: z.record(z.string().max(256), value),
      preparationOutput: z.string().max(1024 * 1024),
      stopGracePeriodMs: runConfigurationStopSchema.shape.gracePeriodMs,
    })
    .strict(),
  z
    .object({
      state: z.literal("failed"),
      phase: z.enum(["definition", "target", "environment", "provider"]),
      code: z.string().min(1).max(100),
      message: z.string().min(1).max(1000),
    })
    .strict(),
]);
export type OsRunPlanInput = z.infer<typeof osRunPlanInputSchema>;
export type OsRunPlan = Extract<
  z.infer<typeof osRunPlanResponseSchema>,
  { state: "ready" }
>;
