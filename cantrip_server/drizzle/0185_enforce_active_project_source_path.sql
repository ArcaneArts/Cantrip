CREATE INDEX "project_sources_worker_path_active_index"
ON "project_sources" USING btree ("worker_id", "absolute_path")
WHERE "removed_at" IS NULL;
--> statement-breakpoint
CREATE FUNCTION "enforce_active_project_source_path"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."removed_at" IS NOT NULL THEN
		RETURN NEW;
	END IF;

	IF TG_OP = 'UPDATE'
		AND OLD."removed_at" IS NULL
		AND NEW."worker_id" IS NOT DISTINCT FROM OLD."worker_id"
		AND NEW."absolute_path" IS NOT DISTINCT FROM OLD."absolute_path"
	THEN
		RETURN NEW;
	END IF;

	PERFORM 1
	FROM "workers"
	WHERE "id" = NEW."worker_id"
	FOR UPDATE;

	IF EXISTS (
		SELECT 1
		FROM "project_sources"
		WHERE "worker_id" = NEW."worker_id"
			AND "absolute_path" = NEW."absolute_path"
			AND "removed_at" IS NULL
			AND "id" IS DISTINCT FROM NEW."id"
	) THEN
		RAISE EXCEPTION 'An active project source already owns this worker path.'
			USING
				ERRCODE = '23505',
				CONSTRAINT = 'project_sources_worker_path_active_unique';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_sources_worker_path_active_unique"
BEFORE INSERT OR UPDATE OF "worker_id", "absolute_path", "removed_at"
ON "project_sources"
FOR EACH ROW
EXECUTE FUNCTION "enforce_active_project_source_path"();
