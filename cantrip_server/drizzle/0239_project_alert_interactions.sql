-- Source requests remain authoritative. The projection never executes a reply.
CREATE FUNCTION project_alert_project_interaction(r agent_interaction_requests) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c chats; closed boolean; alert_kind text;
BEGIN
 IF r.project_id IS NULL THEN RETURN; END IF;
 IF r.chat_id IS NOT NULL THEN
   -- Serialize with archive/Stop and turn retirement. Do not lock source rows
   -- from a Chat trigger: response operations already lock request -> Chat.
   SELECT * INTO c FROM chats WHERE id=r.chat_id AND owner_id=r.owner_id AND project_id=r.project_id FOR NO KEY UPDATE;
   IF c.id IS NULL THEN RETURN; END IF;
 END IF;
 closed := r.status <> 'pending' OR (r.expires_at IS NOT NULL AND r.expires_at <= clock_timestamp())
   OR (c.id IS NOT NULL AND (c.archived_at IS NOT NULL OR c.managed_autonomy_stopped));
 IF NOT closed AND r.execution_lane_id IS NOT NULL THEN
   closed := EXISTS (SELECT 1 FROM chat_execution_lanes WHERE id=r.execution_lane_id AND state='released');
 END IF;
 IF NOT closed AND r.chat_id IS NOT NULL AND r.turn_id IS NOT NULL THEN
   closed := EXISTS (SELECT 1 FROM native_history_turns t JOIN native_history_bindings b ON b.id=t.binding_id
     WHERE b.owner_id=r.owner_id AND b.chat_id=r.chat_id AND b.worker_id=r.worker_id
     AND b.thread_id=r.thread_id AND t.turn_id=r.turn_id AND t.status IN ('completed','failed','interrupted'));
 END IF;
 alert_kind := CASE WHEN r.kind IN ('userInput','mcpElicitation') THEN 'user-input' ELSE 'permission' END;
 PERFORM project_alert_apply(r.owner_id,jsonb_build_object(
   'projectId',r.project_id,'chatId',r.chat_id,'source','interaction','sourceId',r.id,
   'episodeId','request','sourceRevision',CASE WHEN closed THEN 2 ELSE 1 END,
   'kind',alert_kind,'priority',0,'status',CASE WHEN closed THEN 'resolved' ELSE 'open' END,
   'target',jsonb_build_object('kind','interaction','chatId',r.chat_id,'requestId',r.id),
   'occurredAt',r.created_at));
END;
$$;
--> statement-breakpoint
CREATE FUNCTION project_alert_interaction_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   UPDATE project_alerts SET resolved_at=clock_timestamp(),updated_at=clock_timestamp(),source_revision=GREATEST(source_revision,2)
     WHERE owner_id=OLD.owner_id AND source='interaction' AND source_id=OLD.id AND resolved_at IS NULL;
 ELSE
   PERFORM project_alert_project_interaction(NEW);
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_alert_interaction_changed AFTER INSERT OR UPDATE OR DELETE ON agent_interaction_requests FOR EACH ROW EXECUTE FUNCTION project_alert_interaction_changed();
--> statement-breakpoint
CREATE FUNCTION project_alert_chat_retired() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL)
   OR (NEW.managed_autonomy_stopped AND NOT OLD.managed_autonomy_stopped) THEN
   UPDATE project_alerts SET resolved_at=clock_timestamp(),updated_at=clock_timestamp(),source_revision=source_revision+1
     WHERE chat_id=NEW.id AND resolved_at IS NULL;
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_alert_chat_retired AFTER UPDATE OF archived_at,managed_autonomy_stopped ON chats FOR EACH ROW EXECUTE FUNCTION project_alert_chat_retired();
--> statement-breakpoint
CREATE FUNCTION project_alert_turn_retired() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b native_history_bindings; r agent_interaction_requests;
BEGIN
 IF NEW.status NOT IN ('completed','failed','interrupted') THEN RETURN NULL; END IF;
 SELECT * INTO b FROM native_history_bindings WHERE id=NEW.binding_id;
 PERFORM 1 FROM chats WHERE id=b.chat_id FOR NO KEY UPDATE;
 FOR r IN SELECT * FROM agent_interaction_requests WHERE owner_id=b.owner_id AND chat_id=b.chat_id
   AND worker_id=b.worker_id AND thread_id=b.thread_id AND turn_id=NEW.turn_id LOOP
   PERFORM project_alert_project_interaction(r);
 END LOOP;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_alert_turn_retired AFTER INSERT OR UPDATE OF status ON native_history_turns FOR EACH ROW EXECUTE FUNCTION project_alert_turn_retired();
--> statement-breakpoint
CREATE FUNCTION project_alert_lane_retired() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r agent_interaction_requests;
BEGIN
 IF NEW.state <> 'released' OR OLD.state='released' THEN RETURN NULL; END IF;
 PERFORM 1 FROM chats WHERE id=NEW.chat_id FOR NO KEY UPDATE;
 FOR r IN SELECT * FROM agent_interaction_requests WHERE execution_lane_id=NEW.id LOOP
   PERFORM project_alert_project_interaction(r);
 END LOOP;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_alert_lane_retired AFTER UPDATE OF state ON chat_execution_lanes FOR EACH ROW EXECUTE FUNCTION project_alert_lane_retired();
--> statement-breakpoint
-- Existing actionable requests are discovered once at migration, not by
-- mounting Chats or repeatedly scanning every project's request history.
DO $$ DECLARE r agent_interaction_requests;
BEGIN
 FOR r IN SELECT * FROM agent_interaction_requests WHERE project_id IS NOT NULL AND status='pending' LOOP
   PERFORM project_alert_project_interaction(r);
 END LOOP;
END $$;
