ALTER TABLE "chat_relocation_jobs" ADD COLUMN "target_model_route_id" text;--> statement-breakpoint
ALTER TABLE "chat_relocation_snapshots" ADD COLUMN "required_revision" text;--> statement-breakpoint
UPDATE "chat_relocation_snapshots" AS "snapshot"
SET "required_revision" = COALESCE("worktree"."head", repeat('0', 40))
FROM "chat_relocation_jobs" AS "job"
LEFT JOIN "project_worktrees" AS "worktree"
  ON "worktree"."id" = ("job"."source_placement"->>'worktreeId')
WHERE "job"."id" = "snapshot"."job_id";--> statement-breakpoint
UPDATE "chat_relocation_snapshots"
SET "required_revision" = repeat('0', 40)
WHERE "required_revision" IS NULL;--> statement-breakpoint
ALTER TABLE "chat_relocation_snapshots" ALTER COLUMN "required_revision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "chat_relocation_capability" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_relocation_jobs" ADD CONSTRAINT "chat_relocation_jobs_target_model_route_id_model_routes_id_fk" FOREIGN KEY ("target_model_route_id") REFERENCES "public"."model_routes"("id") ON DELETE set null ON UPDATE no action;
