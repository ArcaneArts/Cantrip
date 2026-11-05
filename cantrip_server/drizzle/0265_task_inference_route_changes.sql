CREATE FUNCTION task_inference_route_change_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE owner_key text;
BEGIN
  IF NEW.inference_input->'routeChange'->>'phase' IS DISTINCT FROM 'draining' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.inference_input->'routeChange' IS NOT DISTINCT FROM OLD.inference_input->'routeChange' THEN
    RETURN NEW;
  END IF;
  SELECT owner_id INTO owner_key FROM chats WHERE id = NEW.chat_id;
  IF owner_key IS NOT NULL THEN
    PERFORM pg_notify('cantrip_inference_resource_revocations', json_build_object(
      'ownerId', owner_key,
      'workerId', NEW.inference_input->'routeChange'->'source'->>'workerId'
    )::text);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER task_inference_route_change_notify
AFTER INSERT OR UPDATE OF inference_input ON task_planning_rounds
FOR EACH ROW EXECUTE FUNCTION task_inference_route_change_notify();
--> statement-breakpoint
CREATE INDEX task_inference_route_change_pending_idx ON task_planning_rounds
  (chat_id, (inference_input->'routeChange'->'source'->>'workerId'))
  WHERE inference_input->'routeChange'->>'phase' = 'draining';
--> statement-breakpoint
CREATE INDEX task_inference_route_change_history_idx ON task_planning_rounds (chat_id, ordinal DESC)
  WHERE inference_input ? 'routeChange';
