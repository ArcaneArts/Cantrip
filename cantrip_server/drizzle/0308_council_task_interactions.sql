CREATE OR REPLACE VIEW council_project_interactions AS
    SELECT r.id AS request_id, a.chat_id AS council_chat_id, d.input_message_id, 'chat'::text AS target_kind
    FROM agent_interaction_requests r
    JOIN native_command_turns observed
        ON observed.chat_id=r.chat_id AND observed.thread_id=r.thread_id AND observed.turn_id=r.turn_id
    JOIN native_commands n ON n.operation_id=observed.operation_id AND n.owner_id=r.owner_id
        AND n.worker_id=r.worker_id AND n.execution_lane_id=r.execution_lane_id
    JOIN native_commands root ON root.operation_id=n.logical_operation_id
    JOIN council_project_deliveries d
        ON d.target_chat_id=r.chat_id AND d.input_message_id=root.logical_client_message_id
    JOIN council_agents a ON a.chat_id=d.source_chat_id AND a.owner_id=r.owner_id
    WHERE r.project_id IS NOT NULL
    UNION ALL
    SELECT r.id AS request_id, a.chat_id AS council_chat_id, round.user_message_id AS input_message_id, 'task'::text AS target_kind
    FROM agent_interaction_requests r
    JOIN task_planning_rounds round ON round.chat_id=r.chat_id AND round.execution_lane_id=r.execution_lane_id
         AND (round.turn_id IS NULL OR round.turn_id=r.turn_id)
    JOIN task_dispatch_cycles dispatch ON dispatch.chat_id=round.chat_id AND dispatch.operation_id=round.id
         AND dispatch.owner_id=r.owner_id AND dispatch.physical_worker_id=r.worker_id
         AND (dispatch.codex_thread_id IS NULL OR dispatch.codex_thread_id=r.thread_id)
         AND (dispatch.turn_id IS NULL OR dispatch.turn_id=r.turn_id)
    JOIN council_task_dispatches source ON source.dispatch_id=dispatch.id
    JOIN council_agents a ON a.chat_id=source.source_chat_id AND a.owner_id=r.owner_id
    WHERE r.project_id IS NOT NULL;
