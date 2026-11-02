CREATE TABLE project_alerts (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chat_id text REFERENCES chats(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('interaction','task-review','task-blocker','goal','agent')),
  source_id text NOT NULL,
  episode_id text NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision > 0),
  kind text NOT NULL CHECK (kind IN ('permission','user-input','task-questions','plan-ready','blocked','goal-stalled','action-required')),
  priority integer NOT NULL CHECK (priority BETWEEN 0 AND 2),
  target jsonb NOT NULL,
  protected_detail jsonb,
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  resolved_at timestamptz(3),
  CONSTRAINT project_alerts_episode_unique UNIQUE (owner_id,project_id,source,source_id,episode_id),
  CHECK (protected_detail IS NULL OR source = 'agent'),
  CHECK (source <> 'agent' OR (chat_id IS NOT NULL AND protected_detail IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX project_alerts_active_page_idx ON project_alerts(owner_id,project_id,priority,created_at DESC,id) WHERE resolved_at IS NULL;
--> statement-breakpoint
CREATE INDEX project_alerts_chat_idx ON project_alerts(chat_id) WHERE resolved_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION project_alert_wire(a project_alerts) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('id',a.id,'projectId',a.project_id,'chatId',a.chat_id,
 'source',a.source,'sourceId',a.source_id,'episodeId',a.episode_id,'sourceRevision',a.source_revision,
 'kind',a.kind,'priority',a.priority,'status',CASE WHEN a.resolved_at IS NULL THEN 'open' ELSE 'resolved' END,
 'target',a.target,'protectedDetail',a.protected_detail,
 'createdAt',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'updatedAt',to_char(a.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'resolvedAt',to_char(a.resolved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
$$;
--> statement-breakpoint
-- Internal projection operation, deliberately not a public mutation endpoint.
-- Terminal rows are tombstones: reopening requires a new source episode.
CREATE FUNCTION project_alert_apply(p_owner text, e jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result project_alerts; alert_id text;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM projects WHERE id=e->>'projectId' AND owner_id=p_owner) THEN RETURN NULL; END IF;
 IF e->>'chatId' IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM chats WHERE id=e->>'chatId' AND owner_id=p_owner AND project_id=e->>'projectId'
     AND (archived_at IS NULL OR e->>'status'='resolved')
 ) THEN RETURN NULL; END IF;
 alert_id := 'alert_' || encode(sha256(convert_to(jsonb_build_array(p_owner,e->>'projectId',e->>'source',e->>'sourceId',e->>'episodeId')::text,'UTF8')),'hex');
 INSERT INTO project_alerts AS current (id,owner_id,project_id,chat_id,source,source_id,episode_id,source_revision,kind,priority,target,protected_detail,created_at,updated_at,resolved_at)
 VALUES (alert_id,p_owner,e->>'projectId',e->>'chatId',e->>'source',e->>'sourceId',e->>'episodeId',(e->>'sourceRevision')::integer,e->>'kind',COALESCE((e->>'priority')::integer,1),e->'target',NULLIF(e->'protectedDetail','null'::jsonb),(e->>'occurredAt')::timestamptz,clock_timestamp(),CASE WHEN e->>'status'='resolved' THEN clock_timestamp() END)
 ON CONFLICT (owner_id,project_id,source,source_id,episode_id) DO UPDATE SET
 source_revision=excluded.source_revision,kind=excluded.kind,priority=excluded.priority,target=excluded.target,
 protected_detail=excluded.protected_detail,updated_at=clock_timestamp(),resolved_at=excluded.resolved_at
 WHERE excluded.source_revision > current.source_revision AND current.resolved_at IS NULL
 RETURNING * INTO result;
 IF result.id IS NULL THEN SELECT * INTO result FROM project_alerts WHERE id=alert_id; END IF;
 RETURN project_alert_wire(result);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION project_alert_counts(p_owner text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('projectId',project_id,'count',total) ORDER BY project_id),'[]'::jsonb)
 FROM (SELECT a.project_id,count(*)::integer total FROM project_alerts a
 JOIN projects p ON p.id=a.project_id AND p.owner_id=a.owner_id
 LEFT JOIN chats c ON c.id=a.chat_id AND c.owner_id=a.owner_id AND c.project_id=a.project_id
 WHERE a.owner_id=p_owner AND a.resolved_at IS NULL AND (a.chat_id IS NULL OR (c.id IS NOT NULL AND c.archived_at IS NULL)) GROUP BY a.project_id) counts;
$$;
--> statement-breakpoint
CREATE FUNCTION project_alert_page(p_owner text,p_project text,p_limit integer,p_after text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE anchor project_alerts; result jsonb;
BEGIN
 IF p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'Invalid alert page limit'; END IF;
 IF NOT EXISTS (SELECT 1 FROM projects WHERE id=p_project AND owner_id=p_owner) THEN RETURN NULL; END IF;
 IF p_after IS NOT NULL THEN
   SELECT * INTO anchor FROM project_alerts WHERE id=p_after AND owner_id=p_owner AND project_id=p_project;
   IF anchor.id IS NULL THEN RETURN NULL; END IF;
 END IF;
 WITH eligible AS (
   SELECT a.* FROM project_alerts a
   LEFT JOIN chats c ON c.id=a.chat_id AND c.owner_id=a.owner_id AND c.project_id=a.project_id
   WHERE a.owner_id=p_owner AND a.project_id=p_project AND a.resolved_at IS NULL
   AND (a.chat_id IS NULL OR (c.id IS NOT NULL AND c.archived_at IS NULL))
   AND (p_after IS NULL OR a.priority > anchor.priority OR (a.priority=anchor.priority AND
     (a.created_at < anchor.created_at OR (a.created_at=anchor.created_at AND a.id > anchor.id))))
   ORDER BY a.priority,a.created_at DESC,a.id LIMIT p_limit+1
 ), numbered AS (SELECT e.*,row_number() OVER(ORDER BY priority,created_at DESC,id) n FROM eligible e)
 SELECT jsonb_build_object('items',COALESCE(jsonb_agg(project_alert_wire(a) ORDER BY (a).priority,(a).created_at DESC,(a).id) FILTER(WHERE n<=p_limit),'[]'::jsonb),
 'nextCursor',CASE WHEN count(*)>p_limit THEN max((a).id) FILTER(WHERE n=p_limit) END) INTO result
 FROM (SELECT (id,owner_id,project_id,chat_id,source,source_id,episode_id,source_revision,kind,priority,target,protected_detail,created_at,updated_at,resolved_at)::project_alerts a,n FROM numbered) r;
 RETURN result;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION project_alert_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('cantrip_project_alerts',jsonb_build_object('ownerId',COALESCE(NEW.owner_id,OLD.owner_id),'projectId',COALESCE(NEW.project_id,OLD.project_id))::text);
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_alerts_changed AFTER INSERT OR UPDATE OR DELETE ON project_alerts FOR EACH ROW EXECUTE FUNCTION project_alert_notify();
