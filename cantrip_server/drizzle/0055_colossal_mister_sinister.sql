CREATE TABLE "project_replica_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text NOT NULL,
	"project_replica_id" text,
	"worker_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"state_revision" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_fingerprint" text NOT NULL,
	"repository" text NOT NULL,
	"expected_revision" text,
	"resolved_revision" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"command_id" text,
	"progress" jsonb NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"error_retryable" boolean,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"cancellation_unsafe_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_replica_jobs_kind_check" CHECK ("project_replica_jobs"."kind" IN ('provision', 'synchronize', 'remove')),
	CONSTRAINT "project_replica_jobs_state_check" CHECK ("project_replica_jobs"."state" IN ('queued', 'running', 'blocked', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "project_replica_jobs_revision_check" CHECK ("project_replica_jobs"."state_revision" > 0),
	CONSTRAINT "project_replica_jobs_attempt_check" CHECK ("project_replica_jobs"."attempt" >= 0),
	CONSTRAINT "project_replica_jobs_error_shape_check" CHECK (("project_replica_jobs"."last_error_code" IS NULL AND "project_replica_jobs"."last_error_message" IS NULL AND "project_replica_jobs"."error_retryable" IS NULL) OR ("project_replica_jobs"."last_error_code" IS NOT NULL AND "project_replica_jobs"."last_error_message" IS NOT NULL AND "project_replica_jobs"."error_retryable" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "project_replica_capabilities" jsonb DEFAULT '{"provision":false,"synchronize":false,"remove":false,"exactRevision":false}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_replica_jobs" ADD CONSTRAINT "project_replica_jobs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_replica_jobs" ADD CONSTRAINT "project_replica_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_replica_jobs" ADD CONSTRAINT "project_replica_jobs_project_replica_id_project_sources_id_fk" FOREIGN KEY ("project_replica_id") REFERENCES "public"."project_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_replica_jobs" ADD CONSTRAINT "project_replica_jobs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_replica_jobs_owner_idempotency_unique" ON "project_replica_jobs" USING btree ("owner_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "project_replica_jobs_command_unique" ON "project_replica_jobs" USING btree ("command_id") WHERE "project_replica_jobs"."command_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_replica_jobs_active_target_unique" ON "project_replica_jobs" USING btree ("project_id","worker_id","kind") WHERE "project_replica_jobs"."state" IN ('queued', 'running', 'blocked');--> statement-breakpoint
CREATE INDEX "project_replica_jobs_dispatch_index" ON "project_replica_jobs" USING btree ("state","available_at","created_at");--> statement-breakpoint
CREATE INDEX "project_replica_jobs_project_created_index" ON "project_replica_jobs" USING btree ("project_id","created_at");