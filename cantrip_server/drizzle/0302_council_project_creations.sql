CREATE TABLE council_project_creations (
    source_chat_id text NOT NULL REFERENCES council_agents(chat_id) ON DELETE CASCADE,
    operation_id uuid NOT NULL,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    target_chat_id text NOT NULL UNIQUE,
    kind text NOT NULL CHECK (kind IN ('chat','task')),
    protected_request jsonb NOT NULL,
    PRIMARY KEY (source_chat_id, operation_id)
);
