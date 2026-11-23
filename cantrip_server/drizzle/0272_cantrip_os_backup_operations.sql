ALTER TABLE cantrip_os_project_sources ADD COLUMN git_common_guest_path text;
--> statement-breakpoint
ALTER TABLE cantrip_os_project_sources ADD CONSTRAINT cantrip_os_project_sources_git_common_check CHECK (git_common_guest_path IS NULL OR left(git_common_guest_path,1)='/');
--> statement-breakpoint
CREATE TABLE cantrip_os_backup_operations (
 operation_id text PRIMARY KEY,
 owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 worker_id text NOT NULL REFERENCES workers(id) ON DELETE RESTRICT,
 instance_id text NOT NULL REFERENCES cantrip_os_instances(id) ON DELETE RESTRICT,
 workspace_id text NOT NULL REFERENCES cantrip_os_workspaces(id) ON DELETE RESTRICT,
 action text NOT NULL,
 backup_id text REFERENCES cantrip_os_backup_operations(operation_id) ON DELETE RESTRICT,
 restore_operation_id text REFERENCES cantrip_os_backup_operations(operation_id) ON DELETE RESTRICT,
 request jsonb NOT NULL,
 command jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 0 CONSTRAINT cantrip_os_backup_revision_check CHECK (revision >= 0),
 continuation_scope jsonb,
 result jsonb,
 created_at timestamp with time zone NOT NULL DEFAULT now(),
 updated_at timestamp with time zone NOT NULL DEFAULT now(),
 CONSTRAINT cantrip_os_backup_action_check CHECK (
  (action='capture' AND backup_id IS NULL AND restore_operation_id IS NULL) OR
  (action='restore' AND backup_id IS NOT NULL AND restore_operation_id IS NULL) OR
  (action='rollback' AND backup_id IS NULL AND restore_operation_id IS NOT NULL)
 )
);
--> statement-breakpoint
CREATE INDEX cantrip_os_backup_operations_owner_created_index ON cantrip_os_backup_operations(owner_id,created_at,operation_id);
