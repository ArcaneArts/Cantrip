CREATE TABLE "task_dispatch_cycles" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"operation_kind" text NOT NULL,
	"state" text NOT NULL,
	"fifo_created_at" timestamp with time zone NOT NULL,
	"requested_task_worker_id" text,
	"selected_task_worker_id" text,
	"task_worker_revision" integer,
	"continuity_family" text,
	"model_configuration" jsonb,
	"model_route_id" text,
	"provider_account_id" text,
	"physical_worker_id" text,
	"worktree_id" text,
	"codex_thread_id" text,
	"turn_id" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"fencing_token" bigint DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"eligibility_code" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_dispatch_cycles_operation_kind_check" CHECK ("task_dispatch_cycles"."operation_kind" IN ('direct', 'initial-plan', 'continue-plan', 'finalize', 'goal-continuation')),
	CONSTRAINT "task_dispatch_cycles_state_check" CHECK ("task_dispatch_cycles"."state" IN ('queued', 'claimed', 'running', 'paused', 'succeeded', 'failed', 'cancelled', 'expired')),
	CONSTRAINT "task_dispatch_cycles_attempt_count_check" CHECK ("task_dispatch_cycles"."attempt_count" >= 0),
	CONSTRAINT "task_dispatch_cycles_fencing_token_check" CHECK ("task_dispatch_cycles"."fencing_token" >= 0),
	CONSTRAINT "task_dispatch_cycles_worker_revision_check" CHECK ("task_dispatch_cycles"."task_worker_revision" IS NULL OR "task_dispatch_cycles"."task_worker_revision" >= 1),
	CONSTRAINT "task_dispatch_cycles_eligibility_code_check" CHECK ("task_dispatch_cycles"."eligibility_code" IS NULL OR "task_dispatch_cycles"."eligibility_code" IN ('assignment-mismatch', 'capacity-unavailable', 'continuity-mismatch', 'encryption-grant-unavailable', 'model-unavailable', 'plan-goal-unsupported', 'placement-unavailable', 'project-paused', 'provider-route-unavailable', 'reconciliation-required', 'task-worker-disabled', 'worker-offline'))
);
--> statement-breakpoint
CREATE TABLE "task_workers" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"model_id" text NOT NULL,
	"reasoning_effort" text,
	"custom_subagent_model" boolean DEFAULT false NOT NULL,
	"subagent_model_id" text,
	"subagent_reasoning_effort" text,
	"max_concurrency" integer DEFAULT 1 NOT NULL,
	"allows_plan_goal" boolean DEFAULT false NOT NULL,
	"continuity_family" text NOT NULL,
	"continuity_family_override" text,
	"position" integer DEFAULT 0 NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_workers_subagent_model_check" CHECK (NOT "task_workers"."custom_subagent_model" OR "task_workers"."subagent_model_id" IS NOT NULL),
	CONSTRAINT "task_workers_concurrency_check" CHECK ("task_workers"."max_concurrency" >= 1 AND "task_workers"."max_concurrency" <= 64),
	CONSTRAINT "task_workers_position_check" CHECK ("task_workers"."position" >= 0),
	CONSTRAINT "task_workers_row_version_check" CHECK ("task_workers"."row_version" >= 1),
	CONSTRAINT "task_workers_deleted_disabled_check" CHECK ("task_workers"."deleted_at" IS NULL OR "task_workers"."enabled" = false)
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "task_scheduling_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "task_scheduling_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "task_scheduling_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "requested_task_worker_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "continuity_family" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "last_task_worker_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "scheduler_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_dispatch_cycles" ADD CONSTRAINT "task_dispatch_cycles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dispatch_cycles" ADD CONSTRAINT "task_dispatch_cycles_chat_id_tasks_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."tasks"("chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dispatch_cycles" ADD CONSTRAINT "task_dispatch_cycles_requested_task_worker_id_task_workers_id_fk" FOREIGN KEY ("requested_task_worker_id") REFERENCES "public"."task_workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dispatch_cycles" ADD CONSTRAINT "task_dispatch_cycles_selected_task_worker_id_task_workers_id_fk" FOREIGN KEY ("selected_task_worker_id") REFERENCES "public"."task_workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dispatch_cycles" ADD CONSTRAINT "task_dispatch_cycles_model_route_id_model_routes_id_fk" FOREIGN KEY ("model_route_id") REFERENCES "public"."model_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dispatch_cycles" ADD CONSTRAINT "task_dispatch_cycles_physical_worker_id_workers_id_fk" FOREIGN KEY ("physical_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dispatch_cycles" ADD CONSTRAINT "task_dispatch_cycles_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workers" ADD CONSTRAINT "task_workers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workers" ADD CONSTRAINT "task_workers_model_id_model_profiles_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workers" ADD CONSTRAINT "task_workers_subagent_model_id_model_profiles_id_fk" FOREIGN KEY ("subagent_model_id") REFERENCES "public"."model_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_dispatch_cycles_active_task_unique" ON "task_dispatch_cycles" USING btree ("chat_id") WHERE "task_dispatch_cycles"."state" IN ('queued', 'claimed', 'running', 'paused');--> statement-breakpoint
CREATE INDEX "task_dispatch_cycles_fifo_index" ON "task_dispatch_cycles" USING btree ("owner_id","state","fifo_created_at","id");--> statement-breakpoint
CREATE INDEX "task_dispatch_cycles_capacity_index" ON "task_dispatch_cycles" USING btree ("selected_task_worker_id","state");--> statement-breakpoint
CREATE INDEX "task_dispatch_cycles_lease_index" ON "task_dispatch_cycles" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE INDEX "task_dispatch_cycles_task_created_index" ON "task_dispatch_cycles" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_workers_owner_position_unique" ON "task_workers" USING btree ("owner_id","position") WHERE "task_workers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "task_workers_owner_enabled_index" ON "task_workers" USING btree ("owner_id","enabled","position");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_requested_task_worker_id_task_workers_id_fk" FOREIGN KEY ("requested_task_worker_id") REFERENCES "public"."task_workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_last_task_worker_id_task_workers_id_fk" FOREIGN KEY ("last_task_worker_id") REFERENCES "public"."task_workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_requested_worker_created_index" ON "tasks" USING btree ("requested_task_worker_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_last_worker_index" ON "tasks" USING btree ("last_task_worker_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_task_scheduling_pause_check" CHECK (("projects"."task_scheduling_paused" AND "projects"."task_scheduling_paused_at" IS NOT NULL) OR (NOT "projects"."task_scheduling_paused" AND "projects"."task_scheduling_paused_at" IS NULL));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_task_scheduling_revision_check" CHECK ("projects"."task_scheduling_revision" >= 1);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_priority_check" CHECK ("tasks"."priority" >= -1000000 AND "tasks"."priority" <= 1000000);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_scheduler_revision_check" CHECK ("tasks"."scheduler_revision" >= 1);