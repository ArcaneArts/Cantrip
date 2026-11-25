ALTER TABLE council_agents ADD COLUMN hidden boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE OR REPLACE VIEW automation_agent_placements AS
    SELECT c.id AS chat_id,c.owner_id,c.project_id,w.worker_id,c.reasoning_effort
    FROM chats c JOIN project_worktrees w ON w.id=c.active_worktree_id
    WHERE c.context_kind='project' AND c.experience='agent'
    UNION ALL
    SELECT a.chat_id,a.owner_id,NULL::text,p.worker_id,c.reasoning_effort
    FROM council_agents a
    JOIN council_placements p ON p.owner_id=a.owner_id
    JOIN chats c ON c.id=a.chat_id AND c.owner_id=a.owner_id
    WHERE c.context_kind='council' AND c.archived_at IS NULL;
