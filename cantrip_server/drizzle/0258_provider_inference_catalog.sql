CREATE TABLE provider_inference_catalogs (
  owner_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
--> statement-breakpoint
INSERT INTO provider_inference_catalogs(owner_id)
SELECT DISTINCT owner_id FROM model_providers;
--> statement-breakpoint
ALTER TABLE model_providers
  ADD COLUMN inference_catalog_created_revision integer NOT NULL DEFAULT 0
  CHECK (inference_catalog_created_revision >= 0);
--> statement-breakpoint
CREATE FUNCTION advance_provider_inference_catalog() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_owner text;
  next_revision integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id THEN
    NEW.inference_catalog_created_revision := OLD.inference_catalog_created_revision;
    RETURN NEW;
  END IF;
  -- Ownership changes invalidate both catalogs. Normal provider edits do not
  -- change membership or the provider's original creation ordinal.
  IF TG_OP = 'UPDATE' THEN
    INSERT INTO provider_inference_catalogs(owner_id, revision)
      SELECT id, 1 FROM users WHERE id = OLD.owner_id
    ON CONFLICT (owner_id) DO UPDATE
      SET revision = provider_inference_catalogs.revision + 1;
  END IF;
  target_owner := CASE WHEN TG_OP = 'DELETE' THEN OLD.owner_id ELSE NEW.owner_id END;
  -- A cascading user deletion must not recreate a catalog for its deleted user.
  INSERT INTO provider_inference_catalogs(owner_id, revision)
    SELECT id, 1 FROM users WHERE id = target_owner
  ON CONFLICT (owner_id) DO UPDATE
    SET revision = provider_inference_catalogs.revision + 1
  RETURNING revision INTO next_revision;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  NEW.inference_catalog_created_revision := coalesce(next_revision, 0);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER model_provider_inference_catalog
BEFORE INSERT OR UPDATE OR DELETE ON model_providers
FOR EACH ROW EXECUTE FUNCTION advance_provider_inference_catalog();
