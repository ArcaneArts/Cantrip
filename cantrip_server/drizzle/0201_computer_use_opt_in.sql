ALTER TABLE "user_settings" ADD COLUMN "computer_use_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Revocation commits with the setting on every server instance. Advance all
-- account chats, including explicit YOLO profiles, and notify existing workers.
CREATE FUNCTION "advance_computer_use_opt_in_authority"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE affected_chat record;
BEGIN
  FOR affected_chat IN
    UPDATE "chats"
    SET "computer_use_authority_generation" = "computer_use_authority_generation" + 1
    WHERE "owner_id" = NEW."user_id"
    RETURNING "id"
  LOOP
    PERFORM pg_notify('cantrip_computer_use_authority', json_build_object(
      'ownerId', NEW."user_id", 'scope', json_build_object('kind', 'chat', 'chatId', affected_chat."id")
    )::text);
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "user_settings_computer_use_opt_in_changed"
AFTER UPDATE OF "computer_use_enabled" ON "user_settings"
FOR EACH ROW
WHEN (NEW."computer_use_enabled" IS DISTINCT FROM OLD."computer_use_enabled")
EXECUTE FUNCTION "advance_computer_use_opt_in_authority"();
