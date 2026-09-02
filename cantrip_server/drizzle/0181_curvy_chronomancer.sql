CREATE TABLE "workspace_repository_discovery_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"state" text NOT NULL,
	"state_revision" integer DEFAULT 1 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"depth" integer DEFAULT 3 NOT NULL,
	"command_id" text,
	"last_error_code" text,
	"error_retryable" boolean,
	"truncated" boolean DEFAULT false NOT NULL,
	"candidate_count" integer,
	"collapsed_repository_count" integer,
	"rejected_repository_count" integer,
	"scanned_directory_count" integer,
	"scanned_entry_count" integer,
	"skipped_symlink_count" integer,
	"unreadable_directory_count" integer,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_repository_discovery_jobs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "workspace_repository_discovery_jobs_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "workspace_repository_discovery_jobs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "workspace_repository_discovery_jobs_state_check" CHECK ("workspace_repository_discovery_jobs"."state" IN ('queued', 'running', 'blocked', 'succeeded', 'failed')),
	CONSTRAINT "workspace_repository_discovery_jobs_revision_check" CHECK ("workspace_repository_discovery_jobs"."state_revision" > 0),
	CONSTRAINT "workspace_repository_discovery_jobs_attempt_check" CHECK ("workspace_repository_discovery_jobs"."attempt" >= 0),
	CONSTRAINT "workspace_repository_discovery_jobs_depth_check" CHECK ("workspace_repository_discovery_jobs"."depth" >= 0 AND "workspace_repository_discovery_jobs"."depth" <= 16),
	CONSTRAINT "workspace_repository_discovery_jobs_error_shape_check" CHECK (("workspace_repository_discovery_jobs"."last_error_code" IS NULL AND "workspace_repository_discovery_jobs"."error_retryable" IS NULL) OR ("workspace_repository_discovery_jobs"."last_error_code" IS NOT NULL AND "workspace_repository_discovery_jobs"."error_retryable" IS NOT NULL)),
	CONSTRAINT "workspace_repository_discovery_jobs_error_code_check" CHECK ("workspace_repository_discovery_jobs"."last_error_code" IS NULL OR "workspace_repository_discovery_jobs"."last_error_code" IN ('worker-offline', 'capability-missing', 'root-unavailable', 'discovery-failed')),
	CONSTRAINT "workspace_repository_discovery_jobs_execution_shape_check" CHECK (("workspace_repository_discovery_jobs"."state" = 'running' AND "workspace_repository_discovery_jobs"."command_id" IS NOT NULL AND "workspace_repository_discovery_jobs"."lease_expires_at" IS NOT NULL) OR ("workspace_repository_discovery_jobs"."state" <> 'running' AND "workspace_repository_discovery_jobs"."command_id" IS NULL AND "workspace_repository_discovery_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "workspace_repository_discovery_jobs_completion_shape_check" CHECK (("workspace_repository_discovery_jobs"."state" IN ('succeeded', 'failed') AND "workspace_repository_discovery_jobs"."completed_at" IS NOT NULL) OR ("workspace_repository_discovery_jobs"."state" NOT IN ('succeeded', 'failed') AND "workspace_repository_discovery_jobs"."completed_at" IS NULL)),
	CONSTRAINT "workspace_repository_discovery_jobs_counts_shape_check" CHECK (("workspace_repository_discovery_jobs"."state" = 'succeeded' AND num_nonnulls("workspace_repository_discovery_jobs"."candidate_count", "workspace_repository_discovery_jobs"."collapsed_repository_count", "workspace_repository_discovery_jobs"."rejected_repository_count", "workspace_repository_discovery_jobs"."scanned_directory_count", "workspace_repository_discovery_jobs"."scanned_entry_count", "workspace_repository_discovery_jobs"."skipped_symlink_count", "workspace_repository_discovery_jobs"."unreadable_directory_count") = 7 AND "workspace_repository_discovery_jobs"."candidate_count" >= 0 AND "workspace_repository_discovery_jobs"."collapsed_repository_count" >= 0 AND "workspace_repository_discovery_jobs"."rejected_repository_count" >= 0 AND "workspace_repository_discovery_jobs"."scanned_directory_count" >= 0 AND "workspace_repository_discovery_jobs"."scanned_entry_count" >= 0 AND "workspace_repository_discovery_jobs"."skipped_symlink_count" >= 0 AND "workspace_repository_discovery_jobs"."unreadable_directory_count" >= 0) OR ("workspace_repository_discovery_jobs"."state" <> 'succeeded' AND num_nonnulls("workspace_repository_discovery_jobs"."candidate_count", "workspace_repository_discovery_jobs"."collapsed_repository_count", "workspace_repository_discovery_jobs"."rejected_repository_count", "workspace_repository_discovery_jobs"."scanned_directory_count", "workspace_repository_discovery_jobs"."scanned_entry_count", "workspace_repository_discovery_jobs"."skipped_symlink_count", "workspace_repository_discovery_jobs"."unreadable_directory_count") = 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_repository_discovery_jobs_workspace_unique" ON "workspace_repository_discovery_jobs" USING btree ("workspace_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_repository_discovery_jobs_identity_unique" ON "workspace_repository_discovery_jobs" USING btree ("id","owner_id","workspace_id","worker_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_repository_discovery_jobs_command_unique" ON "workspace_repository_discovery_jobs" USING btree ("command_id") WHERE "workspace_repository_discovery_jobs"."command_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "workspace_repository_discovery_jobs_dispatch_index" ON "workspace_repository_discovery_jobs" USING btree ("state","available_at","created_at");
--> statement-breakpoint
CREATE INDEX "workspace_repository_discovery_jobs_worker_state_index" ON "workspace_repository_discovery_jobs" USING btree ("worker_id","state");
--> statement-breakpoint
CREATE TABLE "workspace_repository_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"job_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"protected_path_handle" text NOT NULL,
	"protected_display_handle" text NOT NULL,
	"repository_fingerprint" text NOT NULL,
	"classification" text DEFAULT 'unclassified' NOT NULL,
	"import_state" text DEFAULT 'pending' NOT NULL,
	"diagnostic_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_repository_candidates_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "workspace_repository_candidates_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "workspace_repository_candidates_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "workspace_repository_candidates_job_identity_fk" FOREIGN KEY ("job_id","owner_id","workspace_id","worker_id") REFERENCES "public"."workspace_repository_discovery_jobs"("id","owner_id","workspace_id","worker_id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "workspace_repository_candidates_path_handle_check" CHECK ("workspace_repository_candidates"."protected_path_handle" ~ '^ctrr_[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "workspace_repository_candidates_display_handle_check" CHECK ("workspace_repository_candidates"."protected_display_handle" ~ '^ctrr_[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "workspace_repository_candidates_fingerprint_check" CHECK ("workspace_repository_candidates"."repository_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_repository_candidates_classification_check" CHECK ("workspace_repository_candidates"."classification" IN ('unclassified', 'local-git', 'github-accessible', 'github-unavailable')),
	CONSTRAINT "workspace_repository_candidates_import_state_check" CHECK ("workspace_repository_candidates"."import_state" IN ('pending', 'importing', 'imported', 'failed', 'skipped')),
	CONSTRAINT "workspace_repository_candidates_diagnostic_code_check" CHECK ("workspace_repository_candidates"."diagnostic_code" IS NULL OR length("workspace_repository_candidates"."diagnostic_code") <= 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_repository_candidates_workspace_fingerprint_unique" ON "workspace_repository_candidates" USING btree ("workspace_id","repository_fingerprint");
--> statement-breakpoint
CREATE INDEX "workspace_repository_candidates_job_index" ON "workspace_repository_candidates" USING btree ("job_id","import_state","created_at");
