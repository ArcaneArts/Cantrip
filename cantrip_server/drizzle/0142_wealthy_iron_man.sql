ALTER TABLE "workers" ALTER COLUMN "project_replica_capabilities" SET DEFAULT '{"provision":false,"synchronize":false,"remove":false,"exactRevision":false,"directPlacement":false,"managedLinkPlacement":false,"attachExisting":false,"recursiveParentCreation":false}'::jsonb;--> statement-breakpoint
UPDATE "workers"
SET "project_replica_capabilities" = '{"directPlacement":false,"managedLinkPlacement":false,"attachExisting":false,"recursiveParentCreation":false}'::jsonb || "project_replica_capabilities";--> statement-breakpoint
ALTER TABLE "project_replica_jobs" ADD COLUMN "placement_mode" text DEFAULT 'managed' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_replica_jobs" ADD COLUMN "placement_path" text;--> statement-breakpoint
ALTER TABLE "project_replica_jobs" ADD COLUMN "resolved_materialization" text;--> statement-breakpoint
ALTER TABLE "project_replica_jobs" ADD COLUMN "resolved_ownership" text;--> statement-breakpoint
ALTER TABLE "project_sources" ADD COLUMN "placement_mode" text DEFAULT 'managed' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_sources" ADD COLUMN "ownership_kind" text DEFAULT 'cantrip' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_sources" ADD COLUMN "requested_path" text;--> statement-breakpoint
ALTER TABLE "project_sources" ADD COLUMN "link_path" text;--> statement-breakpoint
ALTER TABLE "project_replica_jobs" ADD CONSTRAINT "project_replica_jobs_placement_mode_check" CHECK ("project_replica_jobs"."placement_mode" IN ('managed', 'managed-link', 'direct'));--> statement-breakpoint
ALTER TABLE "project_replica_jobs" ADD CONSTRAINT "project_replica_jobs_placement_path_check" CHECK (("project_replica_jobs"."placement_mode" = 'managed' AND "project_replica_jobs"."placement_path" IS NULL) OR ("project_replica_jobs"."placement_mode" IN ('managed-link', 'direct') AND "project_replica_jobs"."placement_path" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "project_replica_jobs" ADD CONSTRAINT "project_replica_jobs_materialization_check" CHECK ("project_replica_jobs"."resolved_materialization" IS NULL OR "project_replica_jobs"."resolved_materialization" IN ('cloned', 'reused', 'attached'));--> statement-breakpoint
ALTER TABLE "project_replica_jobs" ADD CONSTRAINT "project_replica_jobs_ownership_check" CHECK ("project_replica_jobs"."resolved_ownership" IS NULL OR "project_replica_jobs"."resolved_ownership" IN ('cantrip', 'user'));--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_placement_mode_check" CHECK ("project_sources"."placement_mode" IN ('managed', 'managed-link', 'direct'));--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_ownership_kind_check" CHECK ("project_sources"."ownership_kind" IN ('cantrip', 'user'));--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_placement_paths_check" CHECK (("project_sources"."placement_mode" = 'managed' AND "project_sources"."requested_path" IS NULL AND "project_sources"."link_path" IS NULL) OR ("project_sources"."placement_mode" = 'managed-link' AND "project_sources"."requested_path" IS NOT NULL AND "project_sources"."link_path" IS NOT NULL) OR ("project_sources"."placement_mode" = 'direct' AND "project_sources"."requested_path" IS NOT NULL AND "project_sources"."link_path" IS NULL));
