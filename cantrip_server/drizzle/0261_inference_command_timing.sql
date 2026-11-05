ALTER TABLE model_behavior_observations ADD COLUMN inference_timing jsonb;
--> statement-breakpoint
ALTER TABLE model_behavior_observations ADD CONSTRAINT model_behavior_inference_timing_check CHECK (
  inference_timing IS NULL OR (
    jsonb_typeof(inference_timing) = 'object'
    AND inference_timing ?& ARRAY['queueWaitMs','preparationMs','executionMs','suspendedMs','complete']
    AND jsonb_typeof(inference_timing->'complete') = 'boolean'
    AND (inference_timing - ARRAY['queueWaitMs','preparationMs','executionMs','suspendedMs','complete']) = '{}'::jsonb
    AND jsonb_typeof(inference_timing->'queueWaitMs') = 'number'
    AND jsonb_typeof(inference_timing->'preparationMs') = 'number'
    AND jsonb_typeof(inference_timing->'executionMs') = 'number'
    AND jsonb_typeof(inference_timing->'suspendedMs') = 'number'
    AND (inference_timing->>'queueWaitMs')::numeric BETWEEN 0 AND 9007199254740991
    AND (inference_timing->>'preparationMs')::numeric BETWEEN 0 AND 9007199254740991
    AND (inference_timing->>'executionMs')::numeric BETWEEN 0 AND 9007199254740991
    AND (inference_timing->>'suspendedMs')::numeric BETWEEN 0 AND 9007199254740991
    AND trunc((inference_timing->>'queueWaitMs')::numeric) = (inference_timing->>'queueWaitMs')::numeric
    AND trunc((inference_timing->>'preparationMs')::numeric) = (inference_timing->>'preparationMs')::numeric
    AND trunc((inference_timing->>'executionMs')::numeric) = (inference_timing->>'executionMs')::numeric
    AND trunc((inference_timing->>'suspendedMs')::numeric) = (inference_timing->>'suspendedMs')::numeric
  )
);
