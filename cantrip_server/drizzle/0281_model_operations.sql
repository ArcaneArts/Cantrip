ALTER TABLE "provider_models" ADD COLUMN "operation_capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_model_availability" ADD COLUMN "operation_capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_profiles" ADD COLUMN "operation" text DEFAULT 'language' NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_profiles" ADD CONSTRAINT "model_profiles_operation_check" CHECK ("operation" IN ('language', 'embedding', 'decision'));
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "default_embedding_model_id" text REFERENCES "model_profiles"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "default_decision_model_id" text REFERENCES "model_profiles"("id") ON DELETE SET NULL;
