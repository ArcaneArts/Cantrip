-- Pre-release destructive reset: remove only Task-experience chats so no
-- plaintext Task message can survive activation of encrypted Task messages.
-- Cascades remove their Task rows, planning rounds, and Task chat messages.
DELETE FROM "chats" WHERE "experience" = 'task';--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "task_protected_content" jsonb;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "task_attachment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_content_shape_check" CHECK (("chat_messages"."content" IS NOT NULL AND "chat_messages"."task_protected_content" IS NULL) OR ("chat_messages"."content" IS NULL AND "chat_messages"."task_protected_content" IS NOT NULL));
