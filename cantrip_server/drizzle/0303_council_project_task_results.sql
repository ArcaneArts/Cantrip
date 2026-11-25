ALTER TABLE council_project_creations
    ADD COLUMN callback_due_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN callback_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN callback_delivered_at timestamptz;
--> statement-breakpoint
CREATE INDEX council_project_task_callbacks_pending
    ON council_project_creations(callback_due_at)
    WHERE kind='task' AND callback_delivered_at IS NULL;
--> statement-breakpoint
CREATE VIEW council_project_task_results AS
    SELECT c.source_chat_id,c.operation_id,c.target_chat_id,c.project_id,
        a.owner_id,c.callback_due_at,c.callback_attempts,d.id AS cycle_id,
        d.codex_thread_id AS thread_id,d.turn_id,r.user_message_id AS input_message_id,
        CASE
            WHEN d.state='succeeded' THEN 'completed'
            WHEN d.state='cancelled' THEN 'interrupted'
            ELSE 'failed'
        END AS status,
        CASE WHEN m.id IS NOT NULL AND d.state='succeeded' THEN jsonb_build_object(
            'id',m.id,'protectedContent',m.task_protected_content,
            'classification',jsonb_build_object('role',m.role,'mode',m.mode,'attachmentIds',m.task_attachment_ids)
        ) END AS result
    FROM council_project_creations c
    JOIN council_agents a ON a.chat_id=c.source_chat_id
    JOIN chats target ON target.id=c.target_chat_id AND target.owner_id=a.owner_id
        AND target.project_id=c.project_id AND target.archived_at IS NULL
    JOIN task_dispatch_cycles d ON d.chat_id=target.id AND d.owner_id=a.owner_id
        AND d.operation_id=c.operation_id::text AND d.operation_kind='direct'
    LEFT JOIN task_planning_rounds r ON r.id=d.operation_id AND r.chat_id=d.chat_id AND r.kind='direct'
    LEFT JOIN chat_messages m ON m.id=r.assistant_message_id AND m.chat_id=r.chat_id
        AND m.execution_lane_id=r.execution_lane_id AND m.role='assistant' AND m.task_protected_content IS NOT NULL
    WHERE c.kind='task' AND c.callback_delivered_at IS NULL
        AND (
            (d.state='succeeded' AND r.status='completed') OR d.state IN ('failed','cancelled')
            OR (d.state='expired' AND r.status='failed')
        );
