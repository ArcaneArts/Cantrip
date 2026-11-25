ALTER TABLE agent_interaction_requests
    ADD COLUMN council_forwarded_at timestamptz,
    ADD COLUMN council_forward_due_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN council_forward_attempts integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX council_project_request_forwarding_pending
    ON agent_interaction_requests(council_forward_due_at)
    WHERE status='pending' AND council_forwarded_at IS NULL AND project_id IS NOT NULL;
--> statement-breakpoint
CREATE VIEW council_project_interactions AS
    SELECT r.id AS request_id, a.chat_id AS council_chat_id, d.input_message_id
    FROM agent_interaction_requests r
    JOIN native_command_turns observed
        ON observed.chat_id=r.chat_id AND observed.thread_id=r.thread_id AND observed.turn_id=r.turn_id
    JOIN native_commands n ON n.operation_id=observed.operation_id AND n.owner_id=r.owner_id
        AND n.worker_id=r.worker_id AND n.execution_lane_id=r.execution_lane_id
    JOIN native_commands root ON root.operation_id=n.logical_operation_id
    JOIN council_project_deliveries d
        ON d.target_chat_id=r.chat_id AND d.input_message_id=root.logical_client_message_id
    JOIN council_agents a ON a.chat_id=d.source_chat_id AND a.owner_id=r.owner_id
    WHERE r.project_id IS NOT NULL;
