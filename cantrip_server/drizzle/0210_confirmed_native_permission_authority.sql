-- Account defaults are preferences for future selection. A managed thread with
-- an actually confirmed policy retains that policy until its native transition
-- applies. Match the retained source to its current placement/account/thread;
-- a stale policy from another runtime binding must not suppress revocation.
CREATE FUNCTION "chat_has_confirmed_native_permission"(target_chat text)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM native_settings_states n
    JOIN chats c ON c.id = n.chat_id
    JOIN chat_runtime_sessions r ON r.chat_id = c.id
    LEFT JOIN project_worktrees w ON w.id = c.active_worktree_id
    WHERE c.id = target_chat
      AND jsonb_typeof(n.state->'permissionPolicy') = 'object'
      AND n.state->'permissionPolicy'->'source'->>'threadId' = r.codex_thread_id
      AND n.state->'permissionPolicy'->'source'->>'workerId' = r.worker_id
      AND n.state->'permissionPolicy'->'source'->>'contextKind' = c.context_kind
      AND (n.state->'permissionPolicy'->'source'->>'projectId') IS NOT DISTINCT FROM c.project_id
      AND (n.state->'permissionPolicy'->'source'->>'modelRouteId') IS NOT DISTINCT FROM r.model_route_id
      AND (n.state->'permissionPolicy'->'source'->>'providerAccountId') IS NOT DISTINCT FROM r.provider_account_id
      AND (
        (c.context_kind = 'project' AND r.worktree_id = c.active_worktree_id
          AND r.worker_id = w.worker_id
          AND n.state->'permissionPolicy'->'source'->>'placementId' = c.active_worktree_id)
        OR
        (c.context_kind = 'standalone' AND r.scratch_root_id = c.active_scratch_root_id
          AND r.worker_id = c.active_worker_id
          AND n.state->'permissionPolicy'->'source'->>'placementId' = c.active_scratch_root_id)
      )
  );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "advance_inherited_computer_use_authority"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE affected_chat record;
BEGIN
  FOR affected_chat IN
    UPDATE chats
    SET computer_use_authority_generation = computer_use_authority_generation + 1
    WHERE owner_id = NEW.user_id
      AND permission_profile_id IS NULL
      AND NOT chat_has_confirmed_native_permission(id)
      AND (
        (context_kind = 'project' AND NEW.default_permission_profile_id IS DISTINCT FROM OLD.default_permission_profile_id)
        OR (context_kind = 'standalone' AND NEW.default_chat_permission_profile_id IS DISTINCT FROM OLD.default_chat_permission_profile_id)
      )
    RETURNING id, owner_id
  LOOP
    -- Broadcast only the chats whose actual authority changed. A broad default
    -- notification would still cancel pinned native sessions on the worker.
    PERFORM pg_notify('cantrip_computer_use_authority', json_build_object(
      'ownerId', affected_chat.owner_id, 'scope', json_build_object('kind', 'chat', 'chatId', affected_chat.id)
    )::text);
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "advance_confirmed_native_permission_authority"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE affected_owner text;
BEGIN
  -- Desired/pending changes do not enter this trigger. Including the applied
  -- revision fences A -> B -> A even when the nullable preference never changes.
  UPDATE chats
  SET computer_use_authority_generation = computer_use_authority_generation + 1
  WHERE id = NEW.chat_id
  RETURNING owner_id INTO affected_owner;
  IF affected_owner IS NOT NULL THEN
    PERFORM pg_notify('cantrip_computer_use_authority', json_build_object(
      'ownerId', affected_owner, 'scope', json_build_object('kind', 'chat', 'chatId', NEW.chat_id)
    )::text);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "native_settings_permission_authority_changed"
AFTER UPDATE OF state ON native_settings_states
FOR EACH ROW
WHEN ((NEW.state->'permissionPolicy') IS DISTINCT FROM (OLD.state->'permissionPolicy'))
EXECUTE FUNCTION "advance_confirmed_native_permission_authority"();
--> statement-breakpoint
CREATE TRIGGER "native_settings_permission_authority_inserted"
AFTER INSERT ON native_settings_states
FOR EACH ROW
WHEN (jsonb_typeof(NEW.state->'permissionPolicy') = 'object')
EXECUTE FUNCTION "advance_confirmed_native_permission_authority"();
