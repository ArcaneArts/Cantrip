CREATE TABLE "project_branch_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"branch_name" text NOT NULL,
	"chat_execution_lane_id" text,
	"workflow_worktree_lease_id" text,
	"worktree_id" text,
	"worker_id" text,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_branch_leases_holder_check" CHECK (("project_branch_leases"."chat_execution_lane_id" IS NOT NULL AND "project_branch_leases"."workflow_worktree_lease_id" IS NULL) OR ("project_branch_leases"."chat_execution_lane_id" IS NULL AND "project_branch_leases"."workflow_worktree_lease_id" IS NOT NULL)),
	CONSTRAINT "project_branch_leases_state_check" CHECK ("project_branch_leases"."state" IN ('active', 'released'))
);
--> statement-breakpoint
ALTER TABLE "project_branch_leases" ADD CONSTRAINT "project_branch_leases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_branch_leases" ADD CONSTRAINT "project_branch_leases_chat_execution_lane_id_chat_execution_lanes_id_fk" FOREIGN KEY ("chat_execution_lane_id") REFERENCES "public"."chat_execution_lanes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_branch_leases" ADD CONSTRAINT "project_branch_leases_workflow_worktree_lease_id_workflow_worktree_leases_id_fk" FOREIGN KEY ("workflow_worktree_lease_id") REFERENCES "public"."workflow_worktree_leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_branch_leases" ADD CONSTRAINT "project_branch_leases_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_branch_leases" ADD CONSTRAINT "project_branch_leases_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
WITH "branch_lease_candidates" AS (
	SELECT
		'chat:' || "lane"."id" AS "id",
		"chat"."project_id" AS "project_id",
		"worktree"."branch" AS "branch_name",
		"lane"."id" AS "chat_execution_lane_id",
		NULL::text AS "workflow_worktree_lease_id",
		"worktree"."id" AS "worktree_id",
		"worktree"."worker_id" AS "worker_id",
		CASE WHEN "lane"."state" = 'active' THEN 0 WHEN "lane"."state" = 'delivering' THEN 1 ELSE 3 END AS "priority",
		"lane"."created_at" AS "created_at"
	FROM "chat_execution_lanes" AS "lane"
	INNER JOIN "chats" AS "chat" ON "chat"."id" = "lane"."chat_id"
	INNER JOIN "project_worktrees" AS "worktree" ON "worktree"."id" = "lane"."worktree_id"
	WHERE "lane"."state" <> 'released'
		AND "worktree"."branch" IS NOT NULL
		AND ("worktree"."is_primary" = false OR "lane"."state" IN ('active', 'delivering'))
	UNION ALL
	SELECT
		'workflow:' || "lease"."id" AS "id",
		"run"."project_id" AS "project_id",
		"lease"."branch_name" AS "branch_name",
		NULL::text AS "chat_execution_lane_id",
		"lease"."id" AS "workflow_worktree_lease_id",
		"lease"."worktree_id" AS "worktree_id",
		"lease"."worker_id" AS "worker_id",
		CASE WHEN "lease"."state" = 'active' THEN 0 WHEN "lease"."state" IN ('allocating', 'recovering') THEN 1 ELSE 2 END AS "priority",
		"lease"."created_at" AS "created_at"
	FROM "workflow_worktree_leases" AS "lease"
	INNER JOIN "workflow_runs" AS "run" ON "run"."id" = "lease"."run_id"
	WHERE "lease"."state" NOT IN ('released', 'failed')
		AND "run"."project_id" IS NOT NULL
		AND "lease"."branch_name" IS NOT NULL
), "ranked_branch_lease_candidates" AS (
	SELECT *, ROW_NUMBER() OVER (
		PARTITION BY "project_id", "branch_name"
		ORDER BY "priority", "created_at", "id"
	) AS "branch_rank"
	FROM "branch_lease_candidates"
)
INSERT INTO "project_branch_leases" (
	"id",
	"project_id",
	"branch_name",
	"chat_execution_lane_id",
	"workflow_worktree_lease_id",
	"worktree_id",
	"worker_id",
	"state",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	"project_id",
	"branch_name",
	"chat_execution_lane_id",
	"workflow_worktree_lease_id",
	"worktree_id",
	"worker_id",
	'active',
	"created_at",
	"created_at"
FROM "ranked_branch_lease_candidates"
WHERE "branch_rank" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX "project_branch_leases_active_branch_unique" ON "project_branch_leases" USING btree ("project_id","branch_name") WHERE "project_branch_leases"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "project_branch_leases_chat_lane_unique" ON "project_branch_leases" USING btree ("chat_execution_lane_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_branch_leases_workflow_lease_unique" ON "project_branch_leases" USING btree ("workflow_worktree_lease_id");--> statement-breakpoint
CREATE INDEX "project_branch_leases_project_state_index" ON "project_branch_leases" USING btree ("project_id","state");
