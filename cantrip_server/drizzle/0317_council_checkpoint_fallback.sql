ALTER TABLE council_live_provider_switches ADD COLUMN fallback_stop_id uuid;
--> statement-breakpoint
ALTER TABLE council_live_provider_switches DROP CONSTRAINT council_live_provider_switch_phase_check;
--> statement-breakpoint
ALTER TABLE council_live_provider_switches ADD CONSTRAINT council_live_provider_switch_phase_check
    CHECK (phase IN ('observed','pausing','restarting','resuming','reconciling','completed','continued','cancelled'));
