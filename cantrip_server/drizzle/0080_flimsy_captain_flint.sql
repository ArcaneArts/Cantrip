ALTER TABLE "model_provider_accounts" ADD COLUMN "credential_envelope" text;--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD COLUMN "credential_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD COLUMN "credential_state" text DEFAULT 'signed-out' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD COLUMN "credential_subject" text;--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD COLUMN "credential_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD COLUMN "credential_updated_at" timestamp with time zone;--> statement-breakpoint
UPDATE "model_provider_accounts" SET "credential_state" = 'migration-needed';--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD CONSTRAINT "model_provider_accounts_credential_state_check" CHECK ("model_provider_accounts"."credential_state" IN ('signed-out', 'migration-needed', 'signed-in', 'reauth-required', 'conflict'));--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD CONSTRAINT "model_provider_accounts_credential_revision_check" CHECK ("model_provider_accounts"."credential_revision" >= 0);
