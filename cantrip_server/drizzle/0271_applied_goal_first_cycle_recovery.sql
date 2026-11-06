-- Reuse the existing durable cursor for applied setters with no enqueued child.
INSERT INTO managed_queue_states (chat_id, revision, notification_due_at)
SELECT DISTINCT q.chat_id, 1, now()
FROM managed_queue_claims q
JOIN native_commands n ON n.operation_id=q.operation_id AND n.operation_generation=q.operation_generation
  AND n.chat_id=q.chat_id AND n.method='thread/goal/set' AND n.status='applied'
WHERE q.awaiting_goal AND NOT q.goal_cancelled AND q.native_turn_id IS NULL
  AND q.status IN ('dispatched','uncertain')
ON CONFLICT (chat_id) DO UPDATE SET revision=managed_queue_states.revision+1, notification_due_at=now();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION managed_goal_recovery_eligibility_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prior_row jsonb;
  current_row jsonb;
  chat_id_value text;
  was_blocked boolean := false;
  is_blocked boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN prior_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN current_row := to_jsonb(NEW); END IF;
  chat_id_value := COALESCE(current_row->>'chat_id', prior_row->>'chat_id');
  IF TG_TABLE_NAME = 'native_runtime_handoffs' THEN
    was_blocked := COALESCE(prior_row->>'phase' IN ('preparing','prepared','committed'), false);
    is_blocked := COALESCE(current_row->>'phase' IN ('preparing','prepared','committed'), false);
  ELSE
    was_blocked := EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(prior_row->'state'->'pending', '[]'::jsonb)) p
      WHERE p->'intent'->'permissionTransition' IS NOT NULL
    ) OR COALESCE(prior_row->'state'->>'desiredStatus' = 'uncertain'
      AND prior_row->'state'->'desired'->'permissionTransition' IS NOT NULL, false);
    is_blocked := EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(current_row->'state'->'pending', '[]'::jsonb)) p
      WHERE p->'intent'->'permissionTransition' IS NOT NULL
    ) OR COALESCE(current_row->'state'->>'desiredStatus' = 'uncertain'
      AND current_row->'state'->'desired'->'permissionTransition' IS NOT NULL, false);
  END IF;
  IF was_blocked IS DISTINCT FROM is_blocked THEN
    UPDATE managed_queue_states SET revision = revision + 1, notification_due_at = now()
    WHERE chat_id = chat_id_value AND (
      goal_recovery IS NOT NULL
      OR EXISTS (SELECT 1 FROM managed_queue_claims q
        JOIN native_commands n ON n.operation_id=q.operation_id AND n.operation_generation=q.operation_generation
          AND n.chat_id=q.chat_id AND n.method='thread/goal/set' AND n.status='applied'
        WHERE q.chat_id=chat_id_value AND q.awaiting_goal AND NOT q.goal_cancelled
          AND q.native_turn_id IS NULL AND q.status IN ('dispatched','uncertain'))
      OR EXISTS (SELECT 1 FROM task_dispatch_cycles d WHERE d.chat_id=chat_id_value
        AND d.goal_cycle_recovery IS NOT NULL AND d.goal_cycle_recovery->'settled' IS NULL)
    );
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
