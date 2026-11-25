ALTER TABLE chats
    DROP CONSTRAINT chats_context_kind_check,
    DROP CONSTRAINT chats_execution_root_check;
--> statement-breakpoint
ALTER TABLE chats
    ADD CONSTRAINT chats_context_kind_check CHECK (context_kind IN ('project', 'standalone', 'council')),
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
            AND custom_subagent_model = false
            AND subagent_model_id IS NULL
            AND subagent_reasoning_effort IS NULL
            AND plan_mode = 'default'
            AND protected_plan IS NULL
            AND has_pending_plan_question = false)
    );
--> statement-breakpoint
CREATE TABLE council_placements (
    owner_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    worker_id text NOT NULL REFERENCES workers(id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE council_agents (
    chat_id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES council_placements(owner_id) ON DELETE CASCADE,
    protected_role jsonb NOT NULL,
    is_primary boolean NOT NULL,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    FOREIGN KEY (chat_id, owner_id) REFERENCES chats(id, owner_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX council_agents_owner_idx ON council_agents(owner_id, chat_id);
