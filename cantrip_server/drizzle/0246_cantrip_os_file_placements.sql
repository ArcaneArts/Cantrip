ALTER TABLE chats ADD COLUMN cantrip_os_binding_id text REFERENCES cantrip_os_source_bindings(id) ON DELETE RESTRICT, ADD COLUMN cantrip_os_runtime_generation text;
--> statement-breakpoint
UPDATE chats c SET cantrip_os_binding_id = p.binding_id, cantrip_os_runtime_generation = p.runtime_generation FROM cantrip_os_chat_placements p WHERE p.chat_id=c.id;
--> statement-breakpoint
ALTER TABLE explorers ADD COLUMN cantrip_os_binding_id text REFERENCES cantrip_os_source_bindings(id) ON DELETE RESTRICT,
  ADD COLUMN os_binding_generation text, ADD COLUMN os_attachment_generation text, ADD COLUMN os_runtime_generation text,
  ADD CONSTRAINT explorer_os_capture_complete CHECK (
    (cantrip_os_binding_id IS NULL AND os_binding_generation IS NULL AND os_attachment_generation IS NULL AND os_runtime_generation IS NULL)
    OR (cantrip_os_binding_id IS NOT NULL AND os_binding_generation IS NOT NULL AND os_attachment_generation IS NOT NULL AND os_runtime_generation IS NOT NULL));
--> statement-breakpoint
ALTER TABLE file_documents ADD COLUMN cantrip_os_binding_id text REFERENCES cantrip_os_source_bindings(id) ON DELETE RESTRICT,
  ADD COLUMN os_binding_generation text, ADD COLUMN os_attachment_generation text, ADD COLUMN os_runtime_generation text,
  ADD CONSTRAINT file_document_os_capture_complete CHECK (
    (cantrip_os_binding_id IS NULL AND os_binding_generation IS NULL AND os_attachment_generation IS NULL AND os_runtime_generation IS NULL)
    OR (cantrip_os_binding_id IS NOT NULL AND os_binding_generation IS NOT NULL AND os_attachment_generation IS NOT NULL AND os_runtime_generation IS NOT NULL));
--> statement-breakpoint
CREATE FUNCTION protect_cantrip_os_file_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.cantrip_os_binding_id,OLD.os_binding_generation,OLD.os_attachment_generation,OLD.os_runtime_generation)
    IS DISTINCT FROM (NEW.cantrip_os_binding_id,NEW.os_binding_generation,NEW.os_attachment_generation,NEW.os_runtime_generation) THEN
    RAISE EXCEPTION 'A captured OS file placement cannot be retargeted';
  END IF;
  IF OLD.cantrip_os_binding_id IS NOT NULL AND (OLD.worktree_id,OLD.project_id) IS DISTINCT FROM (NEW.worktree_id,NEW.project_id) THEN
    RAISE EXCEPTION 'A captured OS file worktree cannot be retargeted';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER explorer_os_capture_immutable BEFORE UPDATE ON explorers FOR EACH ROW EXECUTE FUNCTION protect_cantrip_os_file_capture();
--> statement-breakpoint
CREATE TRIGGER file_document_os_capture_immutable BEFORE UPDATE ON file_documents FOR EACH ROW EXECUTE FUNCTION protect_cantrip_os_file_capture();
--> statement-breakpoint
CREATE FUNCTION protect_cantrip_os_chat_binding_label() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.cantrip_os_binding_id,OLD.cantrip_os_runtime_generation) IS DISTINCT FROM (NEW.cantrip_os_binding_id,NEW.cantrip_os_runtime_generation) THEN
    RAISE EXCEPTION 'A captured OS chat binding cannot be retargeted';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER chat_os_binding_label_immutable BEFORE UPDATE ON chats FOR EACH ROW EXECUTE FUNCTION protect_cantrip_os_chat_binding_label();
