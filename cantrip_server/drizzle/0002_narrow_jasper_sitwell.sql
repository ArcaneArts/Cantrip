DROP INDEX "project_sources_project_worker_unique";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "github_repository_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "github_repository_full_name" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "github_repository_url" text;--> statement-breakpoint
CREATE UNIQUE INDEX "project_sources_project_unique" ON "project_sources" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_owner_github_repository_unique" ON "projects" USING btree ("owner_id","github_repository_id");