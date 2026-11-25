CREATE TABLE council_provider_recoveries (
    run_id text NOT NULL REFERENCES native_commands(operation_id) ON DELETE CASCADE,
    chat_id text NOT NULL REFERENCES council_agents(chat_id) ON DELETE CASCADE,
    source_operation_id text PRIMARY KEY REFERENCES native_commands(operation_id) ON DELETE CASCADE,
    source_turn_id text NOT NULL,
    phase text NOT NULL DEFAULT 'pending',
    handoff_id uuid,
    target_model_route_id text,
    target_provider_account_id text,
    continuation_prompt_id text REFERENCES queued_prompts(id) ON DELETE SET NULL,
    continuation_message_id text,
    history_message_ids text[] NOT NULL DEFAULT '{}',
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT council_provider_recovery_phase_check CHECK (
        phase IN ('pending','blocked','switching','continuation-queued','continued','cancelled')
    )
);
--> statement-breakpoint
CREATE INDEX council_provider_recoveries_chat_idx ON council_provider_recoveries(chat_id,updated_at DESC);
--> statement-breakpoint
CREATE INDEX council_provider_recoveries_run_idx ON council_provider_recoveries(run_id);
--> statement-breakpoint
CREATE UNIQUE INDEX council_provider_recoveries_prompt_idx ON council_provider_recoveries(continuation_prompt_id)
    WHERE continuation_prompt_id IS NOT NULL;
