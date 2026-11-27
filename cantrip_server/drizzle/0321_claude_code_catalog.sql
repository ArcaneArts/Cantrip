ALTER TABLE provider_models
    DROP CONSTRAINT provider_models_metadata_source_check,
    ADD CONSTRAINT provider_models_metadata_source_check CHECK
        (metadata_source IN ('ollama', 'openrouter', 'codex', 'grok', 'claude-code', 'zai', 'compatible-api', 'manual'));
