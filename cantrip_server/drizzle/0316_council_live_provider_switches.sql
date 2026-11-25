CREATE TABLE council_live_provider_switches (
    source_operation_id text PRIMARY KEY REFERENCES native_commands(operation_id) ON DELETE CASCADE,
    chat_id text NOT NULL REFERENCES council_agents(chat_id) ON DELETE CASCADE,
    source_thread_id text NOT NULL,
    source_turn_id text NOT NULL,
    source_runtime_generation text NOT NULL,
    phase text NOT NULL DEFAULT 'observed',
    target_model_route_id text,
    target_provider_account_id text,
    pause_control_id uuid,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT council_live_provider_switch_phase_check CHECK (
        phase IN ('observed','pausing','restarting','resuming','completed','cancelled')
    )
);
--> statement-breakpoint
CREATE INDEX council_live_provider_switches_chat_idx ON council_live_provider_switches(chat_id,updated_at DESC);
