ALTER TABLE workers ADD COLUMN project_goal_generation text;
--> statement-breakpoint
-- This counter identifies attention occurrences; it does not control execution.
ALTER TABLE tasks ADD COLUMN alert_attention_epoch integer NOT NULL DEFAULT 0 CHECK (alert_attention_epoch >= 0);
--> statement-breakpoint
CREATE FUNCTION project_alert_task_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   NEW.alert_attention_epoch := 1;
 ELSE
   NEW.alert_attention_epoch := GREATEST(NEW.alert_attention_epoch,OLD.alert_attention_epoch);
   IF NEW.state IN ('review','blocked','failed') AND
     (NEW.state IS DISTINCT FROM OLD.state OR NEW.planning_round IS DISTINCT FROM OLD.planning_round
       OR NEW.last_error IS DISTINCT FROM OLD.last_error
       OR (COALESCE(OLD.automatic_retry->>'status','none') IN ('scheduled','retrying')
         AND COALESCE(NEW.automatic_retry->>'status','none') NOT IN ('scheduled','retrying'))) THEN
     NEW.alert_attention_epoch := OLD.alert_attention_epoch+1;
   END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_alert_task_epoch BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION project_alert_task_epoch();
--> statement-breakpoint
CREATE FUNCTION project_alert_project_task(t tasks) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c chats; attention_source text; alert_kind text; episode text; section text; closed boolean;
BEGIN
 SELECT * INTO c FROM chats WHERE id=t.chat_id FOR NO KEY UPDATE;
 IF c.project_id IS NULL THEN RETURN; END IF;
 IF t.state='review' AND t.has_plan THEN
   attention_source := 'task-review';
   alert_kind := CASE WHEN t.has_questions THEN 'task-questions' ELSE 'plan-ready' END;
   section := CASE WHEN t.has_questions THEN 'questions' ELSE 'plan' END;
 ELSIF t.state IN ('blocked','failed') AND t.last_error IS NOT NULL
   AND COALESCE(t.automatic_retry->>'status','none') NOT IN ('scheduled','retrying') THEN
   attention_source := 'task-blocker'; alert_kind := 'blocked'; section := 'overview';
 END IF;
 IF attention_source='task-review' AND EXISTS (SELECT 1 FROM task_dispatch_cycles WHERE chat_id=t.chat_id AND state IN ('queued','claimed','running','paused')) THEN
   attention_source := NULL;
 END IF;
 episode := t.planning_round::text || ':' || t.alert_attention_epoch::text;
 closed := c.archived_at IS NOT NULL OR c.managed_autonomy_stopped;
 IF t.state='complete' THEN
   UPDATE project_alerts SET resolved_at=clock_timestamp(),updated_at=clock_timestamp(),source_revision=source_revision+1
     WHERE chat_id=t.chat_id AND source='agent' AND resolved_at IS NULL;
 END IF;
 UPDATE project_alerts SET resolved_at=clock_timestamp(),updated_at=clock_timestamp(),source_revision=source_revision+1
   WHERE chat_id=t.chat_id AND source IN ('task-review','task-blocker') AND resolved_at IS NULL
     AND (closed OR attention_source IS NULL OR source<>attention_source OR episode_id<>episode);
 IF attention_source IS NULL THEN RETURN; END IF;
 PERFORM project_alert_apply(c.owner_id,jsonb_build_object(
   'projectId',c.project_id,'chatId',c.id,'source',attention_source,'sourceId',c.id,'episodeId',episode,
   'sourceRevision',t.row_version,'kind',alert_kind,'priority',1,
   'status',CASE WHEN closed THEN 'resolved' ELSE 'open' END,
   'target',jsonb_build_object('kind','task','chatId',c.id,'planningRound',t.planning_round,'section',section),
   'occurredAt',t.updated_at));
END;
$$;
--> statement-breakpoint
CREATE FUNCTION project_alert_execution_resumed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='active' AND NEW.activated_at IS NOT NULL AND
   (TG_OP='INSERT' OR NEW.activated_at IS DISTINCT FROM OLD.activated_at) THEN
   UPDATE project_alerts SET resolved_at=clock_timestamp(),updated_at=clock_timestamp(),source_revision=source_revision+1
     WHERE chat_id=NEW.chat_id AND source='agent' AND resolved_at IS NULL;
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_alert_execution_resumed AFTER INSERT OR UPDATE OF activated_at ON chat_execution_lanes FOR EACH ROW EXECUTE FUNCTION project_alert_execution_resumed();
--> statement-breakpoint
CREATE FUNCTION project_alert_task_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   UPDATE project_alerts SET resolved_at=clock_timestamp(),updated_at=clock_timestamp(),source_revision=source_revision+1
     WHERE chat_id=OLD.chat_id AND source IN ('task-review','task-blocker','agent') AND resolved_at IS NULL;
 ELSE
   PERFORM project_alert_project_task(NEW);
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_alert_task_changed AFTER INSERT OR UPDATE OR DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION project_alert_task_changed();
--> statement-breakpoint
CREATE FUNCTION project_alert_task_dispatch_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE was_pending boolean; is_pending boolean;
BEGIN
 was_pending := TG_OP<>'INSERT' AND OLD.state IN ('queued','claimed','running','paused');
 is_pending := TG_OP<>'DELETE' AND NEW.state IN ('queued','claimed','running','paused');
 IF was_pending IS DISTINCT FROM is_pending THEN
   UPDATE tasks SET alert_attention_epoch=alert_attention_epoch+1 WHERE chat_id=COALESCE(NEW.chat_id,OLD.chat_id) AND state='review';
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_alert_task_dispatch_changed AFTER INSERT OR UPDATE OF state OR DELETE ON task_dispatch_cycles FOR EACH ROW EXECUTE FUNCTION project_alert_task_dispatch_changed();
--> statement-breakpoint
DO $$ DECLARE t tasks;
BEGIN
 FOR t IN SELECT * FROM tasks WHERE state IN ('review','blocked','failed') LOOP
   PERFORM project_alert_project_task(t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION project_alert_agent_apply(p_owner text,p_chat text,p_worker text,p_lane text,e jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c chats;
BEGIN
 SELECT * INTO c FROM chats WHERE id=p_chat AND owner_id=p_owner FOR NO KEY UPDATE;
 IF c.id IS NULL OR c.project_id IS NULL OR c.archived_at IS NOT NULL OR c.managed_autonomy_stopped
   OR c.status NOT IN ('running','waiting-for-approval') THEN RETURN NULL; END IF;
 IF c.experience='task' AND NOT EXISTS (SELECT 1 FROM tasks WHERE chat_id=c.id AND state<>'complete') THEN RETURN NULL; END IF;
 IF NOT EXISTS (SELECT 1 FROM chat_execution_lanes WHERE id=p_lane AND chat_id=c.id AND worker_id=p_worker AND state='active') THEN RETURN NULL; END IF;
 IF e->>'source'<>'agent' OR e->>'sourceId'<>c.id OR e->>'chatId'<>c.id OR e->>'projectId'<>c.project_id THEN RETURN NULL; END IF;
 RETURN project_alert_apply(p_owner,e);
END;
$$;
--> statement-breakpoint
-- An observation of the native Goal, never an execution controller. Objective
-- text remains Chat ciphertext. The authenticated process identity and sequence fence
-- delayed deliveries and permit a genuinely restarted worker to reconcile.
CREATE TABLE chat_goal_observations (
 chat_id text PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
 worker_id text REFERENCES workers(id) ON DELETE SET NULL,
 thread_id text NOT NULL,
 source_generation text NOT NULL,
 source_revision bigint NOT NULL CHECK (source_revision BETWEEN 1 AND 9007199254740991),
 row_revision integer NOT NULL DEFAULT 1 CHECK (row_revision>0),
 attention_epoch integer NOT NULL DEFAULT 0 CHECK (attention_epoch>=0),
 snapshot jsonb NOT NULL,
 updated_at timestamptz(3) NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX chat_goal_observations_worker_idx ON chat_goal_observations(worker_id);
--> statement-breakpoint
CREATE FUNCTION project_alert_goal_worker_retired() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.worker_id IS NOT NULL AND NEW.worker_id IS NULL THEN
   UPDATE project_alerts SET resolved_at=clock_timestamp(),updated_at=clock_timestamp(),source_revision=source_revision+1
     WHERE chat_id=NEW.chat_id AND source='goal' AND resolved_at IS NULL;
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_alert_goal_worker_retired AFTER UPDATE OF worker_id ON chat_goal_observations FOR EACH ROW EXECUTE FUNCTION project_alert_goal_worker_retired();
--> statement-breakpoint
CREATE FUNCTION project_alert_goal_chats(p_owner text,p_worker text,p_after text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]'::jsonb) FROM (
   SELECT c.id FROM chats c LEFT JOIN chat_goal_observations o ON c.id=o.chat_id
   JOIN project_worktrees w ON w.id=c.active_worktree_id AND w.worker_id=p_worker
   WHERE c.owner_id=p_owner AND c.context_kind='project' AND c.experience='agent'
   AND c.archived_at IS NULL AND NOT c.managed_autonomy_stopped
   AND ((o.chat_id IS NOT NULL AND o.snapshot->'goal' IS DISTINCT FROM 'null'::jsonb AND o.snapshot->'goal'->>'status'<>'complete')
     OR (o.chat_id IS NULL AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.chat_id=c.id AND m.mode='goal')))
   AND (p_after IS NULL OR c.id>p_after) ORDER BY c.id LIMIT 100
 ) known;
$$;
--> statement-breakpoint
CREATE FUNCTION project_alert_execution_root_retired() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.active_worktree_id IS DISTINCT FROM OLD.active_worktree_id OR NEW.active_scratch_root_id IS DISTINCT FROM OLD.active_scratch_root_id THEN
   UPDATE project_alerts SET resolved_at=clock_timestamp(),updated_at=clock_timestamp(),source_revision=source_revision+1
     WHERE chat_id=NEW.id AND source IN ('interaction','goal','agent') AND resolved_at IS NULL;
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_alert_execution_root_retired AFTER UPDATE OF active_worktree_id,active_scratch_root_id ON chats FOR EACH ROW EXECUTE FUNCTION project_alert_execution_root_retired();
--> statement-breakpoint
CREATE FUNCTION project_alert_observe_goal(p_owner text,p_worker text,e jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c chats; previous chat_goal_observations; observed chat_goal_observations;
 needs_attention boolean; previous_attention boolean; episode text; goal jsonb; revision integer; epoch integer;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM workers WHERE id=p_worker AND owner_id=p_owner AND project_goal_generation=e->>'generation' FOR SHARE) THEN
   RETURN jsonb_build_object('accepted',false,'reason','retired-worker');
 END IF;
 SELECT * INTO c FROM chats WHERE id=e->>'chatId' AND owner_id=p_owner FOR NO KEY UPDATE;
 IF c.id IS NULL THEN RETURN jsonb_build_object('accepted',false,'reason','retired-chat'); END IF;
 IF c.context_kind<>'project' OR c.experience<>'agent' THEN RETURN jsonb_build_object('accepted',false,'reason','not-project-agent'); END IF;
 IF NOT EXISTS (SELECT 1 FROM chat_runtime_sessions r JOIN project_worktrees w ON w.id=c.active_worktree_id
   WHERE r.chat_id=c.id AND r.worker_id=p_worker AND w.worker_id=p_worker AND r.worktree_id=w.id AND r.codex_thread_id=e->>'threadId') THEN
   IF EXISTS (SELECT 1 FROM chat_runtime_sessions r JOIN project_worktrees w ON w.id=c.active_worktree_id
     WHERE r.chat_id=c.id AND r.worker_id=p_worker AND w.worker_id=p_worker AND r.worktree_id=w.id AND r.codex_thread_id IS NULL) THEN
     RETURN jsonb_build_object('accepted',false,'reason','unbound-thread');
   END IF;
   RETURN jsonb_build_object('accepted',false,'reason','retired-thread');
 END IF;
 SELECT * INTO previous FROM chat_goal_observations WHERE chat_id=c.id;
 IF previous.chat_id IS NOT NULL AND previous.worker_id=p_worker AND previous.thread_id=e->>'threadId'
   AND previous.source_generation=e->>'generation' AND previous.source_revision>=(e->>'revision')::bigint THEN
   RETURN jsonb_build_object('accepted',true);
 END IF;
 goal := e->'snapshot'->'goal';
 needs_attention := COALESCE(goal->>'status' IN ('blocked','usageLimited','budgetLimited'),false);
 previous_attention := COALESCE(previous.snapshot->'goal'->>'status' IN ('blocked','usageLimited','budgetLimited'),false);
 revision := COALESCE(previous.row_revision,0)+1;
 epoch := COALESCE(previous.attention_epoch,0);
 IF needs_attention AND (NOT previous_attention OR previous.worker_id IS DISTINCT FROM p_worker
   OR previous.thread_id IS DISTINCT FROM e->>'threadId'
   OR previous.snapshot->'goal'->'createdAt' IS DISTINCT FROM goal->'createdAt') THEN epoch := epoch+1; END IF;
 INSERT INTO chat_goal_observations(chat_id,worker_id,thread_id,source_generation,source_revision,row_revision,attention_epoch,snapshot,updated_at)
 VALUES (c.id,p_worker,e->>'threadId',e->>'generation',(e->>'revision')::bigint,revision,epoch,e->'snapshot',clock_timestamp())
 ON CONFLICT(chat_id) DO UPDATE SET worker_id=excluded.worker_id,thread_id=excluded.thread_id,
   source_generation=excluded.source_generation,source_revision=excluded.source_revision,row_revision=excluded.row_revision,
   attention_epoch=excluded.attention_epoch,snapshot=excluded.snapshot,updated_at=excluded.updated_at
 RETURNING * INTO observed;
 episode := observed.thread_id || ':' || epoch::text;
 UPDATE project_alerts SET resolved_at=clock_timestamp(),updated_at=clock_timestamp(),source_revision=source_revision+1
   WHERE chat_id=c.id AND source='goal' AND resolved_at IS NULL
     AND (NOT needs_attention OR episode_id<>episode OR c.archived_at IS NOT NULL OR c.managed_autonomy_stopped);
 IF needs_attention THEN
   PERFORM project_alert_apply(p_owner,jsonb_build_object('projectId',c.project_id,'chatId',c.id,'source','goal',
     'sourceId',c.id,'episodeId',episode,'sourceRevision',revision,'kind','goal-stalled','priority',1,
     'status',CASE WHEN c.archived_at IS NOT NULL OR c.managed_autonomy_stopped THEN 'resolved' ELSE 'open' END,
     'target',jsonb_build_object('kind','goal','chatId',c.id,'threadId',observed.thread_id),
     'occurredAt',to_timestamp((goal->>'updatedAt')::double precision)));
 END IF;
 RETURN jsonb_build_object('accepted',true);
END;
$$;
