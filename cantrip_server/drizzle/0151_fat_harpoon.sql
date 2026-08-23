ALTER TABLE "chats" ADD COLUMN "custom_subagent_model" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "subagent_model_id" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "subagent_reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "queued_prompts" ADD COLUMN "custom_subagent_model" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "queued_prompts" ADD COLUMN "subagent_model_id" text;--> statement-breakpoint
ALTER TABLE "queued_prompts" ADD COLUMN "subagent_reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "default_reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "default_custom_subagent_model" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "default_subagent_model_id" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "default_subagent_reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_subagent_model_id_model_profiles_id_fk" FOREIGN KEY ("subagent_model_id") REFERENCES "public"."model_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queued_prompts" ADD CONSTRAINT "queued_prompts_subagent_model_id_model_profiles_id_fk" FOREIGN KEY ("subagent_model_id") REFERENCES "public"."model_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_default_subagent_model_id_model_profiles_id_fk" FOREIGN KEY ("default_subagent_model_id") REFERENCES "public"."model_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_custom_subagent_model_check" CHECK (NOT "chats"."custom_subagent_model" OR "chats"."subagent_model_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "queued_prompts" ADD CONSTRAINT "queued_prompts_custom_subagent_model_check" CHECK (NOT "queued_prompts"."custom_subagent_model" OR "queued_prompts"."subagent_model_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_custom_subagent_model_check" CHECK (NOT "user_settings"."default_custom_subagent_model" OR "user_settings"."default_subagent_model_id" IS NOT NULL);