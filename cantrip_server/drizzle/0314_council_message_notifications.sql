CREATE TABLE council_posted_messages (
    chat_id text NOT NULL REFERENCES council_agents(chat_id) ON DELETE CASCADE,
    operation_id uuid NOT NULL,
    message_id text NOT NULL UNIQUE,
    notify boolean NOT NULL,
    delivered_at timestamp with time zone,
    PRIMARY KEY (chat_id,operation_id)
);
--> statement-breakpoint
CREATE INDEX council_posted_messages_pending_idx ON council_posted_messages(chat_id,message_id)
    WHERE notify AND delivered_at IS NULL;
