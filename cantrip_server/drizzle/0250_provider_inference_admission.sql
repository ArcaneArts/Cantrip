ALTER TABLE model_providers
  ADD COLUMN max_concurrent_inference integer NOT NULL DEFAULT 8,
  ADD COLUMN inference_config_revision integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT model_providers_max_concurrent_inference_check CHECK (max_concurrent_inference > 0),
  ADD CONSTRAINT model_providers_inference_config_revision_check CHECK (inference_config_revision >= 0);
--> statement-breakpoint
-- Both server implementations use the same atomic revision. Omitted legacy
-- mutation fields preserve the value; unrelated provider edits do not advance it.
CREATE FUNCTION advance_provider_inference_config_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.max_concurrent_inference IS DISTINCT FROM OLD.max_concurrent_inference THEN
    NEW.inference_config_revision := OLD.inference_config_revision + 1;
  ELSE
    NEW.inference_config_revision := OLD.inference_config_revision;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER model_provider_inference_config_revision
BEFORE UPDATE ON model_providers FOR EACH ROW
EXECUTE FUNCTION advance_provider_inference_config_revision();
