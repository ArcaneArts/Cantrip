ALTER TABLE "user_settings" ADD COLUMN "pro_mode_opacity" integer DEFAULT 80 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_pro_mode_opacity_check" CHECK ("user_settings"."pro_mode_opacity" BETWEEN 0 AND 100);
