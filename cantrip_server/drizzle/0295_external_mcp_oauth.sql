CREATE TABLE "external_mcp_oauth_clients" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "redirect_uris" jsonb NOT NULL,
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_mcp_oauth_authorizations" (
  "consent_hash" text PRIMARY KEY,
  "client_id" text NOT NULL REFERENCES "external_mcp_oauth_clients"("id") ON DELETE CASCADE,
  "owner_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "browser_session_id" text NOT NULL,
  "request" jsonb NOT NULL,
  "integration_id" text REFERENCES "external_mcp_integrations"("id") ON DELETE CASCADE,
  "integration_generation" integer,
  "code_hash" text UNIQUE,
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_mcp_oauth_tokens" (
  "hash" text PRIMARY KEY,
  "kind" text NOT NULL CHECK ("kind" IN ('access','refresh','bridge')),
  "client_id" text NOT NULL REFERENCES "external_mcp_oauth_clients"("id") ON DELETE CASCADE,
  "owner_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "integration_id" text NOT NULL REFERENCES "external_mcp_integrations"("id") ON DELETE CASCADE,
  "integration_generation" integer NOT NULL,
  "resource" text NOT NULL,
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX "external_mcp_oauth_tokens_owner_expiry" ON "external_mcp_oauth_tokens" ("owner_id", "expires_at");
