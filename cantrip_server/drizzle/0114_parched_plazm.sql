ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_content_shape_check";--> statement-breakpoint
ALTER TABLE "queued_prompts" ALTER COLUMN "text" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "protected_content" jsonb;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "attachment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "queued_prompts" ADD COLUMN "opaque_content" jsonb;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_content_shape_check" CHECK ((CASE WHEN "chat_messages"."content" IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN "chat_messages"."protected_content" IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN "chat_messages"."task_protected_content" IS NOT NULL THEN 1 ELSE 0 END) = 1);--> statement-breakpoint
ALTER TABLE "queued_prompts" ADD CONSTRAINT "queued_prompts_content_shape_check" CHECK (("queued_prompts"."text" IS NOT NULL AND "queued_prompts"."opaque_content" IS NULL) OR ("queued_prompts"."text" IS NULL AND "queued_prompts"."opaque_content" IS NOT NULL));