ALTER TABLE council_project_deliveries
    ADD COLUMN result_operation_id text,
    ADD COLUMN result_thread_id text,
    ADD COLUMN result_turn_id text,
    ADD COLUMN result_status text CHECK (result_status IN ('completed','failed','interrupted','unavailable')),
    ADD COLUMN callback_due_at timestamp with time zone NOT NULL DEFAULT now(),
    ADD COLUMN callback_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN callback_delivered_at timestamp with time zone;
--> statement-breakpoint
CREATE INDEX council_project_results_pending ON council_project_deliveries(callback_due_at)
    WHERE result_status IS NOT NULL AND callback_delivered_at IS NULL;
