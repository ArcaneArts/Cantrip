-- An absent recovery marker must stay SQL NULL. JSON null has no Source
-- identity, but SQL IS NOT NULL readers can mistake it for pending Goal work.
UPDATE task_dispatch_cycles
SET goal_cycle_recovery = NULL
WHERE goal_cycle_recovery = 'null'::jsonb;
