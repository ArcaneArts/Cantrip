ALTER TABLE "chats" ADD COLUMN "computer_use_authority_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_computer_use_authority_generation_check" CHECK ("chats"."computer_use_authority_generation" >= 1);
--> statement-breakpoint
-- This is an authorization lifetime, not a chat activity revision. In particular,
-- ordinary turns, message writes, status changes and no-op updates do not revoke
-- a preview. The fence commits with the authority change on every server instance.
CREATE FUNCTION "advance_chat_computer_use_authority"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."computer_use_authority_generation" := OLD."computer_use_authority_generation" + 1;
  PERFORM pg_notify('cantrip_computer_use_authority', json_build_object(
    'ownerId', OLD."owner_id", 'scope', json_build_object('kind', 'chat', 'chatId', OLD."id")
  )::text);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "chats_computer_use_authority_changed"
BEFORE UPDATE OF "permission_profile_id", "owner_id", "context_kind", "project_id", "active_worker_id", "active_worktree_id", "active_scratch_root_id", "archived_at"
ON "chats"
FOR EACH ROW
WHEN (
  ROW(NEW."permission_profile_id", NEW."owner_id", NEW."context_kind", NEW."project_id", NEW."active_worker_id", NEW."active_worktree_id", NEW."active_scratch_root_id", NEW."archived_at")
  IS DISTINCT FROM
  ROW(OLD."permission_profile_id", OLD."owner_id", OLD."context_kind", OLD."project_id", OLD."active_worker_id", OLD."active_worktree_id", OLD."active_scratch_root_id", OLD."archived_at")
)
EXECUTE FUNCTION "advance_chat_computer_use_authority"();
--> statement-breakpoint
CREATE FUNCTION "advance_inherited_computer_use_authority"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "chats"
  SET "computer_use_authority_generation" = "computer_use_authority_generation" + 1
  WHERE "owner_id" = NEW."user_id"
    AND "permission_profile_id" IS NULL
    AND (
      ("context_kind" = 'project' AND NEW."default_permission_profile_id" IS DISTINCT FROM OLD."default_permission_profile_id")
      OR ("context_kind" = 'standalone' AND NEW."default_chat_permission_profile_id" IS DISTINCT FROM OLD."default_chat_permission_profile_id")
    );
  IF NEW."default_permission_profile_id" IS DISTINCT FROM OLD."default_permission_profile_id" THEN
    PERFORM pg_notify('cantrip_computer_use_authority', json_build_object(
      'ownerId', NEW."user_id", 'scope', json_build_object('kind', 'inherited-default', 'contextKind', 'project')
    )::text);
  END IF;
  IF NEW."default_chat_permission_profile_id" IS DISTINCT FROM OLD."default_chat_permission_profile_id" THEN
    PERFORM pg_notify('cantrip_computer_use_authority', json_build_object(
      'ownerId', NEW."user_id", 'scope', json_build_object('kind', 'inherited-default', 'contextKind', 'standalone')
    )::text);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "user_settings_computer_use_authority_changed"
AFTER UPDATE OF "default_permission_profile_id", "default_chat_permission_profile_id"
ON "user_settings"
FOR EACH ROW
WHEN (
  NEW."default_permission_profile_id" IS DISTINCT FROM OLD."default_permission_profile_id"
  OR NEW."default_chat_permission_profile_id" IS DISTINCT FROM OLD."default_chat_permission_profile_id"
)
EXECUTE FUNCTION "advance_inherited_computer_use_authority"();
--> statement-breakpoint
CREATE FUNCTION "advance_project_computer_use_authority"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "chats"
  SET "computer_use_authority_generation" = "computer_use_authority_generation" + 1
  WHERE "project_id" = NEW."id" AND "context_kind" = 'project';
  PERFORM pg_notify('cantrip_computer_use_authority', json_build_object(
    'ownerId', NEW."owner_id", 'scope', json_build_object('kind', 'project', 'projectId', NEW."id")
  )::text);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "projects_computer_use_authority_changed"
AFTER UPDATE OF "worktree_policy"
ON "projects"
FOR EACH ROW
WHEN (NEW."worktree_policy" IS DISTINCT FROM OLD."worktree_policy")
EXECUTE FUNCTION "advance_project_computer_use_authority"();
--> statement-breakpoint
CREATE FUNCTION "advance_worktree_computer_use_authority"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE affected_chat record;
BEGIN
  FOR affected_chat IN
    UPDATE "chats"
    SET "computer_use_authority_generation" = "computer_use_authority_generation" + 1
    WHERE "active_worktree_id" = NEW."id" AND "context_kind" = 'project'
    RETURNING "id", "owner_id"
  LOOP
    PERFORM pg_notify('cantrip_computer_use_authority', json_build_object(
      'ownerId', affected_chat."owner_id", 'scope', json_build_object('kind', 'chat', 'chatId', affected_chat."id")
    )::text);
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_worktrees_computer_use_authority_changed"
AFTER UPDATE OF "worker_id", "is_primary"
ON "project_worktrees"
FOR EACH ROW
WHEN (NEW."worker_id" IS DISTINCT FROM OLD."worker_id" OR NEW."is_primary" IS DISTINCT FROM OLD."is_primary")
EXECUTE FUNCTION "advance_worktree_computer_use_authority"();
--> statement-breakpoint
CREATE FUNCTION "advance_scratch_root_computer_use_authority"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE affected_chat record;
BEGIN
  FOR affected_chat IN
    UPDATE "chats"
    SET "computer_use_authority_generation" = "computer_use_authority_generation" + 1
    WHERE "active_scratch_root_id" = NEW."id" AND "context_kind" = 'standalone'
    RETURNING "id", "owner_id"
  LOOP
    PERFORM pg_notify('cantrip_computer_use_authority', json_build_object(
      'ownerId', affected_chat."owner_id", 'scope', json_build_object('kind', 'chat', 'chatId', affected_chat."id")
    )::text);
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "standalone_chat_roots_computer_use_authority_changed"
AFTER UPDATE OF "worker_id"
ON "standalone_chat_roots"
FOR EACH ROW
WHEN (NEW."worker_id" IS DISTINCT FROM OLD."worker_id")
EXECUTE FUNCTION "advance_scratch_root_computer_use_authority"();
--> statement-breakpoint
-- Deletion has no surviving generation to advance. It still interrupts a live
-- lease after commit, including chats removed by a cascading project deletion.
CREATE FUNCTION "notify_deleted_chat_computer_use_authority"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('cantrip_computer_use_authority', json_build_object(
    'ownerId', OLD."owner_id", 'scope', json_build_object('kind', 'chat', 'chatId', OLD."id")
  )::text);
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "chats_computer_use_authority_deleted"
AFTER DELETE ON "chats"
FOR EACH ROW
EXECUTE FUNCTION "notify_deleted_chat_computer_use_authority"();
