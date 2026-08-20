ALTER TABLE "chats" ADD COLUMN "protected_plan" jsonb;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "has_pending_plan_question" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" DROP COLUMN "plan_explanation";--> statement-breakpoint
ALTER TABLE "chats" DROP COLUMN "plan_steps";--> statement-breakpoint
ALTER TABLE "chats" DROP COLUMN "pending_plan_question";--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_protected_plan_question_check" CHECK (NOT "chats"."has_pending_plan_question" OR "chats"."protected_plan" IS NOT NULL);