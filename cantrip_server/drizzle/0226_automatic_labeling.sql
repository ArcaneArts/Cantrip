ALTER TABLE "user_settings" ADD COLUMN "auto_name_tasks" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "auto_name_chats" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "labeling_model_id" text REFERENCES "model_profiles"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "auto_title_pending" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "auto_title_claim" text;
