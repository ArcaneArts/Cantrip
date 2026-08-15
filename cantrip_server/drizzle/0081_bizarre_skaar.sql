ALTER TABLE "model_provider_accounts" ADD COLUMN "credential_refresh_lease_id" text;--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD COLUMN "credential_refresh_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD COLUMN "credential_last_refresh_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD COLUMN "credential_last_refresh_error" text;--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD CONSTRAINT "model_provider_accounts_refresh_lease_pair_check" CHECK (("model_provider_accounts"."credential_refresh_lease_id" IS NULL) = ("model_provider_accounts"."credential_refresh_lease_expires_at" IS NULL));