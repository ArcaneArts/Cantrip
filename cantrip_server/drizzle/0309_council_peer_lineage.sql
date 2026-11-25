CREATE TABLE council_peer_chains (
    id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    accepted integer NOT NULL CHECK (accepted BETWEEN 1 AND 32)
);
--> statement-breakpoint
ALTER TABLE council_peer_deliveries
    ADD COLUMN chain_id text REFERENCES council_peer_chains(id) ON DELETE CASCADE,
    ADD COLUMN depth integer CHECK (depth BETWEEN 1 AND 12),
    ADD COLUMN sender_input_message_id text,
    ADD COLUMN queued_prompt_id text,
    ADD CONSTRAINT council_peer_chain_depth_consistent CHECK ((chain_id IS NULL) = (depth IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX council_peer_deliveries_input ON council_peer_deliveries(input_message_id);
--> statement-breakpoint
CREATE UNIQUE INDEX council_peer_deliveries_queue ON council_peer_deliveries(queued_prompt_id)
    WHERE queued_prompt_id IS NOT NULL;
