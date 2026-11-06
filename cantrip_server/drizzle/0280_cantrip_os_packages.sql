CREATE TABLE cantrip_os_package_targets (
    instance_id text PRIMARY KEY REFERENCES cantrip_os_instances(id) ON DELETE CASCADE,
    attachment_generation text NOT NULL,
    observation_epoch integer NOT NULL DEFAULT 0,
    catalog_power_epoch integer,
    catalog jsonb,
    verified_at timestamptz
);
--> statement-breakpoint
CREATE TABLE cantrip_os_package_operations (
    operation_id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    worker_id text NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    instance_id text NOT NULL REFERENCES cantrip_os_instances(id) ON DELETE CASCADE,
    attachment_generation text NOT NULL,
    target_generation text NOT NULL,
    admission_epoch integer NOT NULL,
    state text NOT NULL DEFAULT 'admitted' CHECK (state IN ('admitted','running','ready','failed','unknown')),
    request jsonb NOT NULL,
    command jsonb NOT NULL,
    revision integer NOT NULL DEFAULT 0,
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX cantrip_os_package_owner_created_index ON cantrip_os_package_operations(owner_id,instance_id,created_at,operation_id);
