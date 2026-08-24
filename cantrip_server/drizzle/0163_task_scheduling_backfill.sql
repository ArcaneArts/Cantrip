UPDATE "tasks"
SET "completed_at" = "updated_at"
WHERE "state" = 'complete'
  AND "completed_at" IS NULL;--> statement-breakpoint
INSERT INTO "task_dispatch_cycles" (
	"id",
	"owner_id",
	"chat_id",
	"operation_id",
	"operation_kind",
	"state",
	"fifo_created_at",
	"requested_task_worker_id",
	"queued_at",
	"created_at",
	"updated_at"
)
SELECT
	(md5('legacy-task-dispatch:' || "tasks"."chat_id")::uuid)::text,
	"projects"."owner_id",
	"tasks"."chat_id",
	left('legacy-task:' || "tasks"."chat_id", 200),
	CASE WHEN "tasks"."plan_goal_enabled" THEN 'initial-plan' ELSE 'direct' END,
	'queued',
	"tasks"."created_at",
	"tasks"."requested_task_worker_id",
	"tasks"."created_at",
	"tasks"."created_at",
	"tasks"."updated_at"
FROM "tasks"
INNER JOIN "chats" ON "chats"."id" = "tasks"."chat_id"
INNER JOIN "projects" ON "projects"."id" = "chats"."project_id"
WHERE "tasks"."state" = 'draft'
	AND "tasks"."active_operation_id" IS NULL
	AND "chats"."archived_at" IS NULL
	AND NOT EXISTS (
		SELECT 1
		FROM "task_dispatch_cycles"
		WHERE "task_dispatch_cycles"."chat_id" = "tasks"."chat_id"
	);
