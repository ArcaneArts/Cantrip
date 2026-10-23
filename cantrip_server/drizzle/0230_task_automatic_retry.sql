ALTER TABLE "tasks" ADD COLUMN "automatic_retry" jsonb;
--> statement-breakpoint
CREATE INDEX "tasks_automatic_retry_pending_index" ON "tasks" ("updated_at")
WHERE "automatic_retry"->>'status' IN ('scheduled', 'retrying')
OR ("state" = 'failed' AND "automatic_retry" IS NULL AND "last_error" IS NOT NULL);
