DROP INDEX "mcp_servers_owner_global_name_blind_unique";--> statement-breakpoint
DROP INDEX "mcp_servers_project_name_blind_unique";--> statement-breakpoint
DROP INDEX "mcp_servers_owner_scope_index";--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "worker_id" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_owner_global_unbound_name_blind_unique" ON "mcp_servers" USING btree ("owner_id","name_blind_index") WHERE "mcp_servers"."project_id" IS NULL AND "mcp_servers"."worker_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_owner_global_worker_name_blind_unique" ON "mcp_servers" USING btree ("owner_id","worker_id","name_blind_index") WHERE "mcp_servers"."project_id" IS NULL AND "mcp_servers"."worker_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_project_unbound_name_blind_unique" ON "mcp_servers" USING btree ("project_id","name_blind_index") WHERE "mcp_servers"."project_id" IS NOT NULL AND "mcp_servers"."worker_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_project_worker_name_blind_unique" ON "mcp_servers" USING btree ("project_id","worker_id","name_blind_index") WHERE "mcp_servers"."project_id" IS NOT NULL AND "mcp_servers"."worker_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mcp_servers_owner_scope_index" ON "mcp_servers" USING btree ("owner_id","project_id","worker_id");