CREATE TABLE external_mcp_integrations (
    id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label text NOT NULL,
    permissions jsonb NOT NULL,
    credential_hash text NOT NULL UNIQUE,
    generation integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK (generation > 0)
);
--> statement-breakpoint
CREATE INDEX external_mcp_integrations_owner_idx
ON external_mcp_integrations (owner_id, created_at DESC, id);
