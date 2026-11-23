ALTER TABLE managed_queue_claims ADD COLUMN goal_cancelled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Older Stop/Clear/Pause controls could leave an applied setter pending.
-- Retire only the original unchanged input; an edited revision is independent.
WITH retired AS (
  UPDATE managed_queue_claims c SET goal_cancelled = true, status = 'consumed'
  FROM native_commands n, queued_prompts p
  WHERE c.awaiting_goal AND c.status = 'rejected' AND c.goal_operation_id IS NULL
    AND n.operation_id = c.operation_id AND n.operation_generation = c.operation_generation
    AND n.chat_id = c.chat_id AND n.method = 'thread/goal/set' AND n.status = 'applied'
    AND p.id = c.prompt_id AND p.chat_id = c.chat_id AND p.revision = c.prompt_revision
    AND p.state IN ('pending','claimed')
  RETURNING c.prompt_id, c.prompt_revision, c.chat_id
), consumed AS (
  UPDATE queued_prompts p SET state = 'consumed', updated_at = now()
  FROM retired r
  WHERE p.id = r.prompt_id AND p.chat_id = r.chat_id AND p.revision = r.prompt_revision
    AND p.state IN ('pending','claimed')
  RETURNING p.chat_id
)
UPDATE managed_queue_states SET revision = revision + 1, notification_due_at = now()
WHERE chat_id IN (SELECT chat_id FROM consumed);
