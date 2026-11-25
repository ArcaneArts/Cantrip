CREATE TABLE external_mcp_operation_receipts (
    owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    principal_id text NOT NULL,
    operation_id text NOT NULL,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tool text NOT NULL,
    key_revision integer NOT NULL CHECK (key_revision > 0),
    fingerprint text NOT NULL,
    protected_request jsonb NOT NULL,
    receipt jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, principal_id, operation_id)
);
