CREATE TABLE "project_github_conversion_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text NOT NULL,
	"project_source_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"repository_url" text NOT NULL,
	"confirmation_token" text NOT NULL,
	"initial_commit_message" text,
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
	"local_files_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_github_conversion_jobs_state_check" CHECK ("project_github_conversion_jobs"."state" IN ('queued', 'running', 'blocked', 'succeeded', 'failed')),
	CONSTRAINT "project_github_conversion_jobs_revision_check" CHECK ("project_github_conversion_jobs"."state_revision" > 0),
	CONSTRAINT "project_github_conversion_jobs_attempt_check" CHECK ("project_github_conversion_jobs"."attempt" >= 0),
	CONSTRAINT "project_github_conversion_jobs_error_shape_check" CHECK (("project_github_conversion_jobs"."last_error_code" IS NULL AND "project_github_conversion_jobs"."last_error_message" IS NULL AND "project_github_conversion_jobs"."error_retryable" IS NULL) OR ("project_github_conversion_jobs"."last_error_code" IS NOT NULL AND "project_github_conversion_jobs"."last_error_message" IS NOT NULL AND "project_github_conversion_jobs"."error_retryable" IS NOT NULL))
);
--> statement-breakpoint
UPDATE "workers"
SET "managed_folder_capabilities" = "managed_folder_capabilities" || '{"convertToGithub":false}'::jsonb
WHERE NOT ("managed_folder_capabilities" ? 'convertToGithub');--> statement-breakpoint
ALTER TABLE "workers" ALTER COLUMN "managed_folder_capabilities" SET DEFAULT '{"create":false,"convertToGithub":false,"remove":false}'::jsonb;--> statement-breakpoint
ALTER TABLE "project_github_conversion_jobs" ADD CONSTRAINT "project_github_conversion_jobs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_github_conversion_jobs" ADD CONSTRAINT "project_github_conversion_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_github_conversion_jobs" ADD CONSTRAINT "project_github_conversion_jobs_project_source_id_project_sources_id_fk" FOREIGN KEY ("project_source_id") REFERENCES "public"."project_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_github_conversion_jobs" ADD CONSTRAINT "project_github_conversion_jobs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_github_conversion_jobs_project_active_unique" ON "project_github_conversion_jobs" USING btree ("project_id") WHERE "project_github_conversion_jobs"."state" IN ('queued', 'running', 'blocked');--> statement-breakpoint
CREATE UNIQUE INDEX "project_github_conversion_jobs_repository_active_unique" ON "project_github_conversion_jobs" USING btree ("owner_id","repository_id") WHERE "project_github_conversion_jobs"."state" IN ('queued', 'running', 'blocked');--> statement-breakpoint
CREATE UNIQUE INDEX "project_github_conversion_jobs_command_unique" ON "project_github_conversion_jobs" USING btree ("command_id") WHERE "project_github_conversion_jobs"."command_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "project_github_conversion_jobs_dispatch_index" ON "project_github_conversion_jobs" USING btree ("state","available_at","created_at");--> statement-breakpoint
CREATE INDEX "project_github_conversion_jobs_worker_state_index" ON "project_github_conversion_jobs" USING btree ("worker_id","state");
