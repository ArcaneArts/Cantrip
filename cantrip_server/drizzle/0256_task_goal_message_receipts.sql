ALTER TABLE chat_messages ADD COLUMN task_goal_input jsonb;
--> statement-breakpoint
UPDATE chat_messages m SET task_goal_input=prior.goal_input
FROM (
  SELECT DISTINCT ON (c.chat_id,c.goal_input->'receipt'->>'clientMessageId') c.chat_id,c.goal_input
  FROM task_dispatch_cycles c WHERE c.goal_input->'receipt'->>'kind'='goal'
  ORDER BY c.chat_id,c.goal_input->'receipt'->>'clientMessageId',c.created_at DESC,c.id DESC
) prior
WHERE m.id=prior.goal_input->'receipt'->>'clientMessageId' AND m.chat_id=prior.chat_id;
--> statement-breakpoint
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_task_goal_input_identity_check CHECK (
  task_goal_input IS NULL OR COALESCE((
    task_goal_input->'receipt'->>'kind'='goal'
    AND task_goal_input->'receipt'->>'chatId'=chat_id
    AND task_goal_input->'receipt'->>'clientMessageId'=id
  ),false)
);
--> statement-breakpoint
CREATE FUNCTION cantrip_capture_task_goal_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior jsonb; fact jsonb;
BEGIN
  IF NEW.goal_input IS NULL THEN RETURN NEW; END IF;
  SELECT m.task_goal_input INTO prior FROM chat_messages m
    WHERE m.id=NEW.goal_input->'receipt'->>'clientMessageId' AND m.chat_id=NEW.chat_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task Goal input requires its canonical message' USING ERRCODE='23503';
  END IF;
  fact:=NEW.goal_input;
  IF prior IS NOT NULL THEN
    IF prior->'receipt'->>'operationId' IS DISTINCT FROM fact->'receipt'->>'operationId' THEN
      IF NOT COALESCE(prior->'firstDispatchedOperationId'='null'::jsonb,false) THEN
        RAISE EXCEPTION 'A forwarded Task Goal message cannot acquire another input identity' USING ERRCODE='23514';
      END IF;
    ELSE
      IF prior->'receipt' IS DISTINCT FROM fact->'receipt' THEN
        RAISE EXCEPTION 'Task Goal input receipt identity is immutable' USING ERRCODE='23514';
      END IF;
      IF prior->'terminal' IS NOT NULL AND prior->'terminal'<>'null'::jsonb THEN
        IF fact->'terminal' IS NULL OR fact->'terminal'='null'::jsonb THEN
          fact:=jsonb_set(fact,'{terminal}',prior->'terminal');
        ELSIF prior->'terminal'->'ok' IS DISTINCT FROM fact->'terminal'->'ok'
          OR prior->'terminal'->'failureKind' IS DISTINCT FROM fact->'terminal'->'failureKind' THEN
          RAISE EXCEPTION 'Conflicting Task Goal terminal evidence' USING ERRCODE='23514';
        END IF;
      END IF;
    END IF;
  END IF;
  UPDATE chat_messages SET task_goal_input=fact
    WHERE id=fact->'receipt'->>'clientMessageId' AND chat_id=NEW.chat_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Runtime preparation updates an existing cycle after its canonical message
-- exists. INSERT-format logical restores retain their original table ordering.
CREATE TRIGGER task_goal_input_message_evidence AFTER UPDATE OF goal_input ON task_dispatch_cycles
FOR EACH ROW EXECUTE FUNCTION cantrip_capture_task_goal_input();
