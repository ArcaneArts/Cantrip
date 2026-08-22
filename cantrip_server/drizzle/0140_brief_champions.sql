CREATE TABLE "worktree_setup_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text NOT NULL,
	"worktree_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"configuration_revision" text,
	"state" text NOT NULL,
	"state_revision" integer DEFAULT 1 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"command_id" text,
	"last_error_code" text,
	"last_error_message" text,
	"error_retryable" boolean,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worktree_setup_jobs_state_check" CHECK ("worktree_setup_jobs"."state" IN ('queued', 'running', 'blocked', 'succeeded', 'failed', 'stale')),
	CONSTRAINT "worktree_setup_jobs_revision_check" CHECK ("worktree_setup_jobs"."state_revision" > 0),
	CONSTRAINT "worktree_setup_jobs_attempt_check" CHECK ("worktree_setup_jobs"."attempt" >= 0),
	CONSTRAINT "worktree_setup_jobs_error_shape_check" CHECK (("worktree_setup_jobs"."last_error_code" IS NULL AND "worktree_setup_jobs"."last_error_message" IS NULL AND "worktree_setup_jobs"."error_retryable" IS NULL) OR ("worktree_setup_jobs"."last_error_code" IS NOT NULL AND "worktree_setup_jobs"."last_error_message" IS NOT NULL AND "worktree_setup_jobs"."error_retryable" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "worktree_setup_jobs" ADD CONSTRAINT "worktree_setup_jobs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worktree_setup_jobs" ADD CONSTRAINT "worktree_setup_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worktree_setup_jobs" ADD CONSTRAINT "worktree_setup_jobs_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worktree_setup_jobs" ADD CONSTRAINT "worktree_setup_jobs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worktree_setup_jobs_worktree_unique" ON "worktree_setup_jobs" USING btree ("worktree_id");--> statement-breakpoint
CREATE UNIQUE INDEX "worktree_setup_jobs_command_unique" ON "worktree_setup_jobs" USING btree ("command_id") WHERE "worktree_setup_jobs"."command_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "worktree_setup_jobs_dispatch_index" ON "worktree_setup_jobs" USING btree ("state","available_at","created_at");--> statement-breakpoint
CREATE INDEX "worktree_setup_jobs_worker_state_index" ON "worktree_setup_jobs" USING btree ("worker_id","state");