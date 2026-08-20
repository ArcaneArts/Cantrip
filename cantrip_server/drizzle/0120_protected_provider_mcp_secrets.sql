-- Pre-release destructive cutover: legacy MCP configuration and provider
-- credentials cannot be converted without exposing plaintext to the server.
-- Users recreate MCP servers and sign provider accounts in again after upgrade.
DELETE FROM "provider_model_availability" WHERE "scope_key" = 'openrouter:user';--> statement-breakpoint
DELETE FROM "provider_catalog_sync_states" WHERE "scope_key" = 'openrouter:user';--> statement-breakpoint
DELETE FROM "provider_model_catalog_snapshots" WHERE "availability_scope" = 'openrouter:user';--> statement-breakpoint
DELETE FROM "mcp_servers";--> statement-breakpoint
UPDATE "model_provider_accounts"
SET
	"credential_state" = 'signed-out',
	"credential_revision" = "credential_revision" + 1,
	"credential_expires_at" = NULL,
	"credential_updated_at" = NULL,
	"credential_refresh_lease_id" = NULL,
	"credential_refresh_lease_expires_at" = NULL,
	"credential_last_refresh_at" = NULL,
	"credential_last_refresh_error" = NULL,
	"email" = NULL,
	"plan_type" = NULL,
	"auth_last_synced_at" = NULL,
	"updated_at" = now();--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_transport_check";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_transport_configuration_check";--> statement-breakpoint
DROP INDEX "mcp_servers_owner_global_name_unique";--> statement-breakpoint
DROP INDEX "mcp_servers_project_name_unique";--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "name_blind_index" text NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "protected_configuration" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD COLUMN "protected_credential" jsonb;--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD COLUMN "credential_subject_blind_index" text;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "protected_api_key" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_owner_global_name_blind_unique" ON "mcp_servers" USING btree ("owner_id","name_blind_index") WHERE "mcp_servers"."project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_project_name_blind_unique" ON "mcp_servers" USING btree ("project_id","name_blind_index") WHERE "mcp_servers"."project_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "transport";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "command";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "args";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "url";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "environment";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "environment_envelope";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "headers";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "headers_envelope";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "environment_headers";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "bearer_token_environment_variable";--> statement-breakpoint
ALTER TABLE "model_provider_accounts" DROP COLUMN "credential_envelope";--> statement-breakpoint
ALTER TABLE "model_provider_accounts" DROP COLUMN "credential_subject";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "api_key";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "api_key_envelope";--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_name_blind_index_length_check" CHECK (length("mcp_servers"."name_blind_index") = 43);
