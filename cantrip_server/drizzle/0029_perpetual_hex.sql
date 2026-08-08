CREATE TABLE "code_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"code_tab_id" text NOT NULL,
	"project_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"worktree_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"editor_version" text NOT NULL,
	"editor_upstream_revision" text NOT NULL,
	"editor_patchset" integer NOT NULL,
	"editor_fingerprint" text NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"process_instance_id" text,
	"last_attachment_at" timestamp with time zone,
	"last_started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_sessions_patchset_check" CHECK ("code_sessions"."editor_patchset" >= 0),
	CONSTRAINT "code_sessions_status_check" CHECK ("code_sessions"."status" IN ('starting', 'running', 'idle', 'stopping', 'stopped', 'offline', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "code_tabs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"active_worker_id" text NOT NULL,
	"worktree_id" text NOT NULL,
	"profile_id" text DEFAULT 'default' NOT NULL,
	"theme_mode" text DEFAULT 'follow-cantrip' NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_tabs_theme_mode_check" CHECK ("code_tabs"."theme_mode" IN ('follow-cantrip', 'independent')),
	CONSTRAINT "code_tabs_status_check" CHECK ("code_tabs"."status" IN ('idle', 'starting', 'running', 'stopped', 'offline', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "code_capabilities" jsonb DEFAULT '{"available":false,"version":null,"upstreamRevision":null,"patchset":0,"transport":"web-proxy","maxSessions":1,"reason":"This worker has not reported Cantrip Code capability."}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "code_sessions" ADD CONSTRAINT "code_sessions_code_tab_id_code_tabs_id_fk" FOREIGN KEY ("code_tab_id") REFERENCES "public"."code_tabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_sessions" ADD CONSTRAINT "code_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_sessions" ADD CONSTRAINT "code_sessions_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_sessions" ADD CONSTRAINT "code_sessions_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_tabs" ADD CONSTRAINT "code_tabs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_tabs" ADD CONSTRAINT "code_tabs_active_worker_id_workers_id_fk" FOREIGN KEY ("active_worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_tabs" ADD CONSTRAINT "code_tabs_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "code_sessions_runtime_identity_unique" ON "code_sessions" USING btree ("code_tab_id","worker_id","worktree_id","profile_id","editor_fingerprint");--> statement-breakpoint
CREATE INDEX "code_sessions_tab_status_index" ON "code_sessions" USING btree ("code_tab_id","status");--> statement-breakpoint
CREATE INDEX "code_tabs_project_position_index" ON "code_tabs" USING btree ("project_id","position");