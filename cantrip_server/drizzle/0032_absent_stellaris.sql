CREATE TABLE "workflow_worktree_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"run_node_id" text NOT NULL,
	"run_node_item_id" text,
	"project_source_id" text,
	"worker_id" text,
	"requested_worktree_id" text NOT NULL,
	"worktree_id" text,
	"lease_key" text NOT NULL,
	"state" text DEFAULT 'allocating' NOT NULL,
	"branch_name" text,
	"base_revision" text,
	"starting_revision" text,
	"ending_revision" text,
	"worktree_dirty" boolean,
	"produced_changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"activated_at" timestamp with time zone,
	"checkpointed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_worktree_leases_state_check" CHECK ("workflow_worktree_leases"."state" IN ('allocating', 'active', 'checkpointed', 'recovering', 'released', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "workflow_worktree_leases" ADD CONSTRAINT "workflow_worktree_leases_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_worktree_leases" ADD CONSTRAINT "workflow_worktree_leases_run_node_id_workflow_run_nodes_id_fk" FOREIGN KEY ("run_node_id") REFERENCES "public"."workflow_run_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_worktree_leases" ADD CONSTRAINT "workflow_worktree_leases_run_node_item_id_workflow_run_node_items_id_fk" FOREIGN KEY ("run_node_item_id") REFERENCES "public"."workflow_run_node_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_worktree_leases" ADD CONSTRAINT "workflow_worktree_leases_project_source_id_project_sources_id_fk" FOREIGN KEY ("project_source_id") REFERENCES "public"."project_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_worktree_leases" ADD CONSTRAINT "workflow_worktree_leases_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_worktree_leases" ADD CONSTRAINT "workflow_worktree_leases_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_worktree_leases_run_key_unique" ON "workflow_worktree_leases" USING btree ("run_id","lease_key");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_worktree_leases_requested_worktree_unique" ON "workflow_worktree_leases" USING btree ("requested_worktree_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_worktree_leases_node_active_unique" ON "workflow_worktree_leases" USING btree ("run_node_id") WHERE "workflow_worktree_leases"."run_node_item_id" IS NULL AND "workflow_worktree_leases"."state" <> 'released';--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_worktree_leases_item_active_unique" ON "workflow_worktree_leases" USING btree ("run_node_item_id") WHERE "workflow_worktree_leases"."run_node_item_id" IS NOT NULL AND "workflow_worktree_leases"."state" <> 'released';--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_worktree_leases_worktree_active_unique" ON "workflow_worktree_leases" USING btree ("worktree_id") WHERE "workflow_worktree_leases"."worktree_id" IS NOT NULL AND "workflow_worktree_leases"."state" <> 'released';--> statement-breakpoint
CREATE INDEX "workflow_worktree_leases_run_state_index" ON "workflow_worktree_leases" USING btree ("run_id","state","created_at");--> statement-breakpoint
CREATE INDEX "workflow_worktree_leases_recovery_index" ON "workflow_worktree_leases" USING btree ("state","updated_at");