DROP INDEX "provider_model_catalog_snapshots_version_unique";--> statement-breakpoint
DROP INDEX "provider_model_catalog_snapshots_model_time_index";--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD COLUMN "protected_label" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_catalog_sync_states" ADD COLUMN "error_code" text;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_model_catalog_snapshots_version_unique" ON "provider_model_catalog_snapshots" USING btree ("owner_id","provider_id","availability_scope","metadata_hash");--> statement-breakpoint
CREATE INDEX "provider_model_catalog_snapshots_model_time_index" ON "provider_model_catalog_snapshots" USING btree ("owner_id","provider_id","observed_at");--> statement-breakpoint
ALTER TABLE "audit_events" DROP COLUMN "ip_address_hash";--> statement-breakpoint
ALTER TABLE "audit_events" DROP COLUMN "user_agent_hash";--> statement-breakpoint
ALTER TABLE "audit_events" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "model_behavior_observations" DROP COLUMN "model_name";--> statement-breakpoint
ALTER TABLE "model_behavior_observations" DROP COLUMN "provider_name";--> statement-breakpoint
ALTER TABLE "model_behavior_observations" DROP COLUMN "provider_model_name";--> statement-breakpoint
ALTER TABLE "model_provider_account_workers" DROP COLUMN "last_error";--> statement-breakpoint
ALTER TABLE "model_provider_accounts" DROP COLUMN "label";--> statement-breakpoint
ALTER TABLE "model_provider_accounts" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "model_provider_accounts" DROP COLUMN "credential_last_refresh_error";--> statement-breakpoint
ALTER TABLE "provider_catalog_sync_states" DROP COLUMN "error";--> statement-breakpoint
ALTER TABLE "provider_model_catalog_snapshots" DROP COLUMN "provider_name";--> statement-breakpoint
ALTER TABLE "provider_model_catalog_snapshots" DROP COLUMN "native_model_id";--> statement-breakpoint
ALTER TABLE "provider_model_catalog_snapshots" DROP COLUMN "canonical_model_id";--> statement-breakpoint
ALTER TABLE "provider_model_catalog_snapshots" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "provider_quota_observations" DROP COLUMN "provider_name";--> statement-breakpoint
ALTER TABLE "provider_quota_observations" DROP COLUMN "provider_account_label";--> statement-breakpoint
ALTER TABLE "provider_quota_observations" DROP COLUMN "worker_name";--> statement-breakpoint
ALTER TABLE "provider_quota_observations" DROP COLUMN "limit_name";--> statement-breakpoint
ALTER TABLE "provider_quota_observations" DROP COLUMN "plan_type";--> statement-breakpoint
ALTER TABLE "provider_quota_observations" DROP COLUMN "sanitized_raw_payload";--> statement-breakpoint
ALTER TABLE "token_usage_records" DROP COLUMN "model_name";--> statement-breakpoint
ALTER TABLE "token_usage_records" DROP COLUMN "provider_name";--> statement-breakpoint
ALTER TABLE "token_usage_records" DROP COLUMN "provider_model_name";--> statement-breakpoint
ALTER TABLE "token_usage_records" DROP COLUMN "sanitized_raw_usage";