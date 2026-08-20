DELETE FROM "chat_messages" AS "message"
USING "chats" AS "chat"
WHERE "message"."chat_id" = "chat"."id"
  AND "chat"."experience" = 'agent'
  AND "message"."content" IS NOT NULL;--> statement-breakpoint
DELETE FROM "queued_prompts"
WHERE "opaque_content" IS NULL;
