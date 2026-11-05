ALTER TABLE managed_queue_states ADD COLUMN goal_recovery jsonb;
--> statement-breakpoint
ALTER TABLE managed_queue_states ADD CONSTRAINT managed_queue_goal_recovery_object
  CHECK (goal_recovery IS NULL OR jsonb_typeof(goal_recovery) = 'object');
--> statement-breakpoint
ALTER TABLE native_commands ADD COLUMN goal_recovery_source jsonb;
--> statement-breakpoint
ALTER TABLE native_commands ADD CONSTRAINT native_command_goal_recovery_source_object
  CHECK (goal_recovery_source IS NULL OR jsonb_typeof(goal_recovery_source) = 'object');
--> statement-breakpoint
CREATE FUNCTION managed_goal_recovery_cancel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL OR NEW.managed_autonomy_stopped THEN
    UPDATE managed_queue_states SET goal_recovery = NULL, revision = revision + 1,
      notification_due_at = now() WHERE chat_id = NEW.id AND goal_recovery IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER managed_goal_recovery_cancel AFTER UPDATE OF archived_at, managed_autonomy_stopped ON chats
FOR EACH ROW EXECUTE FUNCTION managed_goal_recovery_cancel();
--> statement-breakpoint
-- Re-arm the existing durable queue cursor at real eligibility transitions.
-- Settings observations and ordinary handoff metadata updates do not poll or
-- produce new revisions when their pending/settled state has not changed.
CREATE FUNCTION managed_goal_recovery_eligibility_changed() RETURNS trigger
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
      WHERE chat_id = chat_id_value AND goal_recovery IS NOT NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER managed_goal_recovery_permission_changed AFTER INSERT OR UPDATE OR DELETE ON native_settings_states
FOR EACH ROW EXECUTE FUNCTION managed_goal_recovery_eligibility_changed();
--> statement-breakpoint
CREATE TRIGGER managed_goal_recovery_handoff_changed AFTER INSERT OR UPDATE OR DELETE ON native_runtime_handoffs
FOR EACH ROW EXECUTE FUNCTION managed_goal_recovery_eligibility_changed();
