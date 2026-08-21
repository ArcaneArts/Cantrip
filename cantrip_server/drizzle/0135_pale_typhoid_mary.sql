ALTER TABLE "user_settings" ALTER COLUMN "elite_reveal_config" SET DEFAULT '{"glitchCountMax":3,"glitchCountMin":1,"glitchShowMs":9,"staggerSpreadMs":50,"variants":["outline","full-frame","left-frame","right-frame","chromatic","spatial-shift","scanline","text-jitter"],"variantWeights":{"outline":1,"full-frame":0.1,"left-frame":0.1,"right-frame":0.1,"chromatic":0.25,"spatial-shift":1,"scanline":0.5,"text-jitter":1}}'::jsonb;
--> statement-breakpoint
UPDATE "user_settings"
SET "elite_reveal_config" = jsonb_set(
  "elite_reveal_config",
  '{variantWeights}',
  '{"outline":1,"full-frame":0.1,"left-frame":0.1,"right-frame":0.1,"chromatic":0.25,"spatial-shift":1,"scanline":0.5,"text-jitter":1}'::jsonb,
  true
)
WHERE NOT ("elite_reveal_config" ? 'variantWeights');
