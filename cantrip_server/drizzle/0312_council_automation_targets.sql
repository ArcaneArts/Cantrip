ALTER TABLE project_automations ALTER COLUMN project_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE project_automation_runs
    ALTER COLUMN project_id DROP NOT NULL,
    ADD COLUMN protected_name jsonb,
    ADD COLUMN protected_prompt jsonb;
--> statement-breakpoint
CREATE VIEW automation_agent_placements AS
    SELECT c.id AS chat_id,c.owner_id,c.project_id,w.worker_id,c.reasoning_effort
    FROM chats c JOIN project_worktrees w ON w.id=c.active_worktree_id
    WHERE c.context_kind='project' AND c.experience='agent'
    UNION ALL
    SELECT a.chat_id,a.owner_id,NULL::text,p.worker_id,c.reasoning_effort
    FROM council_agents a
    JOIN council_placements p ON p.owner_id=a.owner_id
    JOIN chats c ON c.id=a.chat_id AND c.owner_id=a.owner_id
    WHERE c.context_kind='council';
