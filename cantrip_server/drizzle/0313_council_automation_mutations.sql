CREATE TABLE council_automation_mutations (
    source_chat_id text NOT NULL REFERENCES council_agents(chat_id) ON DELETE CASCADE,
    operation_id uuid NOT NULL,
    operation text NOT NULL CHECK (operation IN ('create','update')),
    automation_id text NOT NULL,
    target_chat_id text NOT NULL,
    result jsonb NOT NULL,
    PRIMARY KEY (source_chat_id,operation_id)
);
