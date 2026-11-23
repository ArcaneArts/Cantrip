CREATE OR REPLACE FUNCTION invalidate_provider_connection_catalog() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.base_url IS DISTINCT FROM NEW.base_url
     OR OLD.protected_api_key IS DISTINCT FROM NEW.protected_api_key THEN
    NEW.connection_revision := OLD.connection_revision + 1;
    -- Retain catalog IDs, logical routes, visibility preferences and historical
    -- observations, but do not apply old capabilities to the new connection.
    UPDATE provider_models SET
      operation_capabilities = '{}'::jsonb,
      canonical_model_id = NULL, description = NULL,
      context_window = NULL, max_output_tokens = NULL,
      input_modalities = '[]'::jsonb, output_modalities = '[]'::jsonb,
      supports_tools = NULL, supports_parallel_tools = NULL,
      supports_structured_output = NULL, supports_vision = NULL,
      supports_reasoning = NULL, supported_reasoning_efforts = '[]'::jsonb,
      default_reasoning_effort = NULL, reasoning_mandatory = NULL,
      family = NULL, parameter_size = NULL, quantization = NULL, digest = NULL,
      metadata_source = 'manual', match_confidence_basis_points = NULL,
      raw_metadata = '{}'::jsonb, updated_at = now()
    WHERE provider_id = OLD.id;
    UPDATE provider_model_availability SET
      operation_capabilities = '{}'::jsonb, state = 'stale', updated_at = now()
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
-- Earlier connection invalidation cleared native metadata but did not know about
-- operation capabilities. Remove those observations for scopes explicitly left
-- invalidated by a connection change; configured profiles/defaults are retained.
UPDATE provider_model_availability a SET operation_capabilities = '{}'::jsonb
FROM provider_models m, provider_catalog_sync_states s
WHERE a.provider_model_id = m.id AND s.provider_id = m.provider_id
  AND s.scope_key = a.scope_key AND s.error_code = 'provider-connection-changed';
--> statement-breakpoint
UPDATE provider_models m SET operation_capabilities = '{}'::jsonb
WHERE m.metadata_source = 'manual' AND EXISTS (
  SELECT 1 FROM provider_catalog_sync_states s
  WHERE s.provider_id = m.provider_id AND s.error_code = 'provider-connection-changed'
);
