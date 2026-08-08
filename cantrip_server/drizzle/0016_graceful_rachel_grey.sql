CREATE TABLE "chat_execution_lanes" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"worktree_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"acquiring_actor" text NOT NULL,
	"purpose" text,
	"state" text NOT NULL,
	"base_revision" text,
	"starting_head" text,
	"runtime_session_id" text,
	"codex_thread_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_worktrees" (
	"id" text PRIMARY KEY NOT NULL,
	"project_source_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"name" text NOT NULL,
	"absolute_path" text NOT NULL,
	"display_path" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"origin" text NOT NULL,
	"lifecycle_state" text DEFAULT 'creating' NOT NULL,
	"branch" text,
	"head" text,
	"detached" boolean DEFAULT false NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"lock_reason" text,
	"last_scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "chat_runtime_sessions_chat_worker_unique";--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "worktree_id" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "execution_lane_id" text;--> statement-breakpoint
ALTER TABLE "chat_runtime_sessions" ADD COLUMN "worktree_id" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "active_worktree_id" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "worktree_mode" text DEFAULT 'agent-managed' NOT NULL;--> statement-breakpoint
ALTER TABLE "explorers" ADD COLUMN "worktree_id" text;--> statement-breakpoint
ALTER TABLE "project_views" ADD COLUMN "worktree_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "worktree_policy" text DEFAULT 'agent-managed' NOT NULL;--> statement-breakpoint
ALTER TABLE "terminals" ADD COLUMN "worktree_id" text;--> statement-breakpoint
INSERT INTO "project_worktrees" (
	"id",
	"project_source_id",
	"worker_id",
	"name",
	"absolute_path",
	"display_path",
	"is_primary",
	"is_default",
	"origin",
	"lifecycle_state",
	"created_at",
	"updated_at"
)
SELECT
	'primary:' || "id",
	"id",
	"worker_id",
	'Primary',
	"absolute_path",
	"display_path",
	true,
	true,
	'cantrip',
	'ready',
	"created_at",
	"updated_at"
FROM "project_sources";--> statement-breakpoint
UPDATE "chats" AS "chat"
SET "active_worktree_id" = 'primary:' || "source"."id"
FROM "project_sources" AS "source"
WHERE "source"."project_id" = "chat"."project_id";--> statement-breakpoint
UPDATE "terminals" AS "terminal"
SET "worktree_id" = 'primary:' || "source"."id"
FROM "project_sources" AS "source"
WHERE "source"."project_id" = "terminal"."project_id";--> statement-breakpoint
UPDATE "explorers" AS "explorer"
SET "worktree_id" = 'primary:' || "source"."id"
FROM "project_sources" AS "source"
WHERE "source"."project_id" = "explorer"."project_id";--> statement-breakpoint
UPDATE "project_views" AS "view"
SET "worktree_id" = 'primary:' || "source"."id"
FROM "project_sources" AS "source"
WHERE "source"."project_id" = "view"."project_id"
	AND "view"."kind" = 'history';--> statement-breakpoint
UPDATE "chat_runtime_sessions" AS "runtime"
SET "worktree_id" = 'primary:' || "source"."id"
FROM "chats" AS "chat", "project_sources" AS "source"
WHERE "chat"."id" = "runtime"."chat_id"
	AND "source"."project_id" = "chat"."project_id";--> statement-breakpoint
INSERT INTO "chat_execution_lanes" (
	"id",
	"chat_id",
	"worktree_id",
	"worker_id",
	"acquiring_actor",
	"purpose",
	"state",
	"runtime_session_id",
	"codex_thread_id",
	"created_at",
	"activated_at",
	"released_at",
	"updated_at"
)
SELECT
	'legacy-primary-lane:' || "chat"."id",
	"chat"."id",
	'primary:' || "source"."id",
	"source"."worker_id",
	'user',
	'Migrated Primary execution',
	'released',
	"runtime"."id",
	"runtime"."codex_thread_id",
	"chat"."created_at",
	"chat"."created_at",
	now(),
	now()
FROM "chats" AS "chat"
INNER JOIN "project_sources" AS "source"
	ON "source"."project_id" = "chat"."project_id"
LEFT JOIN "chat_runtime_sessions" AS "runtime"
	ON "runtime"."chat_id" = "chat"."id"
	AND "runtime"."worker_id" = "source"."worker_id";--> statement-breakpoint
UPDATE "chat_messages" AS "message"
SET
	"worktree_id" = "chat"."active_worktree_id",
	"execution_lane_id" = 'legacy-primary-lane:' || "chat"."id"
FROM "chats" AS "chat"
WHERE "chat"."id" = "message"."chat_id";--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "worktree_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_runtime_sessions" ALTER COLUMN "worktree_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ALTER COLUMN "active_worktree_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "explorers" ALTER COLUMN "worktree_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "terminals" ALTER COLUMN "worktree_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_execution_lanes" ADD CONSTRAINT "chat_execution_lanes_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_execution_lanes" ADD CONSTRAINT "chat_execution_lanes_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_execution_lanes" ADD CONSTRAINT "chat_execution_lanes_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_execution_lanes" ADD CONSTRAINT "chat_execution_lanes_runtime_session_id_chat_runtime_sessions_id_fk" FOREIGN KEY ("runtime_session_id") REFERENCES "public"."chat_runtime_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_worktrees" ADD CONSTRAINT "project_worktrees_project_source_id_project_sources_id_fk" FOREIGN KEY ("project_source_id") REFERENCES "public"."project_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_worktrees" ADD CONSTRAINT "project_worktrees_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_execution_lanes_chat_active_unique" ON "chat_execution_lanes" USING btree ("chat_id") WHERE "chat_execution_lanes"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "chat_execution_lanes_worktree_reserved_unique" ON "chat_execution_lanes" USING btree ("worktree_id") WHERE "chat_execution_lanes"."state" <> 'released';--> statement-breakpoint
CREATE UNIQUE INDEX "project_worktrees_source_path_unique" ON "project_worktrees" USING btree ("project_source_id","absolute_path");--> statement-breakpoint
CREATE UNIQUE INDEX "project_worktrees_source_primary_unique" ON "project_worktrees" USING btree ("project_source_id") WHERE "project_worktrees"."is_primary" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "project_worktrees_source_default_unique" ON "project_worktrees" USING btree ("project_source_id") WHERE "project_worktrees"."is_default" = true;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_execution_lane_id_chat_execution_lanes_id_fk" FOREIGN KEY ("execution_lane_id") REFERENCES "public"."chat_execution_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_runtime_sessions" ADD CONSTRAINT "chat_runtime_sessions_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_active_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("active_worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explorers" ADD CONSTRAINT "explorers_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_views" ADD CONSTRAINT "project_views_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_runtime_sessions_chat_worker_worktree_unique" ON "chat_runtime_sessions" USING btree ("chat_id","worker_id","worktree_id");
