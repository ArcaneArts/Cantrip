-- A saved viewer keeps its destination across encrypted target updates and
-- reconnects. Retiring a runtime requires creating a new viewer explicitly.
CREATE FUNCTION cantrip_os_desktop_configuration_valid(config jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    jsonb_typeof(config) = 'object'
    AND config->>'kind' = 'desktop'
    AND config - 'kind' - 'osSource' = '{}'::jsonb
    AND (
      NOT config ? 'osSource'
      OR (
        jsonb_typeof(config->'osSource') = 'object'
        AND (config->'osSource') ?& ARRAY['bindingId','worktreeId','bindingGeneration','attachmentGeneration','runtimeGeneration']
        AND (config->'osSource') - 'bindingId' - 'worktreeId' - 'bindingGeneration' - 'attachmentGeneration' - 'runtimeGeneration' - 'desktopGeneration' = '{}'::jsonb
        AND jsonb_typeof(config->'osSource'->'bindingId') = 'string'
        AND jsonb_typeof(config->'osSource'->'worktreeId') = 'string'
        AND jsonb_typeof(config->'osSource'->'bindingGeneration') = 'string'
        AND jsonb_typeof(config->'osSource'->'attachmentGeneration') = 'string'
        AND jsonb_typeof(config->'osSource'->'runtimeGeneration') = 'string'
        AND (NOT (config->'osSource') ? 'desktopGeneration' OR (jsonb_typeof(config->'osSource'->'desktopGeneration') = 'string' AND config->'osSource'->>'desktopGeneration' ~ '^[a-f0-9]{64}$'))
      )
    ), false
  );
$$;
--> statement-breakpoint
ALTER TABLE remote_surfaces DROP CONSTRAINT remote_surfaces_public_configuration_check;
--> statement-breakpoint
ALTER TABLE remote_surfaces ADD CONSTRAINT remote_surfaces_public_configuration_check CHECK (
  (kind = 'browser' AND jsonb_typeof(configuration) = 'object' AND configuration->>'kind' = 'browser' AND configuration ? 'profileId' AND configuration - 'kind' - 'profileId' = '{}'::jsonb AND jsonb_typeof(configuration->'profileId') IN ('string','null'))
  OR (kind = 'desktop' AND cantrip_os_desktop_configuration_valid(configuration))
);
--> statement-breakpoint
ALTER TABLE remote_surfaces DROP CONSTRAINT remote_surfaces_desktop_private_state_check;
--> statement-breakpoint
ALTER TABLE remote_surfaces ADD CONSTRAINT remote_surfaces_desktop_private_state_check CHECK (
  kind <> 'desktop' OR (protected_state IS NOT NULL AND state_revision IS NOT NULL AND cantrip_os_desktop_configuration_valid(configuration))
);
--> statement-breakpoint
CREATE FUNCTION cantrip_os_desktop_capture_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.configuration->'osSource' IS NOT NULL
     OR NEW.configuration->'osSource' IS NOT NULL THEN
    IF OLD.configuration->'osSource' IS DISTINCT FROM NEW.configuration->'osSource'
       OR OLD.worker_id IS DISTINCT FROM NEW.worker_id
       OR OLD.project_id IS DISTINCT FROM NEW.project_id
       OR OLD.kind IS DISTINCT FROM NEW.kind THEN
      RAISE EXCEPTION 'A captured CantripOS desktop cannot be retargeted';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cantrip_os_desktop_capture_immutable
BEFORE UPDATE ON remote_surfaces
FOR EACH ROW EXECUTE FUNCTION cantrip_os_desktop_capture_immutable();
