ALTER TABLE chats ADD COLUMN native_suspension_state jsonb;
--> statement-breakpoint
-- Enforce the hold at the actual write, including legacy unpause writers.
-- Unknown/unsupported states remain held and inspectable until reconciled.
ALTER TABLE chats ADD CONSTRAINT chats_native_suspension_hold_check CHECK (
  native_suspension_state IS NULL OR CASE
    WHEN native_suspension_state->>'version' = '1' AND native_suspension_state->>'phase' IN ('running', 'idle', 'stopped', 'completed', 'failed') THEN true
    ELSE automation_paused
  END
);
