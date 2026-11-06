ALTER TABLE cantrip_os_workspaces ADD COLUMN desktop_epoch integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE cantrip_os_desktop_targets (
    workspace_id text PRIMARY KEY REFERENCES cantrip_os_workspaces(id) ON DELETE CASCADE,
    generation text NOT NULL,
    attachment_generation text NOT NULL,
    runtime_generation text NOT NULL,
    snapshot jsonb NOT NULL,
    verified_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE cantrip_os_desktop_operations (
    operation_id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    worker_id text NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    instance_id text NOT NULL REFERENCES cantrip_os_instances(id) ON DELETE CASCADE,
    workspace_id text NOT NULL REFERENCES cantrip_os_workspaces(id) ON DELETE CASCADE,
    runtime_generation text NOT NULL,
    attachment_generation text NOT NULL,
    target_generation text NOT NULL,
    action text NOT NULL CHECK (action IN ('start','stop','restart')),
    state text NOT NULL DEFAULT 'admitted' CHECK (state IN ('admitted','running','ready','failed','unknown')),
    request jsonb NOT NULL,
    command jsonb NOT NULL,
    revision integer NOT NULL DEFAULT 0,
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX cantrip_os_desktop_owner_created_index ON cantrip_os_desktop_operations(owner_id,workspace_id,created_at,operation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX cantrip_os_desktop_active_target_unique ON cantrip_os_desktop_operations(workspace_id,attachment_generation,runtime_generation,target_generation) WHERE state IN ('admitted','running','unknown');
