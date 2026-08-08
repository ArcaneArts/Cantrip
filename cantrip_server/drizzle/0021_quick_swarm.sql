ALTER TABLE "chats" ADD COLUMN "plan_mode" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "plan_explanation" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "plan_steps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "pending_plan_question" jsonb;