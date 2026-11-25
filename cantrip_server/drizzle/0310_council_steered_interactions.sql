CREATE OR REPLACE VIEW council_project_interactions AS
    WITH agent_turns AS (
        SELECT r.id,r.chat_id,r.owner_id,r.worker_id,r.execution_lane_id,r.turn_id,r.created_at,
               n.logical_operation_id,n.activation_generation
        FROM agent_interaction_requests r
        JOIN native_command_turns observed
            ON observed.chat_id=r.chat_id AND observed.thread_id=r.thread_id AND observed.turn_id=r.turn_id
        JOIN native_commands n ON n.operation_id=observed.operation_id AND n.owner_id=r.owner_id
            AND n.worker_id=r.worker_id AND n.execution_lane_id=r.execution_lane_id
        WHERE r.project_id IS NOT NULL
    ), chat_inputs AS (
        SELECT r.id AS request_id,a.chat_id AS council_chat_id,d.input_message_id,
               0 AS precedence,d.created_at AS sent_at
        FROM agent_turns r
        JOIN native_commands root ON root.operation_id=r.logical_operation_id
        JOIN council_project_deliveries d
            ON d.target_chat_id=r.chat_id AND d.input_message_id=root.logical_client_message_id
        JOIN council_agents a ON a.chat_id=d.source_chat_id AND a.owner_id=r.owner_id
        UNION ALL
        SELECT r.id,a.chat_id,d.input_message_id,1,steer.created_at
        FROM agent_turns r
        JOIN native_commands steer ON steer.chat_id=r.chat_id AND steer.owner_id=r.owner_id
            AND steer.worker_id=r.worker_id AND steer.execution_lane_id=r.execution_lane_id
            AND steer.activation_generation=r.activation_generation
            AND steer.method='turn/steer' AND steer.status='applied' AND steer.created_at<=r.created_at
        JOIN managed_queue_claims claim ON claim.operation_id=steer.operation_id
            AND claim.operation_generation=steer.operation_generation AND claim.chat_id=r.chat_id
            AND claim.status='consumed' AND (claim.native_turn_id IS NULL OR claim.native_turn_id=r.turn_id)
        JOIN council_project_deliveries d ON d.queued_prompt_id=claim.prompt_id
            AND d.target_chat_id=r.chat_id AND d.steer_requested
        JOIN council_agents a ON a.chat_id=d.source_chat_id AND a.owner_id=r.owner_id
    ), project_sources AS (
        SELECT DISTINCT ON (request_id) request_id,council_chat_id,input_message_id
        FROM chat_inputs ORDER BY request_id,precedence DESC,sent_at DESC,input_message_id DESC
    )
    SELECT request_id,council_chat_id,input_message_id,'chat'::text AS target_kind FROM project_sources
    UNION ALL
    SELECT r.id,a.chat_id,round.user_message_id,'task'::text
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
