DROP INDEX "chat_execution_lanes_worktree_reserved_unique";--> statement-breakpoint
ALTER TABLE "chat_execution_lanes" ADD COLUMN "exclusive" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "queued_prompts" ADD COLUMN "worktree_id" text;--> statement-breakpoint
UPDATE "chat_execution_lanes" AS "lane"
SET "exclusive" = false
FROM "project_worktrees" AS "worktree"
WHERE "lane"."worktree_id" = "worktree"."id"
  AND "worktree"."is_primary" = true;--> statement-breakpoint
ALTER TABLE "queued_prompts" ADD CONSTRAINT "queued_prompts_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_execution_lanes_worktree_reserved_unique" ON "chat_execution_lanes" USING btree ("worktree_id") WHERE "chat_execution_lanes"."exclusive" = true AND "chat_execution_lanes"."state" <> 'released';
