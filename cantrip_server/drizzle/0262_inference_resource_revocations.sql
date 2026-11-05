CREATE TABLE inference_resource_revocations (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worker_id text NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX inference_resource_revocations_worker_idx
  ON inference_resource_revocations(owner_id, worker_id, created_at, id);
--> statement-breakpoint
CREATE FUNCTION inference_resource_revocation_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('cantrip_inference_resource_revocations',
    json_build_object('ownerId', NEW.owner_id, 'workerId', NEW.worker_id)::text);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inference_resource_revocations_notify
AFTER INSERT ON inference_resource_revocations
FOR EACH ROW EXECUTE FUNCTION inference_resource_revocation_notify();
--> statement-breakpoint
CREATE FUNCTION inference_resource_capture_removal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Account deletion has already removed the owner before its cascades run.
  -- There is no authenticated destination left for new cleanup deliveries.
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.owner_id) THEN
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'projects' THEN
    -- DELETE holds the actual parent row lock. A concurrent chat FK insertion
    -- cannot commit past this capture and escape the parent's deletion.
    WITH grouped AS (
      SELECT id, (row_number() OVER (ORDER BY id) - 1) / 1000 AS batch
      FROM chats WHERE project_id = OLD.id
    ), batches AS (
      SELECT batch, jsonb_agg(id ORDER BY id) AS chat_ids FROM grouped GROUP BY batch
      UNION ALL SELECT 0, '[]'::jsonb WHERE NOT EXISTS (SELECT 1 FROM grouped)
    )
    INSERT INTO inference_resource_revocations(owner_id, worker_id, target)
      SELECT OLD.owner_id, w.id,
        jsonb_build_object('kind', 'project', 'projectId', OLD.id, 'chatIds', b.chat_ids)
      FROM workers w CROSS JOIN batches b WHERE w.owner_id = OLD.owner_id;
  ELSE
    -- The project's own trigger already captured a cascading chat deletion.
    -- Ordinary Task/chat deletion still owns a live parent, or is standalone.
    IF OLD.project_id IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id) THEN
      INSERT INTO inference_resource_revocations(owner_id, worker_id, target)
        SELECT OLD.owner_id, w.id, jsonb_build_object('kind', 'chat', 'chatId', OLD.id)
        FROM workers w WHERE w.owner_id = OLD.owner_id;
    END IF;
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inference_resource_project_removal
BEFORE DELETE ON projects FOR EACH ROW EXECUTE FUNCTION inference_resource_capture_removal();
--> statement-breakpoint
CREATE TRIGGER inference_resource_chat_removal
BEFORE DELETE ON chats FOR EACH ROW EXECUTE FUNCTION inference_resource_capture_removal();
