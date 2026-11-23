CREATE TABLE cantrip_os_chat_placements (
  chat_id text PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  binding_id text NOT NULL REFERENCES cantrip_os_source_bindings(id) ON DELETE RESTRICT,
  binding_generation text NOT NULL,
  attachment_generation text NOT NULL,
  runtime_generation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE FUNCTION protect_cantrip_os_chat_placement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A captured OS chat placement cannot be retargeted';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cantrip_os_chat_placement_immutable
BEFORE UPDATE ON cantrip_os_chat_placements
FOR EACH ROW EXECUTE FUNCTION protect_cantrip_os_chat_placement();
