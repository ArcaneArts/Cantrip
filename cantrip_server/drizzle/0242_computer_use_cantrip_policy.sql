ALTER TABLE "user_settings" ADD COLUMN "computer_use_cantrip_app_allowed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Reuse the durable account-wide authority fence and post-commit cancellation.
-- Revoking app access stops existing sessions, including long native timelines.
CREATE TRIGGER "user_settings_computer_use_cantrip_policy_changed"
AFTER UPDATE OF "computer_use_cantrip_app_allowed" ON "user_settings"
FOR EACH ROW
WHEN (NEW."computer_use_cantrip_app_allowed" IS DISTINCT FROM OLD."computer_use_cantrip_app_allowed")
EXECUTE FUNCTION "advance_computer_use_opt_in_authority"();
