ALTER TABLE "workspace_repository_discovery_jobs" DROP CONSTRAINT "workspace_repository_discovery_jobs_depth_check";
--> statement-breakpoint
ALTER TABLE "workspace_repository_discovery_jobs" ALTER COLUMN "depth" SET DEFAULT -1;
--> statement-breakpoint
ALTER TABLE "workspace_repository_discovery_jobs" ADD CONSTRAINT "workspace_repository_discovery_jobs_depth_check" CHECK ("depth" >= -1 AND "depth" <= 16);
