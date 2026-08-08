ALTER TABLE "chat_execution_lanes" ADD COLUMN "transition_kind" text;--> statement-breakpoint
UPDATE "chat_runtime_sessions" SET "codex_thread_id" = NULL, "status" = 'detached';--> statement-breakpoint
UPDATE "chat_execution_lanes" SET "codex_thread_id" = NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_execution_lanes_chat_delivering_unique" ON "chat_execution_lanes" USING btree ("chat_id") WHERE "chat_execution_lanes"."state" = 'delivering';
