ALTER TABLE "user_settings" ALTER COLUMN "elite_reveal_config" SET DEFAULT '{"glitchCountMax":8,"glitchCountMin":4,"glitchShowMs":16,"staggerSpreadMs":50,"variants":["outline","full-frame","left-frame","right-frame","chromatic","spatial-shift","scanline","text-jitter"],"variantWeights":{"outline":1,"full-frame":0.01,"left-frame":0.01,"right-frame":0.01,"chromatic":0.25,"spatial-shift":1,"scanline":0.33,"text-jitter":1}}'::jsonb;
--> statement-breakpoint
UPDATE "user_settings"
SET "elite_reveal_config" = "elite_reveal_config" - 'glitchTerminalContents'
WHERE "elite_reveal_config" ? 'glitchTerminalContents';
