-- Restore the file-placement projection of already captured Linux Runs. The
-- runtime's immutable target remains the authority; Host terminals are unchanged.
-- A single DO statement makes the temporary trigger suspension and backfill
-- atomic even for callers that apply migration statements individually.
DO $$
BEGIN
  ALTER TABLE terminals DISABLE TRIGGER terminal_os_capture_immutable;
  UPDATE terminals t SET
    cantrip_os_binding_id = r.os_execution->'target'->'scope'->>'bindingId',
    os_binding_generation = r.os_execution->'target'->'scope'->>'bindingGeneration',
    os_attachment_generation = r.os_execution->'target'->'scope'->>'attachmentGeneration',
    os_runtime_generation = r.os_execution->'target'->'scope'->>'runtimeGeneration'
  FROM run_configuration_runtimes r
  WHERE t.kind = 'run-configuration'
    AND t.run_configuration_runtime_id = r.id
    AND t.worktree_id = r.worktree_id AND t.project_id = r.project_id
    AND r.os_execution IS NOT NULL AND t.cantrip_os_binding_id IS NULL;
  ALTER TABLE terminals ENABLE TRIGGER terminal_os_capture_immutable;
END;
$$;
