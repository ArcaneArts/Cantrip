CREATE TABLE "chat_import_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text NOT NULL,
	"chat_id" text,
	"source_kind" text NOT NULL,
	"source_worker_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_thread_id" text NOT NULL,
	"target_placement" jsonb NOT NULL,
	"requested_model_id" text,
	"requested_permission_profile_id" text,
	"requested_plan_mode" text DEFAULT 'default' NOT NULL,
	"state" text NOT NULL,
	"state_revision" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_fingerprint" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"command_id" text,
	"progress" jsonb NOT NULL,
	"source_metadata" jsonb,
	"last_error_code" text,
	"last_error_message" text,
	"error_retryable" boolean,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_import_jobs_state_check" CHECK ("chat_import_jobs"."state" IN ('queued', 'reading', 'importing', 'awaiting-hydration', 'hydrating', 'succeeded', 'blocked', 'failed', 'cancelled')),
	CONSTRAINT "chat_import_jobs_revision_check" CHECK ("chat_import_jobs"."state_revision" > 0),
	CONSTRAINT "chat_import_jobs_attempt_check" CHECK ("chat_import_jobs"."attempt" >= 0),
	CONSTRAINT "chat_import_jobs_error_shape_check" CHECK (("chat_import_jobs"."last_error_code" IS NULL AND "chat_import_jobs"."last_error_message" IS NULL AND "chat_import_jobs"."error_retryable" IS NULL) OR ("chat_import_jobs"."last_error_code" IS NOT NULL AND "chat_import_jobs"."last_error_message" IS NOT NULL AND "chat_import_jobs"."error_retryable" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "chat_import_jobs" ADD CONSTRAINT "chat_import_jobs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_import_jobs" ADD CONSTRAINT "chat_import_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_import_jobs" ADD CONSTRAINT "chat_import_jobs_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_import_jobs" ADD CONSTRAINT "chat_import_jobs_source_worker_id_workers_id_fk" FOREIGN KEY ("source_worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_import_jobs" ADD CONSTRAINT "chat_import_jobs_requested_model_id_model_profiles_id_fk" FOREIGN KEY ("requested_model_id") REFERENCES "public"."model_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_import_jobs_owner_idempotency_unique" ON "chat_import_jobs" USING btree ("owner_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_import_jobs_source_thread_unique" ON "chat_import_jobs" USING btree ("owner_id","source_kind","source_worker_id","source_id","source_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_import_jobs_command_unique" ON "chat_import_jobs" USING btree ("command_id") WHERE "chat_import_jobs"."command_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chat_import_jobs_dispatch_index" ON "chat_import_jobs" USING btree ("state","available_at","created_at");--> statement-breakpoint
CREATE INDEX "chat_import_jobs_project_created_index" ON "chat_import_jobs" USING btree ("project_id","created_at");