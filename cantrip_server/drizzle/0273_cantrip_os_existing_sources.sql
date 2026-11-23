CREATE TABLE cantrip_os_existing_source_admissions (
    operation_id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    binding_id text NOT NULL UNIQUE REFERENCES cantrip_os_source_bindings(id) ON DELETE CASCADE,
    request jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
