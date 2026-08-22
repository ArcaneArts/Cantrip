CREATE TABLE "run_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text NOT NULL,
	"worktree_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"action_id" text NOT NULL,
	"configuration_revision" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"terminal_id" text,
	"exit_code" integer,
	"signal" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_instances_state_check" CHECK ("run_instances"."state" IN ('queued', 'starting', 'running', 'exited', 'failed', 'stopping', 'stopped', 'lost')),
	CONSTRAINT "run_instances_action_id_check" CHECK ("run_instances"."action_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "run_instances_configuration_revision_check" CHECK ("run_instances"."configuration_revision" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "run_instances" ADD CONSTRAINT "run_instances_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_instances" ADD CONSTRAINT "run_instances_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_instances" ADD CONSTRAINT "run_instances_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_instances_owner_idempotency_unique" ON "run_instances" USING btree ("owner_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "run_instances_project_worktree_updated_index" ON "run_instances" USING btree ("project_id","worktree_id","updated_at");--> statement-breakpoint
CREATE INDEX "run_instances_worker_active_index" ON "run_instances" USING btree ("worker_id","state","updated_at");