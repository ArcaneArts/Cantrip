CREATE FUNCTION "enforce_project_workspace_membership_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
			OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
		THEN
			RAISE EXCEPTION 'Project workspace membership is immutable.'
				USING
					ERRCODE = '23514',
					CONSTRAINT = 'project_workspace_membership_immutable';
		END IF;
		RETURN NEW;
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "projects"
		WHERE "id" = OLD."project_id"
	) THEN
		RAISE EXCEPTION 'Project workspace membership cannot be removed while the project exists.'
			USING
				ERRCODE = '23514',
				CONSTRAINT = 'project_workspace_membership_required';
	END IF;

	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_workspace_membership_immutable"
BEFORE UPDATE OR DELETE
ON "project_workspace_memberships"
FOR EACH ROW
EXECUTE FUNCTION "enforce_project_workspace_membership_immutability"();
--> statement-breakpoint
CREATE FUNCTION "enforce_workspace_storage_profile_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
			OR NEW."kind" IS DISTINCT FROM OLD."kind"
			OR NEW."worker_id" IS DISTINCT FROM OLD."worker_id"
			OR NEW."protected_root_path_handle" IS DISTINCT FROM OLD."protected_root_path_handle"
			OR NEW."protected_display_handle" IS DISTINCT FROM OLD."protected_display_handle"
		THEN
			RAISE EXCEPTION 'Workspace storage identity is immutable.'
				USING
					ERRCODE = '23514',
					CONSTRAINT = 'project_workspace_storage_identity_immutable';
		END IF;
		RETURN NEW;
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "project_workspaces"
		WHERE "id" = OLD."workspace_id"
	) THEN
		RAISE EXCEPTION 'Workspace storage profile cannot be removed while the workspace exists.'
			USING
				ERRCODE = '23514',
				CONSTRAINT = 'project_workspace_storage_profile_required';
	END IF;

	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_workspace_storage_identity_immutable"
BEFORE UPDATE OR DELETE
ON "project_workspace_storage_profiles"
FOR EACH ROW
EXECUTE FUNCTION "enforce_workspace_storage_profile_immutability"();
