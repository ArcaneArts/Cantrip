-- Physical checkout ownership is independent of an execution binding. Existing
-- project_sources rows and their paths remain worker-local.
CREATE TABLE project_source_identities (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worker_id text NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  location_kind text NOT NULL,
  CONSTRAINT project_source_identities_kind_check CHECK (location_kind IN ('worker-local', 'cantrip-os'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX project_source_identities_id_kind_unique ON project_source_identities(id, location_kind);
--> statement-breakpoint
CREATE INDEX project_source_identities_project_worker_index ON project_source_identities(project_id, worker_id);
--> statement-breakpoint
INSERT INTO project_source_identities(id, project_id, worker_id, location_kind)
SELECT id, project_id, worker_id, 'worker-local' FROM project_sources;
--> statement-breakpoint
CREATE FUNCTION cantrip_source_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.project_id, NEW.worker_id, NEW.location_kind)
    IS DISTINCT FROM ROW(OLD.id, OLD.project_id, OLD.worker_id, OLD.location_kind) THEN
    RAISE EXCEPTION 'source identity is immutable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM projects p JOIN workers w ON w.owner_id = p.owner_id
    WHERE p.id = NEW.project_id AND w.id = NEW.worker_id) THEN
    RAISE EXCEPTION 'source project and worker must share an owner';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER project_source_identity_immutable BEFORE INSERT OR UPDATE ON project_source_identities
FOR EACH ROW EXECUTE FUNCTION cantrip_source_identity_immutable();
--> statement-breakpoint
-- Register old TS and Rust writers without changing their local path contract.
CREATE FUNCTION cantrip_register_local_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO project_source_identities(id, project_id, worker_id, location_kind)
    VALUES (NEW.id, NEW.project_id, NEW.worker_id, 'worker-local') ON CONFLICT (id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM project_source_identities i WHERE i.id = NEW.id
    AND i.project_id = NEW.project_id AND i.worker_id = NEW.worker_id AND i.location_kind = 'worker-local') THEN
    RAISE EXCEPTION 'worker-local source identity mismatch';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.project_id, NEW.worker_id)
    IS DISTINCT FROM ROW(OLD.id, OLD.project_id, OLD.worker_id) THEN
    RAISE EXCEPTION 'source identity is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER project_source_register_local BEFORE INSERT OR UPDATE ON project_sources
FOR EACH ROW EXECUTE FUNCTION cantrip_register_local_source();
--> statement-breakpoint
ALTER TABLE project_sources ADD CONSTRAINT project_sources_id_project_source_identities_id_fk
  FOREIGN KEY (id) REFERENCES project_source_identities(id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE FUNCTION cantrip_delete_source_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- During an identity cascade the parent row is already absent. A direct
  -- detail deletion must still remove its worktrees, as it did before migration.
  DELETE FROM project_source_identities WHERE id = OLD.id;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER project_source_delete_identity AFTER DELETE ON project_sources
FOR EACH ROW EXECUTE FUNCTION cantrip_delete_source_identity();
--> statement-breakpoint
ALTER TABLE project_worktrees DROP CONSTRAINT project_worktrees_project_source_id_project_sources_id_fk;
--> statement-breakpoint
ALTER TABLE project_worktrees ADD CONSTRAINT project_worktrees_project_source_id_project_source_identities_id_fk
  FOREIGN KEY (project_source_id) REFERENCES project_source_identities(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE project_worktrees ADD COLUMN location_kind text NOT NULL DEFAULT 'worker-local';
--> statement-breakpoint
ALTER TABLE project_worktrees ADD COLUMN guest_path text;
--> statement-breakpoint
ALTER TABLE project_worktrees ALTER COLUMN absolute_path DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE project_worktrees ADD CONSTRAINT project_worktrees_source_location_fk
  FOREIGN KEY (project_source_id, location_kind) REFERENCES project_source_identities(id, location_kind) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE project_worktrees ADD CONSTRAINT project_worktrees_location_shape_check CHECK (
  (location_kind = 'worker-local' AND absolute_path IS NOT NULL AND guest_path IS NULL) OR
  (location_kind = 'cantrip-os' AND absolute_path IS NULL AND guest_path IS NOT NULL AND left(guest_path, 1) = '/')
);
--> statement-breakpoint
CREATE UNIQUE INDEX project_worktrees_source_guest_path_unique ON project_worktrees(project_source_id, guest_path);
--> statement-breakpoint
ALTER TABLE project_github_conversion_jobs DROP CONSTRAINT project_github_conversion_jobs_project_source_id_project_sources_id_fk;
--> statement-breakpoint
ALTER TABLE project_github_conversion_jobs ADD CONSTRAINT project_github_conversion_jobs_project_source_id_project_source_identities_id_fk
  FOREIGN KEY (project_source_id) REFERENCES project_source_identities(id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE FUNCTION cantrip_worktree_source_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM project_source_identities i
    WHERE i.id = NEW.project_source_id AND i.worker_id = NEW.worker_id AND i.location_kind = NEW.location_kind) THEN
    RAISE EXCEPTION 'worktree source and worker mismatch';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER project_worktree_source_scope BEFORE INSERT OR UPDATE ON project_worktrees
FOR EACH ROW EXECUTE FUNCTION cantrip_worktree_source_scope();
--> statement-breakpoint
CREATE TABLE cantrip_os_instances (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worker_id text NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  guest_instance_id text NOT NULL,
  attachment_generation text NOT NULL,
  transport jsonb NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'unknown',
  runtime_generation text,
  last_error text,
  last_observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cantrip_os_instances_status_check CHECK (status IN ('connected', 'disconnected', 'unknown')),
  CONSTRAINT cantrip_os_instances_connected_generation_check CHECK (status <> 'connected' OR runtime_generation IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX cantrip_os_instances_worker_guest_unique ON cantrip_os_instances(worker_id, guest_instance_id);
--> statement-breakpoint
CREATE TABLE cantrip_os_workspaces (
  id text PRIMARY KEY,
  instance_id text NOT NULL REFERENCES cantrip_os_instances(id) ON DELETE CASCADE,
  guest_workspace_id text NOT NULL,
  uid integer NOT NULL,
  gid integer NOT NULL,
  home_guest_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cantrip_os_workspaces_uid_check CHECK (uid > 0 AND gid > 0),
  CONSTRAINT cantrip_os_workspaces_home_check CHECK (left(home_guest_path, 1) = '/')
);
--> statement-breakpoint
CREATE UNIQUE INDEX cantrip_os_workspaces_instance_guest_unique ON cantrip_os_workspaces(instance_id, guest_workspace_id);
--> statement-breakpoint
CREATE UNIQUE INDEX cantrip_os_workspaces_instance_uid_unique ON cantrip_os_workspaces(instance_id, uid);
--> statement-breakpoint
CREATE FUNCTION cantrip_os_attachment_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'cantrip_os_instances' THEN
    IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.owner_id, NEW.worker_id, NEW.guest_instance_id)
      IS DISTINCT FROM ROW(OLD.id, OLD.owner_id, OLD.worker_id, OLD.guest_instance_id) THEN
      RAISE EXCEPTION 'OS instance identity is immutable';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM workers WHERE id = NEW.worker_id AND owner_id = NEW.owner_id) THEN
      RAISE EXCEPTION 'OS instance worker owner mismatch';
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.instance_id, NEW.guest_workspace_id, NEW.uid, NEW.gid, NEW.home_guest_path)
      IS DISTINCT FROM ROW(OLD.id, OLD.instance_id, OLD.guest_workspace_id, OLD.uid, OLD.gid, OLD.home_guest_path) THEN
      RAISE EXCEPTION 'OS workspace identity is immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER cantrip_os_instance_scope BEFORE INSERT OR UPDATE ON cantrip_os_instances
FOR EACH ROW EXECUTE FUNCTION cantrip_os_attachment_scope();
--> statement-breakpoint
CREATE TRIGGER cantrip_os_workspace_scope BEFORE INSERT OR UPDATE ON cantrip_os_workspaces
FOR EACH ROW EXECUTE FUNCTION cantrip_os_attachment_scope();
--> statement-breakpoint
CREATE TABLE cantrip_os_project_sources (
  id text PRIMARY KEY REFERENCES project_source_identities(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES cantrip_os_workspaces(id) ON DELETE RESTRICT,
  source_kind text NOT NULL,
  guest_path text NOT NULL,
  ownership_kind text NOT NULL,
  repository_fingerprint text,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cantrip_os_project_sources_kind_check CHECK (source_kind IN ('git', 'folder')),
  CONSTRAINT cantrip_os_project_sources_ownership_check CHECK (ownership_kind IN ('cantrip', 'user')),
  CONSTRAINT cantrip_os_project_sources_guest_path_check CHECK (left(guest_path, 1) = '/')
);
--> statement-breakpoint
CREATE UNIQUE INDEX cantrip_os_project_sources_workspace_path_unique ON cantrip_os_project_sources(workspace_id, guest_path) WHERE removed_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER cantrip_os_source_delete_identity AFTER DELETE ON cantrip_os_project_sources
FOR EACH ROW EXECUTE FUNCTION cantrip_delete_source_identity();
--> statement-breakpoint
CREATE FUNCTION cantrip_os_source_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.workspace_id) IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id) THEN
    RAISE EXCEPTION 'OS source identity is immutable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM project_source_identities s
    JOIN cantrip_os_workspaces w ON w.id = NEW.workspace_id
    JOIN cantrip_os_instances i ON i.id = w.instance_id AND i.worker_id = s.worker_id
    JOIN projects p ON p.id = s.project_id AND p.owner_id = i.owner_id
    WHERE s.id = NEW.id AND s.location_kind = 'cantrip-os') THEN
    RAISE EXCEPTION 'OS source workspace scope mismatch';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER cantrip_os_source_scope BEFORE INSERT OR UPDATE ON cantrip_os_project_sources
FOR EACH ROW EXECUTE FUNCTION cantrip_os_source_scope();
--> statement-breakpoint
CREATE TABLE cantrip_os_source_bindings (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worker_id text NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  project_source_id text NOT NULL REFERENCES project_source_identities(id) ON DELETE CASCADE,
  worktree_id text NOT NULL REFERENCES project_worktrees(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES cantrip_os_workspaces(id) ON DELETE RESTRICT,
  mode text NOT NULL,
  linked_worker_path text,
  guest_path text NOT NULL,
  binding_generation text NOT NULL,
  provisioned_attachment_generation text,
  provisioned_runtime_generation text,
  state text NOT NULL,
  last_error text,
  dependency_overlays jsonb NOT NULL DEFAULT '[]'::jsonb,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cantrip_os_bindings_mode_check CHECK ((mode = 'linked' AND linked_worker_path IS NOT NULL) OR (mode = 'linux-owned' AND linked_worker_path IS NULL)),
  CONSTRAINT cantrip_os_bindings_state_check CHECK (state IN ('provisioning', 'ready', 'failed', 'unknown', 'retired')),
  CONSTRAINT cantrip_os_bindings_ready_generation_check CHECK (state <> 'ready' OR (provisioned_attachment_generation IS NOT NULL AND provisioned_runtime_generation IS NOT NULL)),
  CONSTRAINT cantrip_os_bindings_retirement_check CHECK ((state = 'retired') = (retired_at IS NOT NULL)),
  CONSTRAINT cantrip_os_bindings_guest_path_check CHECK (left(guest_path, 1) = '/'),
  CONSTRAINT cantrip_os_bindings_overlays_check CHECK (jsonb_typeof(dependency_overlays) = 'array' AND jsonb_array_length(dependency_overlays) <= 32)
);
--> statement-breakpoint
CREATE UNIQUE INDEX cantrip_os_bindings_worktree_workspace_unique ON cantrip_os_source_bindings(worktree_id, workspace_id) WHERE retired_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION cantrip_os_binding_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.owner_id, NEW.project_id, NEW.worker_id, NEW.project_source_id,
    NEW.worktree_id, NEW.workspace_id, NEW.mode, NEW.linked_worker_path, NEW.guest_path, NEW.binding_generation, NEW.dependency_overlays)
    IS DISTINCT FROM ROW(OLD.id, OLD.owner_id, OLD.project_id, OLD.worker_id, OLD.project_source_id,
    OLD.worktree_id, OLD.workspace_id, OLD.mode, OLD.linked_worker_path, OLD.guest_path, OLD.binding_generation, OLD.dependency_overlays) THEN
    RAISE EXCEPTION 'OS binding placement is immutable; retire it and create a new generation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.state = 'retired' AND NEW.state <> 'retired' THEN
    RAISE EXCEPTION 'retired OS bindings cannot be reactivated';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.state = 'retired' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM project_source_identities s
    JOIN projects p ON p.id = s.project_id
    JOIN project_worktrees t ON t.id = NEW.worktree_id AND t.project_source_id = s.id AND t.worker_id = s.worker_id
    JOIN cantrip_os_workspaces w ON w.id = NEW.workspace_id
    JOIN cantrip_os_instances i ON i.id = w.instance_id AND i.worker_id = s.worker_id AND i.owner_id = p.owner_id
    WHERE s.id = NEW.project_source_id AND s.project_id = NEW.project_id AND s.worker_id = NEW.worker_id
      AND p.owner_id = NEW.owner_id
      AND (NEW.state <> 'ready' OR (i.status = 'connected' AND i.attachment_generation = NEW.provisioned_attachment_generation AND i.runtime_generation = NEW.provisioned_runtime_generation))
      AND ((NEW.mode = 'linked' AND s.location_kind = 'worker-local' AND i.transport->>'kind' = 'docker' AND t.absolute_path = NEW.linked_worker_path
          AND EXISTS (SELECT 1 FROM project_sources local WHERE local.id = s.id AND local.removed_at IS NULL))
        OR (NEW.mode = 'linux-owned' AND s.location_kind = 'cantrip-os' AND t.guest_path = NEW.guest_path
          AND EXISTS (SELECT 1 FROM cantrip_os_project_sources os WHERE os.id = s.id AND os.workspace_id = w.id AND os.removed_at IS NULL)))) THEN
    RAISE EXCEPTION 'OS binding source, worktree, owner, worker or workspace mismatch';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER cantrip_os_binding_scope BEFORE INSERT OR UPDATE ON cantrip_os_source_bindings
FOR EACH ROW EXECUTE FUNCTION cantrip_os_binding_scope();
