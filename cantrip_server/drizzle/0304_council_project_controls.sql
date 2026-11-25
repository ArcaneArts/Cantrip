CREATE TABLE council_project_interrupts (
    source_chat_id text NOT NULL REFERENCES council_agents(chat_id) ON DELETE CASCADE,
    operation_id uuid NOT NULL,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    target_chat_id text NOT NULL,
    target_kind text NOT NULL CHECK (target_kind IN ('agent','task')),
    interrupted boolean,
    failure_status integer,
    PRIMARY KEY (source_chat_id,operation_id),
    CHECK (interrupted IS NULL OR failure_status IS NULL)
);
