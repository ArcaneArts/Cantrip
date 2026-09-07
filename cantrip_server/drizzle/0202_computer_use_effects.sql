ALTER TABLE "user_settings" ADD COLUMN "computer_use_effects" jsonb DEFAULT '{"effect":"off","parameters":{}}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "computer_use_effects_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE FUNCTION "advance_computer_use_effects_revision"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."computer_use_effects_revision" := OLD."computer_use_effects_revision" + 1;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "user_settings_computer_use_effects_changed"
BEFORE UPDATE OF "computer_use_effects", "computer_use_enabled" ON "user_settings"
FOR EACH ROW
WHEN (NEW."computer_use_effects" IS DISTINCT FROM OLD."computer_use_effects"
   OR NEW."computer_use_enabled" IS DISTINCT FROM OLD."computer_use_enabled")
EXECUTE FUNCTION "advance_computer_use_effects_revision"();
