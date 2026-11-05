-- Legacy inputs have no digest. New terminal receipts are bounded metadata on
-- their canonical round; a completed receipt never stores another response body.
ALTER TABLE task_planning_rounds ADD CONSTRAINT task_round_outcome_receipt_check CHECK (
  inference_input->'terminal'->'outcomeDigest' IS NULL OR COALESCE((
    jsonb_typeof(inference_input->'terminal'->'outcomeDigest') = 'string'
    AND inference_input->'terminal'->>'outcomeDigest' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(inference_input->'terminal'->'ok') = 'boolean'
    AND jsonb_typeof(inference_input->'terminal'->'observedAt') = 'string'
    AND jsonb_typeof(inference_input->'terminal'->'projectedAt') = 'string'
  ), false)
);
