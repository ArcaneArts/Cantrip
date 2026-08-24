CREATE TABLE "run_configuration_runtime_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text NOT NULL,
	"configuration_id" text NOT NULL,
	"worktree_id" text NOT NULL,
	"runtime_id" text,
	"worker_id" text NOT NULL,
	"operation" text NOT NULL,
	"outcome" text NOT NULL,
	"generation" integer NOT NULL,
	"definition_revision" text,
	"codex_environment_revision" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_configuration_runtime_operations_id_check" CHECK ("run_configuration_runtime_operations"."id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "run_configuration_runtime_operations_configuration_id_check" CHECK ("run_configuration_runtime_operations"."configuration_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "run_configuration_runtime_operations_operation_check" CHECK ("run_configuration_runtime_operations"."operation" IN ('start', 'restart', 'stop')),
	CONSTRAINT "run_configuration_runtime_operations_outcome_check" CHECK ("run_configuration_runtime_operations"."outcome" IN ('accepted', 'already-active', 'already-stopping', 'not-active')),
	CONSTRAINT "run_configuration_runtime_operations_generation_check" CHECK ("run_configuration_runtime_operations"."generation" >= 0),
	CONSTRAINT "run_configuration_runtime_operations_revision_check" CHECK ("run_configuration_runtime_operations"."definition_revision" IS NULL OR "run_configuration_runtime_operations"."definition_revision" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "run_configuration_runtime_operations_codex_revision_check" CHECK ("run_configuration_runtime_operations"."codex_environment_revision" IS NULL OR "run_configuration_runtime_operations"."codex_environment_revision" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "run_configuration_runtimes" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text NOT NULL,
	"configuration_id" text NOT NULL,
	"worktree_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"terminal_id" text,
	"definition_revision" text NOT NULL,
	"codex_environment_revision" text,
	"generation" integer DEFAULT 0 NOT NULL,
	"requested_operation_id" text NOT NULL,
	"state" text DEFAULT 'idle' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"exit_code" integer,
	"signal" text,
	"failure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_configuration_runtimes_id_check" CHECK ("run_configuration_runtimes"."id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "run_configuration_runtimes_configuration_id_check" CHECK ("run_configuration_runtimes"."configuration_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "run_configuration_runtimes_operation_id_check" CHECK ("run_configuration_runtimes"."requested_operation_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "run_configuration_runtimes_definition_revision_check" CHECK ("run_configuration_runtimes"."definition_revision" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "run_configuration_runtimes_codex_revision_check" CHECK ("run_configuration_runtimes"."codex_environment_revision" IS NULL OR "run_configuration_runtimes"."codex_environment_revision" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "run_configuration_runtimes_generation_check" CHECK ("run_configuration_runtimes"."generation" >= 0),
	CONSTRAINT "run_configuration_runtimes_state_check" CHECK ("run_configuration_runtimes"."state" IN ('idle', 'starting', 'running', 'restarting', 'stopping', 'exited', 'failed', 'lost')),
	CONSTRAINT "run_configuration_runtimes_signal_check" CHECK ("run_configuration_runtimes"."signal" IS NULL OR char_length("run_configuration_runtimes"."signal") <= 100),
	CONSTRAINT "run_configuration_runtimes_failure_check" CHECK ("run_configuration_runtimes"."failure" IS NULL OR octet_length("run_configuration_runtimes"."failure"::text) <= 4096)
);
--> statement-breakpoint
ALTER TABLE "run_configuration_runtime_operations" ADD CONSTRAINT "run_configuration_runtime_operations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_configuration_runtime_operations" ADD CONSTRAINT "run_configuration_runtime_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_configuration_runtime_operations" ADD CONSTRAINT "run_configuration_runtime_operations_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_configuration_runtime_operations" ADD CONSTRAINT "run_configuration_runtime_operations_runtime_id_run_configuration_runtimes_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "public"."run_configuration_runtimes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_configuration_runtime_operations" ADD CONSTRAINT "run_configuration_runtime_operations_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_configuration_runtimes" ADD CONSTRAINT "run_configuration_runtimes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_configuration_runtimes" ADD CONSTRAINT "run_configuration_runtimes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_configuration_runtimes" ADD CONSTRAINT "run_configuration_runtimes_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_configuration_runtimes" ADD CONSTRAINT "run_configuration_runtimes_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_configuration_runtime_operations_runtime_index" ON "run_configuration_runtime_operations" USING btree ("runtime_id","created_at");--> statement-breakpoint
CREATE INDEX "run_configuration_runtime_operations_identity_index" ON "run_configuration_runtime_operations" USING btree ("project_id","configuration_id","worktree_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_configuration_runtimes_identity_unique" ON "run_configuration_runtimes" USING btree ("project_id","configuration_id","worktree_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_configuration_runtimes_terminal_unique" ON "run_configuration_runtimes" USING btree ("terminal_id") WHERE "run_configuration_runtimes"."terminal_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "run_configuration_runtimes_project_state_index" ON "run_configuration_runtimes" USING btree ("project_id","state","updated_at");--> statement-breakpoint
CREATE INDEX "run_configuration_runtimes_worker_state_index" ON "run_configuration_runtimes" USING btree ("worker_id","state","updated_at");
