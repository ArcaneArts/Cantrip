ALTER TABLE "user_settings" ADD COLUMN "default_chat_model_id" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "default_chat_reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "default_chat_permission_profile_id" text DEFAULT ':workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "last_app_mode" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "last_ide_project_id" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "last_ide_workspace_id" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "last_standalone_chat_id" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "destination_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_default_chat_model_id_model_profiles_id_fk" FOREIGN KEY ("default_chat_model_id") REFERENCES "public"."model_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_last_ide_project_id_projects_id_fk" FOREIGN KEY ("last_ide_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_last_ide_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("last_ide_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_last_standalone_chat_id_chats_id_fk" FOREIGN KEY ("last_standalone_chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_default_chat_permission_profile_check" CHECK ("user_settings"."default_chat_permission_profile_id" IN (':read-only', ':workspace', ':danger-full-access', ':yolo'));--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_last_app_mode_check" CHECK ("user_settings"."last_app_mode" IS NULL OR "user_settings"."last_app_mode" IN ('ide', 'chat'));--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_destination_revision_check" CHECK ("user_settings"."destination_revision" >= 1);--> statement-breakpoint

CREATE UNIQUE INDEX "projects_id_owner_unique" ON "projects" USING btree ("id", "owner_id");--> statement-breakpoint

ALTER TABLE "chats" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "context_kind" text DEFAULT 'project' NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "active_scratch_root_id" text;--> statement-breakpoint
UPDATE "chats" AS "chat"
SET "owner_id" = "project"."owner_id"
FROM "projects" AS "project"
WHERE "project"."id" = "chat"."project_id";--> statement-breakpoint
ALTER TABLE "chats" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ALTER COLUMN "active_worktree_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ALTER COLUMN "worktree_mode" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_project_owner_fk" FOREIGN KEY ("project_id", "owner_id") REFERENCES "public"."projects"("id", "owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_context_kind_check" CHECK ("chats"."context_kind" IN ('project', 'standalone'));--> statement-breakpoint
CREATE UNIQUE INDEX "chats_id_owner_unique" ON "chats" USING btree ("id", "owner_id");--> statement-breakpoint

CREATE TABLE "standalone_chat_roots" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"protected_path_handle" text NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"provisioning_revision" integer DEFAULT 1 NOT NULL,
	"deletion_job_id" text,
	"archived_at" timestamp with time zone,
	"archive_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "standalone_chat_roots_chat_unique" UNIQUE("chat_id"),
	CONSTRAINT "standalone_chat_roots_identity_unique" UNIQUE("id", "chat_id", "owner_id", "worker_id"),
	CONSTRAINT "standalone_chat_roots_execution_identity_unique" UNIQUE("id", "chat_id", "worker_id"),
	CONSTRAINT "standalone_chat_roots_chat_owner_fk" FOREIGN KEY ("chat_id", "owner_id") REFERENCES "public"."chats"("id", "owner_id") ON DELETE cascade ON UPDATE no action DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "standalone_chat_roots_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "standalone_chat_roots_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "standalone_chat_roots_status_check" CHECK ("standalone_chat_roots"."status" IN ('provisioning', 'ready', 'offline', 'failed', 'deleting')),
	CONSTRAINT "standalone_chat_roots_revision_check" CHECK ("standalone_chat_roots"."provisioning_revision" >= 1),
	CONSTRAINT "standalone_chat_roots_archive_deadline_check" CHECK (("standalone_chat_roots"."archived_at" IS NULL AND "standalone_chat_roots"."archive_expires_at" IS NULL) OR ("standalone_chat_roots"."archived_at" IS NOT NULL AND "standalone_chat_roots"."archive_expires_at" IS NOT NULL AND "standalone_chat_roots"."archive_expires_at" > "standalone_chat_roots"."archived_at"))
);--> statement-breakpoint

ALTER TABLE "chats" ADD CONSTRAINT "chats_active_scratch_root_identity_fk" FOREIGN KEY ("active_scratch_root_id", "id", "owner_id", "active_worker_id") REFERENCES "public"."standalone_chat_roots"("id", "chat_id", "owner_id", "worker_id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_execution_root_check" CHECK (("chats"."context_kind" = 'project' AND "chats"."project_id" IS NOT NULL AND "chats"."active_worktree_id" IS NOT NULL AND "chats"."active_scratch_root_id" IS NULL AND "chats"."worktree_mode" IN ('agent-managed', 'pinned')) OR ("chats"."context_kind" = 'standalone' AND "chats"."project_id" IS NULL AND "chats"."active_worker_id" IS NOT NULL AND "chats"."active_worktree_id" IS NULL AND "chats"."active_scratch_root_id" IS NOT NULL AND "chats"."worktree_mode" IS NULL AND "chats"."experience" = 'agent' AND "chats"."custom_subagent_model" = false AND "chats"."subagent_model_id" IS NULL AND "chats"."subagent_reasoning_effort" IS NULL AND "chats"."plan_mode" = 'default' AND "chats"."protected_plan" IS NULL AND "chats"."has_pending_plan_question" = false AND "chats"."automation_paused" = false));--> statement-breakpoint
CREATE UNIQUE INDEX "chats_active_scratch_root_unique" ON "chats" USING btree ("active_scratch_root_id") WHERE "chats"."active_scratch_root_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chats_owner_context_archived_position_index" ON "chats" USING btree ("owner_id", "context_kind", "archived_at", "position");--> statement-breakpoint
CREATE INDEX "standalone_chat_roots_owner_status_index" ON "standalone_chat_roots" USING btree ("owner_id", "status", "updated_at");--> statement-breakpoint
CREATE INDEX "standalone_chat_roots_worker_status_index" ON "standalone_chat_roots" USING btree ("worker_id", "status", "updated_at");--> statement-breakpoint

ALTER TABLE "chat_runtime_sessions" ADD COLUMN "scratch_root_id" text;--> statement-breakpoint
ALTER TABLE "chat_runtime_sessions" ALTER COLUMN "worktree_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_runtime_sessions" ADD CONSTRAINT "chat_runtime_sessions_scratch_identity_fk" FOREIGN KEY ("scratch_root_id", "chat_id", "worker_id") REFERENCES "public"."standalone_chat_roots"("id", "chat_id", "worker_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP INDEX "chat_runtime_sessions_chat_worker_worktree_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "chat_runtime_sessions_chat_worker_worktree_unique" ON "chat_runtime_sessions" USING btree ("chat_id", "worker_id", "worktree_id") WHERE "chat_runtime_sessions"."worktree_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_runtime_sessions_chat_worker_scratch_unique" ON "chat_runtime_sessions" USING btree ("chat_id", "worker_id", "scratch_root_id") WHERE "chat_runtime_sessions"."scratch_root_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_runtime_sessions" ADD CONSTRAINT "chat_runtime_sessions_execution_root_check" CHECK (num_nonnulls("chat_runtime_sessions"."worktree_id", "chat_runtime_sessions"."scratch_root_id") = 1);--> statement-breakpoint

ALTER TABLE "chat_execution_lanes" ADD COLUMN "scratch_root_id" text;--> statement-breakpoint
ALTER TABLE "chat_execution_lanes" ALTER COLUMN "worktree_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_execution_lanes" ADD CONSTRAINT "chat_execution_lanes_scratch_identity_fk" FOREIGN KEY ("scratch_root_id", "chat_id", "worker_id") REFERENCES "public"."standalone_chat_roots"("id", "chat_id", "worker_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
DROP INDEX "chat_execution_lanes_worktree_reserved_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "chat_execution_lanes_worktree_reserved_unique" ON "chat_execution_lanes" USING btree ("worktree_id") WHERE "chat_execution_lanes"."worktree_id" IS NOT NULL AND "chat_execution_lanes"."exclusive" = true AND "chat_execution_lanes"."state" <> 'released';--> statement-breakpoint
CREATE UNIQUE INDEX "chat_execution_lanes_scratch_reserved_unique" ON "chat_execution_lanes" USING btree ("scratch_root_id") WHERE "chat_execution_lanes"."scratch_root_id" IS NOT NULL AND "chat_execution_lanes"."state" <> 'released';--> statement-breakpoint
ALTER TABLE "chat_execution_lanes" ADD CONSTRAINT "chat_execution_lanes_execution_root_check" CHECK (num_nonnulls("chat_execution_lanes"."worktree_id", "chat_execution_lanes"."scratch_root_id") = 1);--> statement-breakpoint

ALTER TABLE "agent_interaction_requests" ADD COLUMN "owner_id" text;--> statement-breakpoint
UPDATE "agent_interaction_requests" AS "interaction"
SET "owner_id" = "project"."owner_id"
FROM "projects" AS "project"
WHERE "project"."id" = "interaction"."project_id";--> statement-breakpoint
ALTER TABLE "agent_interaction_requests" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_interaction_requests" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_interaction_requests" ADD CONSTRAINT "agent_interaction_requests_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_interaction_requests" ADD CONSTRAINT "agent_interaction_requests_context_check" CHECK ("agent_interaction_requests"."project_id" IS NOT NULL OR "agent_interaction_requests"."chat_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "agent_interaction_requests" ADD CONSTRAINT "agent_interaction_requests_project_owner_fk" FOREIGN KEY ("project_id", "owner_id") REFERENCES "public"."projects"("id", "owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_interaction_requests" ADD CONSTRAINT "agent_interaction_requests_chat_owner_fk" FOREIGN KEY ("chat_id", "owner_id") REFERENCES "public"."chats"("id", "owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_interaction_requests_owner_status_index" ON "agent_interaction_requests" USING btree ("owner_id", "status", "created_at");
