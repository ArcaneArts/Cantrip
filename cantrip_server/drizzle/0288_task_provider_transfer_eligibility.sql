-- Retain the pending scheduler reason while the original Goal input is transferred.
ALTER TABLE task_dispatch_cycles
  DROP CONSTRAINT task_dispatch_cycles_eligibility_code_check,
  ADD CONSTRAINT task_dispatch_cycles_eligibility_code_check
  CHECK (
    eligibility_code IS NULL OR eligibility_code IN (
      'assignment-mismatch',
      'capacity-unavailable',
      'continuity-mismatch',
      'encryption-grant-unavailable',
      'model-unavailable',
      'plan-goal-unsupported',
      'placement-unavailable',
      'project-paused',
      'provider-route-unavailable',
      'provider-transfer-pending',
      'reconciliation-required',
      'task-worker-disabled',
      'worker-offline'
    )
  );
