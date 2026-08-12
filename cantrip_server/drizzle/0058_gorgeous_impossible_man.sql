DROP INDEX "project_sources_project_worker_unique";--> statement-breakpoint
ALTER TABLE "project_replica_jobs" ADD COLUMN "synchronization_policy" text;--> statement-breakpoint
ALTER TABLE "project_replica_jobs" ADD COLUMN "delete_local_files" boolean;--> statement-breakpoint
ALTER TABLE "project_sources" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "project_sources_project_worker_unique" ON "project_sources" USING btree ("project_id","worker_id") WHERE "project_sources"."removed_at" IS NULL;