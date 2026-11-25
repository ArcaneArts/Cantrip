ALTER TABLE council_project_deliveries
    ADD COLUMN queued_prompt_id text,
    ADD COLUMN steer_requested boolean NOT NULL DEFAULT false,
    ADD COLUMN steer_result_operation_id text;
--> statement-breakpoint
CREATE UNIQUE INDEX council_project_requested_steers
    ON council_project_deliveries(queued_prompt_id) WHERE steer_requested;
--> statement-breakpoint
CREATE VIEW council_project_ready_results AS
    SELECT d.* FROM council_project_deliveries d
    WHERE d.result_status IS NOT NULL AND d.callback_delivered_at IS NULL
        AND (d.steer_result_operation_id IS NULL OR EXISTS (
            SELECT 1 FROM native_commands n JOIN managed_queue_claims q
                ON q.operation_id=n.operation_id AND q.operation_generation=n.operation_generation
            WHERE n.operation_id=d.steer_result_operation_id AND n.chat_id=d.target_chat_id
                AND n.method='turn/steer' AND n.status='applied' AND q.prompt_id=d.queued_prompt_id AND q.status='consumed'
        ));
