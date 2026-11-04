ALTER TABLE run_configuration_runtimes
  ADD COLUMN execution_key text NOT NULL DEFAULT 'worker',
  ADD COLUMN os_execution jsonb,
  ADD CONSTRAINT run_configuration_runtimes_execution_check CHECK (
    (execution_key = 'worker' AND os_execution IS NULL)
    OR (execution_key ~ '^cantrip-os:[0-9a-f]{64}$' AND os_execution IS NOT NULL AND jsonb_typeof(os_execution) = 'object'));
--> statement-breakpoint
DROP INDEX run_configuration_runtimes_identity_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX run_configuration_runtimes_identity_unique ON run_configuration_runtimes(project_id,configuration_id,worktree_id,execution_key);
--> statement-breakpoint
ALTER TABLE run_configuration_runtime_operations ADD COLUMN execution_key text NOT NULL DEFAULT 'worker';
--> statement-breakpoint
CREATE FUNCTION protect_cantrip_os_run_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_key IS DISTINCT FROM OLD.execution_key THEN
    RAISE EXCEPTION 'A Run execution identity is immutable';
  END IF;
  IF TG_TABLE_NAME = 'run_configuration_runtimes' THEN
    IF NEW.os_execution IS DISTINCT FROM OLD.os_execution THEN
      RAISE EXCEPTION 'A Linux Run placement capture is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER run_execution_capture_immutable BEFORE UPDATE ON run_configuration_runtimes FOR EACH ROW EXECUTE FUNCTION protect_cantrip_os_run_capture();
--> statement-breakpoint
CREATE TRIGGER run_operation_execution_immutable BEFORE UPDATE ON run_configuration_runtime_operations FOR EACH ROW EXECUTE FUNCTION protect_cantrip_os_run_capture();
