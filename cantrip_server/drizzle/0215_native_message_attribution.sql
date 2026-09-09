ALTER TABLE "chat_messages" ADD COLUMN "native_model_attribution" jsonb;--> statement-breakpoint
ALTER TABLE "native_history_turns" ADD COLUMN "model_attribution" jsonb;--> statement-breakpoint
ALTER TABLE "native_history_turns" ADD COLUMN "captured_model_attribution" jsonb;
--> statement-breakpoint
UPDATE "native_history_turns" SET "captured_model_attribution" = "usage"->'modelAttribution' WHERE "usage"->'modelAttribution' IS NOT NULL;
