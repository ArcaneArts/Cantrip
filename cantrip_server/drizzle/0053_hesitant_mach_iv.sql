DROP INDEX "project_sources_project_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "project_sources_project_worker_unique" ON "project_sources" USING btree ("project_id","worker_id");