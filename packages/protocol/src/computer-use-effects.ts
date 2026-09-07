import { z } from "zod";

/** Rendering preferences carry no window content or input authority. */
export const cuaEffectIdSchema = z.enum([
  "off",
  "pass-through",
  "debug-gradient",
]);
export const cuaEffectConfigurationSchema = z.discriminatedUnion("effect", [
  z.strictObject({
    effect: z.literal("off"),
    parameters: z.strictObject({}).default({}),
  }),
  z.strictObject({
    effect: z.literal("pass-through"),
    parameters: z.strictObject({}).default({}),
  }),
  z.strictObject({
    effect: z.literal("debug-gradient"),
    parameters: z
      .strictObject({
        strength: z.number().min(0).max(1).optional(),
        radius: z.number().min(16).max(320).optional(),
        showTelemetry: z.union([z.literal(0), z.literal(1)]).optional(),
      })
      .default({}),
  }),
]);
export type CuaEffectConfiguration = z.infer<
  typeof cuaEffectConfigurationSchema
>;
export const CUA_EFFECT_OFF: CuaEffectConfiguration = {
  effect: "off",
  parameters: {},
};
export const CUA_EFFECTS = [
  { id: "off", label: "Off" },
  { id: "pass-through", label: "Pass-through" },
  { id: "debug-gradient", label: "Debug gradient inversion" },
] as const;

/** Monotonic durable revision prevents a delayed heartbeat undoing a new save. */
export const cuaEffectPreferencesSchema = z.strictObject({
  revision: z.number().int().positive().max(2_147_483_647),
  configuration: cuaEffectConfigurationSchema,
});
export type CuaEffectPreferences = z.infer<typeof cuaEffectPreferencesSchema>;
export function effectiveCuaEffects(settings: {
  computerUseEnabled?: boolean;
  computerUseEffects?: CuaEffectConfiguration;
  computerUseEffectsRevision?: number;
}): CuaEffectPreferences {
  return {
    revision: settings.computerUseEffectsRevision ?? 1,
    configuration: settings.computerUseEnabled
      ? (settings.computerUseEffects ?? CUA_EFFECT_OFF)
      : CUA_EFFECT_OFF,
  };
}

export const cuaEffectStatusSchema = z.object({
  supported: z.boolean(),
  configuration: cuaEffectConfigurationSchema,
  compiling: z.boolean().optional(),
  shaderSource: z.string().nullable().optional(),
  activeEffect: cuaEffectIdSchema.nullable().optional(),
  shaderError: z.string().nullable().optional(),
  windows: z.array(
    z.object({
      targetId: z.string(),
      phase: z.string(),
      error: z.string().nullable().optional(),
    }),
  ),
});
export const cuaEffectWorkerStatusSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  configuration: cuaEffectConfigurationSchema,
  state: z.enum(["idle", "running", "failed"]),
  error: z.string().nullable(),
  native: cuaEffectStatusSchema.nullable(),
});
export type CuaEffectWorkerStatus = z.infer<typeof cuaEffectWorkerStatusSchema>;
