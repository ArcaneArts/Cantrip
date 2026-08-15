ALTER TABLE "provider_models" DROP CONSTRAINT "provider_models_metadata_source_check";
--> statement-breakpoint
ALTER TABLE "provider_models" ADD CONSTRAINT "provider_models_metadata_source_check" CHECK ("provider_models"."metadata_source" IN ('ollama', 'openrouter', 'codex', 'grok', 'compatible-api', 'manual'));
--> statement-breakpoint
CREATE UNIQUE INDEX "model_providers_owner_grok_unique" ON "model_providers" USING btree ("owner_id") WHERE "model_providers"."kind" = 'grok';
