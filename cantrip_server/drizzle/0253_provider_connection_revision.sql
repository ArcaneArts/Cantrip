ALTER TABLE model_providers
  ADD COLUMN connection_revision integer NOT NULL DEFAULT 1
  CHECK (connection_revision > 0);
--> statement-breakpoint
CREATE FUNCTION invalidate_provider_connection_catalog() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.base_url IS DISTINCT FROM NEW.base_url
     OR OLD.protected_api_key IS DISTINCT FROM NEW.protected_api_key THEN
    NEW.connection_revision := OLD.connection_revision + 1;
    -- Retain catalog IDs, logical routes, visibility preferences and historical
    -- observations, but do not apply old capabilities to the new connection.
    UPDATE provider_models SET
      canonical_model_id = NULL, description = NULL,
      context_window = NULL, max_output_tokens = NULL,
      input_modalities = '["text"]'::jsonb, output_modalities = '["text"]'::jsonb,
      supports_tools = NULL, supports_parallel_tools = NULL,
      supports_structured_output = NULL, supports_vision = NULL,
      supports_reasoning = NULL, supported_reasoning_efforts = '[]'::jsonb,
      default_reasoning_effort = NULL, reasoning_mandatory = NULL,
      family = NULL, parameter_size = NULL, quantization = NULL, digest = NULL,
      metadata_source = 'manual', match_confidence_basis_points = NULL,
      raw_metadata = '{}'::jsonb, updated_at = now()
    WHERE provider_id = OLD.id;
    UPDATE provider_model_availability SET state = 'stale', updated_at = now()
    WHERE provider_model_id IN (SELECT id FROM provider_models WHERE provider_id = OLD.id);
    UPDATE provider_catalog_sync_states SET
      status = 'stale', error_code = 'provider-connection-changed',
      etag = NULL, refresh_started_at = NULL, last_success_at = NULL, updated_at = now()
    WHERE provider_id = OLD.id;
  ELSE
    NEW.connection_revision := OLD.connection_revision;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invalidate_provider_connection_catalog
BEFORE UPDATE ON model_providers
FOR EACH ROW EXECUTE FUNCTION invalidate_provider_connection_catalog();
