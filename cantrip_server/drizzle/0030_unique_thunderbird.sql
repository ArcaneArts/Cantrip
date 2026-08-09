CREATE TABLE "workflow_run_node_items" (
	"id" text PRIMARY KEY NOT NULL,
	"run_node_id" text NOT NULL,
	"item_key" text NOT NULL,
	"position" integer NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"structured_input" jsonb NOT NULL,
	"structured_result" jsonb,
	"measured_usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"worker_id" text,
	"worktree_id" text,
	"model_route_id" text,
	"permission_profile_id" text,
	"codex_thread_id" text,
	"codex_turn_id" text,
	"execution_lease_key" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone,
	"timeout_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"waiting_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_run_node_items_position_check" CHECK ("workflow_run_node_items"."position" >= 0),
	CONSTRAINT "workflow_run_node_items_attempt_count_check" CHECK ("workflow_run_node_items"."attempt_count" >= 0),
	CONSTRAINT "workflow_run_node_items_status_check" CHECK ("workflow_run_node_items"."status" IN ('ready', 'running', 'waiting-for-approval', 'cancelled', 'failed', 'completed', 'recovering', 'skipped'))
);
--> statement-breakpoint
DROP INDEX "workflow_node_attempts_number_unique";--> statement-breakpoint
ALTER TABLE "workflow_node_attempts" ADD COLUMN "run_node_item_id" text;--> statement-breakpoint
ALTER TABLE "workflow_run_node_items" ADD CONSTRAINT "workflow_run_node_items_run_node_id_workflow_run_nodes_id_fk" FOREIGN KEY ("run_node_id") REFERENCES "public"."workflow_run_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_node_items" ADD CONSTRAINT "workflow_run_node_items_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_node_items" ADD CONSTRAINT "workflow_run_node_items_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_node_items" ADD CONSTRAINT "workflow_run_node_items_model_route_id_model_routes_id_fk" FOREIGN KEY ("model_route_id") REFERENCES "public"."model_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_node_items_key_unique" ON "workflow_run_node_items" USING btree ("run_node_id","item_key");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_node_items_position_unique" ON "workflow_run_node_items" USING btree ("run_node_id","position");--> statement-breakpoint
CREATE INDEX "workflow_run_node_items_status_index" ON "workflow_run_node_items" USING btree ("run_node_id","status","position");--> statement-breakpoint
ALTER TABLE "workflow_node_attempts" ADD CONSTRAINT "workflow_node_attempts_run_node_item_id_workflow_run_node_items_id_fk" FOREIGN KEY ("run_node_item_id") REFERENCES "public"."workflow_run_node_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_node_attempts_node_number_unique" ON "workflow_node_attempts" USING btree ("run_node_id","attempt") WHERE "workflow_node_attempts"."run_node_item_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_node_attempts_item_number_unique" ON "workflow_node_attempts" USING btree ("run_node_item_id","attempt") WHERE "workflow_node_attempts"."run_node_item_id" IS NOT NULL;