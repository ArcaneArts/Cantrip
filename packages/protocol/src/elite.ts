import { z } from "zod";

export const eliteGlitchVariantSchema = z.enum([
  "outline",
  "full-frame",
  "left-frame",
  "right-frame",
  "chromatic",
  "spatial-shift",
  "scanline",
  "text-jitter",
]);

export type EliteGlitchVariant = z.infer<typeof eliteGlitchVariantSchema>;

export const MAX_ELITE_GLITCH_COUNT = 32;

const eliteGlitchVariantWeightSchema = z.number().min(0).max(10);

export const eliteGlitchVariantWeightsSchema = z.object({
  outline: eliteGlitchVariantWeightSchema,
  "full-frame": eliteGlitchVariantWeightSchema,
  "left-frame": eliteGlitchVariantWeightSchema,
  "right-frame": eliteGlitchVariantWeightSchema,
  chromatic: eliteGlitchVariantWeightSchema,
  "spatial-shift": eliteGlitchVariantWeightSchema,
  scanline: eliteGlitchVariantWeightSchema,
  "text-jitter": eliteGlitchVariantWeightSchema,
});

export type EliteGlitchVariantWeights = z.infer<
  typeof eliteGlitchVariantWeightsSchema
>;

export const DEFAULT_ELITE_GLITCH_VARIANT_WEIGHTS: EliteGlitchVariantWeights = {
  outline: 1,
  "full-frame": 0.01,
  "left-frame": 0.01,
  "right-frame": 0.01,
  chromatic: 0.25,
  "spatial-shift": 1,
  scanline: 0.33,
  "text-jitter": 1,
};

export const eliteRevealConfigSchema = z
  .object({
    glitchCountMax: z.number().int().min(1).max(MAX_ELITE_GLITCH_COUNT),
    glitchCountMin: z.number().int().min(1).max(MAX_ELITE_GLITCH_COUNT),
    glitchShowMs: z.number().int().min(5).max(120),
    staggerSpreadMs: z.number().int().min(0).max(250),
    variants: z.array(eliteGlitchVariantSchema).max(8),
    variantWeights: eliteGlitchVariantWeightsSchema.default(
      DEFAULT_ELITE_GLITCH_VARIANT_WEIGHTS,
    ),
  })
  .refine(
    ({ glitchCountMax, glitchCountMin }) => glitchCountMax >= glitchCountMin,
    {
      message:
        "Maximum glitches must be greater than or equal to minimum glitches.",
      path: ["glitchCountMax"],
    },
  );

export type EliteRevealConfig = z.infer<typeof eliteRevealConfigSchema>;

export const DEFAULT_ELITE_REVEAL_CONFIG: EliteRevealConfig = {
  glitchCountMax: 8,
  glitchCountMin: 4,
  glitchShowMs: 16,
  staggerSpreadMs: 50,
  variants: [...eliteGlitchVariantSchema.options],
  variantWeights: { ...DEFAULT_ELITE_GLITCH_VARIANT_WEIGHTS },
};
