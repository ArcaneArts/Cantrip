ALTER TABLE project_builtin_surface_states DROP CONSTRAINT project_builtin_surface_states_definition_check;
--> statement-breakpoint
ALTER TABLE project_builtin_surface_states ADD CONSTRAINT project_builtin_surface_states_definition_check CHECK (definition_id IN ('project.overview','project.tasks','project.alerts','git.history','git.graph','github.issues','github.pull-requests','github.actions'));
--> statement-breakpoint
ALTER TABLE project_surface_launcher_preferences DROP CONSTRAINT project_surface_launcher_preferences_definition_check;
--> statement-breakpoint
ALTER TABLE project_surface_launcher_preferences ADD CONSTRAINT project_surface_launcher_preferences_definition_check CHECK (definition_id IN ('project.overview','project.tasks','project.alerts','git.history','git.graph','github.issues','github.pull-requests','github.actions'));
--> statement-breakpoint
CREATE FUNCTION project_alert_goal_source(p_owner text,p_project text,p_alert text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT o.snapshot FROM project_alerts a JOIN chats c ON c.id=a.chat_id
 JOIN chat_goal_observations o ON o.chat_id=c.id
 WHERE a.id=p_alert AND a.owner_id=p_owner AND c.owner_id=p_owner
 AND a.project_id=p_project AND c.project_id=p_project AND a.source='goal'
 AND a.resolved_at IS NULL AND c.archived_at IS NULL AND NOT c.managed_autonomy_stopped
 AND a.episode_id=o.thread_id || ':' || o.attention_epoch::text;
$$;
