ALTER TABLE "workers" ADD COLUMN "standalone_chat_capabilities" jsonb DEFAULT '{"protocolVersion":1,"scratch":{"provision":false,"resolve":false,"archive":false,"restore":false,"remove":false,"reconcile":false,"routingHandles":false},"files":{"list":false,"read":false,"write":false,"remove":false,"download":false,"archive":false}}'::jsonb NOT NULL;--> statement-breakpoint

ALTER TABLE "standalone_chat_roots" ALTER COLUMN "protected_path_handle" DROP NOT NULL;--> statement-breakpoint
UPDATE "standalone_chat_roots" SET "protected_path_handle" = NULL WHERE "protected_path_handle" !~ '^ctrr_[A-Za-z0-9_-]{43}$';--> statement-breakpoint
UPDATE "standalone_chat_roots" SET "status" = 'failed' WHERE "status" = 'ready' AND "protected_path_handle" IS NULL;--> statement-breakpoint

CREATE TABLE "standalone_chat_root_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"root_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"state_revision" integer DEFAULT 1 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"command_id" text,
	"last_error_code" text,
	"error_retryable" boolean,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "standalone_chat_root_jobs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "standalone_chat_root_jobs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "standalone_chat_root_jobs_kind_check" CHECK ("kind" IN ('provision', 'delete')),
	CONSTRAINT "standalone_chat_root_jobs_state_check" CHECK ("state" IN ('queued', 'running', 'blocked', 'succeeded', 'failed')),
	CONSTRAINT "standalone_chat_root_jobs_revision_check" CHECK ("state_revision" > 0),
	CONSTRAINT "standalone_chat_root_jobs_attempt_check" CHECK ("attempt" >= 0),
	CONSTRAINT "standalone_chat_root_jobs_identity_check" CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND "root_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND "chat_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "standalone_chat_root_jobs_error_code_check" CHECK ("last_error_code" IS NULL OR "last_error_code" IN ('worker-offline', 'capability-missing', 'worker-error', 'invalid-result', 'root-conflict')),
	CONSTRAINT "standalone_chat_root_jobs_error_shape_check" CHECK (("last_error_code" IS NULL AND "error_retryable" IS NULL) OR ("last_error_code" IS NOT NULL AND "error_retryable" IS NOT NULL))
);--> statement-breakpoint

CREATE UNIQUE INDEX "standalone_chat_root_jobs_root_kind_unique" ON "standalone_chat_root_jobs" USING btree ("root_id", "kind");--> statement-breakpoint
CREATE UNIQUE INDEX "standalone_chat_root_jobs_command_unique" ON "standalone_chat_root_jobs" USING btree ("command_id") WHERE "command_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "standalone_chat_root_jobs_owner_state_index" ON "standalone_chat_root_jobs" USING btree ("owner_id", "state", "updated_at");--> statement-breakpoint
CREATE INDEX "standalone_chat_root_jobs_dispatch_index" ON "standalone_chat_root_jobs" USING btree ("state", "available_at", "created_at");--> statement-breakpoint
CREATE INDEX "standalone_chat_root_jobs_worker_state_index" ON "standalone_chat_root_jobs" USING btree ("worker_id", "state");--> statement-breakpoint

ALTER TABLE "standalone_chat_roots" ADD CONSTRAINT "standalone_chat_roots_deletion_job_id_standalone_chat_root_jobs_id_fk" FOREIGN KEY ("deletion_job_id") REFERENCES "public"."standalone_chat_root_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standalone_chat_roots" ADD CONSTRAINT "standalone_chat_roots_path_status_check" CHECK ("status" <> 'ready' OR "protected_path_handle" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "standalone_chat_roots" ADD CONSTRAINT "standalone_chat_roots_path_handle_check" CHECK ("protected_path_handle" IS NULL OR "protected_path_handle" ~ '^ctrr_[A-Za-z0-9_-]{43}$');
