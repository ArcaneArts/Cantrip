-- Keep completed Agent Stops held until a user sends another prompt.
-- Some already queued submissions cleared the autonomy flag without starting.
UPDATE chats
SET automation_paused = false, managed_autonomy_stopped = true
WHERE experience = 'agent'
  AND archived_at IS NULL
  AND automation_paused
  AND status NOT IN ('running', 'waiting-for-approval')
  AND native_suspension_state->>'action' = 'stop'
  AND native_suspension_state->>'phase' = 'stopped';
