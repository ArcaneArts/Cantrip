CREATE TABLE council_project_deliveries (
    source_chat_id text NOT NULL REFERENCES council_agents(chat_id) ON DELETE CASCADE,
    target_chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    operation_id uuid NOT NULL,
    input_message_id text NOT NULL UNIQUE,
    received_message_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source_chat_id, operation_id)
);
