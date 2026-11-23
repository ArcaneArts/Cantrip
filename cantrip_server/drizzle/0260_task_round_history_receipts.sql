-- Historical completion is positive publication evidence only. No prompt body
-- or independent pending-input queue is introduced by this optional marker.
ALTER TABLE task_planning_rounds ADD CONSTRAINT task_round_history_receipt_check CHECK (
  inference_input->'terminal'->'historyOnly' IS NULL
  OR jsonb_typeof(inference_input->'terminal'->'historyOnly') = 'boolean'
);
