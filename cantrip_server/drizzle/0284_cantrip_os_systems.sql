CREATE TABLE cantrip_os_system_targets (
    instance_id text PRIMARY KEY REFERENCES cantrip_os_instances(id) ON DELETE CASCADE,
    attachment_generation text NOT NULL,
    observation_epoch integer NOT NULL DEFAULT 0,
    catalog_power_epoch integer,
    catalog jsonb,
    verified_at timestamptz
);
--> statement-breakpoint
CREATE TABLE cantrip_os_system_operations (
    operation_id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    worker_id text NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    instance_id text NOT NULL REFERENCES cantrip_os_instances(id) ON DELETE CASCADE,
    attachment_generation text NOT NULL,
    target_generation text NOT NULL,
    fence_generation text NOT NULL,
    admission_epoch integer NOT NULL,
    dispatch_stage text NOT NULL DEFAULT 'preparing' CHECK (dispatch_stage IN ('preparing','executing')),
    state text NOT NULL DEFAULT 'admitted' CHECK (state IN ('admitted','running','ready','failed','unknown','rejected')),
    request jsonb NOT NULL,
    command jsonb NOT NULL,
    revision integer NOT NULL DEFAULT 0,
    retired_by text,
    recovery_generation text,
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX cantrip_os_system_owner_created_index ON cantrip_os_system_operations(owner_id,instance_id,created_at,operation_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION cantrip_os_attachment_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'cantrip_os_instances' THEN
    IF TG_OP = 'UPDATE' THEN
      IF ROW(NEW.id, NEW.owner_id, NEW.worker_id) IS DISTINCT FROM ROW(OLD.id, OLD.owner_id, OLD.worker_id) THEN
        RAISE EXCEPTION 'OS instance identity is immutable';
      END IF;
      IF NEW.guest_instance_id IS DISTINCT FROM OLD.guest_instance_id AND NOT EXISTS (
        SELECT 1 FROM cantrip_os_system_operations o
        JOIN cantrip_os_system_targets t ON t.instance_id=o.instance_id
        WHERE o.instance_id=OLD.id AND o.owner_id=NEW.owner_id AND o.worker_id=NEW.worker_id
          AND o.state='ready' AND o.retired_by IS NULL AND o.request->>'action' IN ('replace','rollback')
          AND o.fence_generation=OLD.attachment_generation AND o.recovery_generation=NEW.attachment_generation
          AND NEW.attachment_generation<>OLD.attachment_generation
          AND jsonb_typeof(o.result->'protectedResult')='object'
          AND t.attachment_generation=NEW.attachment_generation AND t.verified_at IS NOT NULL
          AND t.catalog->'target'->>'containerId'=o.result->'root'->>'targetContainerId'
          AND t.catalog->'target'->>'identityEvidence'='guest-identity'
          AND t.catalog->'target'->'expected'->>'ownerId'=NEW.owner_id
          AND t.catalog->'target'->'expected'->>'workerId'=NEW.worker_id
          AND t.catalog->'target'->'expected'->>'guestInstanceId'=NEW.guest_instance_id
      ) THEN RAISE EXCEPTION 'OS instance identity is immutable'; END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM workers WHERE id=NEW.worker_id AND owner_id=NEW.owner_id) THEN
      RAISE EXCEPTION 'OS instance worker owner mismatch';
    END IF;
  ELSE
    IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.instance_id,NEW.guest_workspace_id,NEW.uid,NEW.gid,NEW.home_guest_path)
      IS DISTINCT FROM ROW(OLD.id,OLD.instance_id,OLD.guest_workspace_id,OLD.uid,OLD.gid,OLD.home_guest_path) THEN
      RAISE EXCEPTION 'OS workspace identity is immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
