ALTER TABLE terminals ADD COLUMN cantrip_os_binding_id text REFERENCES cantrip_os_source_bindings(id) ON DELETE RESTRICT,
  ADD COLUMN os_binding_generation text, ADD COLUMN os_attachment_generation text, ADD COLUMN os_runtime_generation text,
  ADD CONSTRAINT terminal_os_capture_complete CHECK (
    (cantrip_os_binding_id IS NULL AND os_binding_generation IS NULL AND os_attachment_generation IS NULL AND os_runtime_generation IS NULL)
    OR (cantrip_os_binding_id IS NOT NULL AND os_binding_generation IS NOT NULL AND os_attachment_generation IS NOT NULL AND os_runtime_generation IS NOT NULL));
--> statement-breakpoint
UPDATE terminals t SET cantrip_os_binding_id=p.binding_id, os_binding_generation=p.binding_generation, os_attachment_generation=p.attachment_generation, os_runtime_generation=p.runtime_generation FROM cantrip_os_chat_placements p WHERE t.linked_chat_id=p.chat_id;
--> statement-breakpoint
CREATE TRIGGER terminal_os_capture_immutable BEFORE UPDATE ON terminals FOR EACH ROW EXECUTE FUNCTION protect_cantrip_os_file_capture();
