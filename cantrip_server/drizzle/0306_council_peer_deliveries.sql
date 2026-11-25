CREATE TABLE council_peer_deliveries (
    sender_chat_id text NOT NULL REFERENCES council_agents(chat_id) ON DELETE CASCADE,
    recipient_chat_id text NOT NULL REFERENCES council_agents(chat_id) ON DELETE CASCADE,
    operation_id uuid NOT NULL,
    sent_message_id text NOT NULL,
    input_message_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (sender_chat_id, operation_id),
    CHECK (sender_chat_id <> recipient_chat_id)
);

CREATE INDEX council_peer_deliveries_pair ON council_peer_deliveries (
    LEAST(sender_chat_id, recipient_chat_id), GREATEST(sender_chat_id, recipient_chat_id),
    created_at DESC, sent_message_id DESC
);
