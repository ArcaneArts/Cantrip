CREATE TABLE "git_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text NOT NULL,
	"worktree_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"type" text NOT NULL,
	"state" text NOT NULL,
	"original_head" text NOT NULL,
	"current_head" text NOT NULL,
	"source_ref" text,
	"source_revision" text,
	"target_ref" text,
	"target_revision" text NOT NULL,
	"pending_commits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"total_steps" integer DEFAULT 1 NOT NULL,
	"conflicted_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output" text DEFAULT '' NOT NULL,
	"checkpoint_ref" text,
	"error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_operations" ADD CONSTRAINT "git_operations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_operations" ADD CONSTRAINT "git_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_operations" ADD CONSTRAINT "git_operations_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_operations" ADD CONSTRAINT "git_operations_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "git_operations_project_worktree_updated_index" ON "git_operations" USING btree ("project_id","worktree_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "git_operations_worktree_active_unique" ON "git_operations" USING btree ("worktree_id") WHERE "git_operations"."state" in ('queued', 'running', 'conflicted', 'awaiting-user-action');