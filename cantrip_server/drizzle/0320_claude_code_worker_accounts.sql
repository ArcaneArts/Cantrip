ALTER TABLE model_provider_accounts
    ADD COLUMN bound_worker_id text REFERENCES workers(id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX model_providers_owner_claude_code_unique
    ON model_providers(owner_id) WHERE kind = 'claude-code';
