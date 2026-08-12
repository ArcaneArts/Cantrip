CREATE TABLE "chat_attachment_replicas" (
	"attachment_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_attachment_replicas_attachment_id_worker_id_pk" PRIMARY KEY("attachment_id","worker_id"),
	CONSTRAINT "chat_attachment_replicas_status_check" CHECK ("chat_attachment_replicas"."status" IN ('pending', 'ready', 'failed'))
);
--> statement-breakpoint
INSERT INTO "chat_attachment_replicas" (
	"attachment_id",
	"worker_id",
	"status",
	"verified_at",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	"worker_id",
	'ready',
	"updated_at",
	"created_at",
	"updated_at"
FROM "chat_attachments"
WHERE "status" = 'ready';
--> statement-breakpoint
CREATE TABLE "chat_relocation_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"state" text NOT NULL,
	"state_revision" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_fingerprint" text NOT NULL,
	"source_placement" jsonb NOT NULL,
	"source_placement_revision" integer NOT NULL,
	"target_placement" jsonb NOT NULL,
	"target_runtime_thread_id" text,
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
	CONSTRAINT "chat_relocation_jobs_state_check" CHECK ("chat_relocation_jobs"."state" IN ('queued', 'waiting-for-idle', 'validating', 'preparing-replica', 'transferring-attachments', 'hydrating-runtime', 'ready-to-commit', 'succeeded', 'blocked', 'failed', 'cancelled')),
	CONSTRAINT "chat_relocation_jobs_revision_check" CHECK ("chat_relocation_jobs"."state_revision" > 0 AND "chat_relocation_jobs"."source_placement_revision" > 0),
	CONSTRAINT "chat_relocation_jobs_attempt_check" CHECK ("chat_relocation_jobs"."attempt" >= 0),
	CONSTRAINT "chat_relocation_jobs_error_shape_check" CHECK (("chat_relocation_jobs"."last_error_code" IS NULL AND "chat_relocation_jobs"."last_error_message" IS NULL AND "chat_relocation_jobs"."error_retryable" IS NULL) OR ("chat_relocation_jobs"."last_error_code" IS NOT NULL AND "chat_relocation_jobs"."last_error_message" IS NOT NULL AND "chat_relocation_jobs"."error_retryable" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "chat_relocation_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"source_placement" jsonb NOT NULL,
	"through_sequence" integer NOT NULL,
	"transcript_sha256" text NOT NULL,
	"payload" jsonb NOT NULL,
	"message_count" integer NOT NULL,
	"attachment_count" integer NOT NULL,
	"model_id" text,
	"model_route_id" text,
	"permission_profile_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_relocation_snapshots_job_id_unique" UNIQUE("job_id"),
	CONSTRAINT "chat_relocation_snapshots_counts_check" CHECK ("chat_relocation_snapshots"."through_sequence" >= 0 AND "chat_relocation_snapshots"."message_count" >= 0 AND "chat_relocation_snapshots"."attachment_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "placement_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_attachment_replicas" ADD CONSTRAINT "chat_attachment_replicas_attachment_id_chat_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."chat_attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachment_replicas" ADD CONSTRAINT "chat_attachment_replicas_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_relocation_jobs" ADD CONSTRAINT "chat_relocation_jobs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_relocation_jobs" ADD CONSTRAINT "chat_relocation_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_relocation_jobs" ADD CONSTRAINT "chat_relocation_jobs_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_relocation_snapshots" ADD CONSTRAINT "chat_relocation_snapshots_job_id_chat_relocation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."chat_relocation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_relocation_snapshots" ADD CONSTRAINT "chat_relocation_snapshots_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_relocation_snapshots" ADD CONSTRAINT "chat_relocation_snapshots_model_id_model_profiles_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_relocation_snapshots" ADD CONSTRAINT "chat_relocation_snapshots_model_route_id_model_routes_id_fk" FOREIGN KEY ("model_route_id") REFERENCES "public"."model_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_attachment_replicas_worker_status_index" ON "chat_attachment_replicas" USING btree ("worker_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_relocation_jobs_owner_idempotency_unique" ON "chat_relocation_jobs" USING btree ("owner_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_relocation_jobs_command_unique" ON "chat_relocation_jobs" USING btree ("command_id") WHERE "chat_relocation_jobs"."command_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_relocation_jobs_active_chat_unique" ON "chat_relocation_jobs" USING btree ("chat_id") WHERE "chat_relocation_jobs"."state" IN ('queued', 'waiting-for-idle', 'validating', 'preparing-replica', 'transferring-attachments', 'hydrating-runtime', 'ready-to-commit', 'blocked');--> statement-breakpoint
CREATE INDEX "chat_relocation_jobs_dispatch_index" ON "chat_relocation_jobs" USING btree ("state","available_at","created_at");--> statement-breakpoint
CREATE INDEX "chat_relocation_jobs_chat_created_index" ON "chat_relocation_jobs" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_relocation_snapshots_chat_created_index" ON "chat_relocation_snapshots" USING btree ("chat_id","created_at");
