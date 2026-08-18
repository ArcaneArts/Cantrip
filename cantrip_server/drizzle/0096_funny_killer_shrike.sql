CREATE TABLE "project_folder_setup_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text NOT NULL,
	"worker_id" text NOT NULL,
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
	CONSTRAINT "project_folder_setup_jobs_state_check" CHECK ("project_folder_setup_jobs"."state" IN ('queued', 'running', 'blocked', 'succeeded', 'failed')),
	CONSTRAINT "project_folder_setup_jobs_revision_check" CHECK ("project_folder_setup_jobs"."state_revision" > 0),
	CONSTRAINT "project_folder_setup_jobs_attempt_check" CHECK ("project_folder_setup_jobs"."attempt" >= 0),
	CONSTRAINT "project_folder_setup_jobs_error_shape_check" CHECK (("project_folder_setup_jobs"."last_error_code" IS NULL AND "project_folder_setup_jobs"."last_error_message" IS NULL AND "project_folder_setup_jobs"."error_retryable" IS NULL) OR ("project_folder_setup_jobs"."last_error_code" IS NOT NULL AND "project_folder_setup_jobs"."last_error_message" IS NOT NULL AND "project_folder_setup_jobs"."error_retryable" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "managed_folder_capabilities" jsonb DEFAULT '{"create":false,"remove":false}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_folder_setup_jobs" ADD CONSTRAINT "project_folder_setup_jobs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_folder_setup_jobs" ADD CONSTRAINT "project_folder_setup_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_folder_setup_jobs" ADD CONSTRAINT "project_folder_setup_jobs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_folder_setup_jobs_project_unique" ON "project_folder_setup_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_folder_setup_jobs_command_unique" ON "project_folder_setup_jobs" USING btree ("command_id") WHERE "project_folder_setup_jobs"."command_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "project_folder_setup_jobs_dispatch_index" ON "project_folder_setup_jobs" USING btree ("state","available_at","created_at");--> statement-breakpoint
CREATE INDEX "project_folder_setup_jobs_worker_state_index" ON "project_folder_setup_jobs" USING btree ("worker_id","state");