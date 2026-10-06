ALTER TABLE "model_provider_accounts" ADD COLUMN "credits" jsonb;--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD COLUMN "credits_observed_at" timestamp with time zone;
