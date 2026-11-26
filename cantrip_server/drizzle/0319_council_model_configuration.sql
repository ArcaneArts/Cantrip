ALTER TABLE user_settings
    ADD COLUMN default_council_reasoning_effort text,
    ADD COLUMN default_council_custom_subagent_model boolean,
    ADD COLUMN default_council_subagent_model_id text REFERENCES model_profiles(id) ON DELETE SET NULL,
    ADD COLUMN default_council_subagent_reasoning_effort text;
--> statement-breakpoint
ALTER TABLE chats
    DROP CONSTRAINT chats_execution_root_check,
    ADD CONSTRAINT chats_execution_root_check CHECK (
        (context_kind = 'project'
            AND project_id IS NOT NULL
            AND active_worktree_id IS NOT NULL
            AND active_scratch_root_id IS NULL
            AND worktree_mode IN ('agent-managed', 'pinned'))
        OR (context_kind IN ('standalone', 'council')
            AND project_id IS NULL
            AND active_worker_id IS NOT NULL
            AND active_worktree_id IS NULL
            AND active_scratch_root_id IS NOT NULL
            AND worktree_mode IS NULL
            AND experience = 'agent'
            AND (context_kind = 'council' OR (
                custom_subagent_model = false
                AND subagent_model_id IS NULL
                AND subagent_reasoning_effort IS NULL))
            AND plan_mode = 'default'
            AND protected_plan IS NULL
            AND has_pending_plan_question = false)
    );
