-- Pre-release cutover: migration 0123 removed project-domain rows. Repository
-- identity now uses a keyed blind index for equality and worker-owned opaque
-- routing handles for the actual GitHub id, name, URL, and setup values.
ALTER TABLE "projects" DROP CONSTRAINT "projects_managed_folder_identity_check";--> statement-breakpoint
DROP INDEX "project_github_conversion_jobs_repository_active_unique";--> statement-breakpoint
DROP INDEX "projects_owner_github_repository_unique";--> statement-breakpoint
ALTER TABLE "project_github_conversion_jobs" ADD COLUMN "repository_blind_index" text NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "github_repository_blind_index" text;--> statement-breakpoint
CREATE UNIQUE INDEX "project_github_conversion_jobs_repository_active_unique" ON "project_github_conversion_jobs" USING btree ("owner_id","repository_blind_index") WHERE "project_github_conversion_jobs"."state" IN ('queued', 'running', 'blocked');--> statement-breakpoint
CREATE UNIQUE INDEX "projects_owner_github_repository_unique" ON "projects" USING btree ("owner_id","github_repository_blind_index");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_managed_folder_identity_check" CHECK (("projects"."origin_kind" = 'managed-folder' AND "projects"."folder_management" IN ('managed', 'external') AND "projects"."github_repository_blind_index" IS NULL AND "projects"."github_repository_id" IS NULL AND "projects"."github_repository_full_name" IS NULL AND "projects"."github_repository_url" IS NULL AND "projects"."worktree_policy" = 'direct') OR ("projects"."origin_kind" <> 'managed-folder' AND "projects"."folder_management" IS NULL AND "projects"."github_repository_blind_index" IS NOT NULL));
