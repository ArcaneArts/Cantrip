ALTER TABLE tasks ADD COLUMN model_configuration jsonb NOT NULL DEFAULT '{"modelId":null,"reasoningEffort":null,"customSubagentModel":false,"subagentModelId":null,"subagentReasoningEffort":null}'::jsonb;
--> statement-breakpoint
-- Keep in-flight snapshots, explicit legacy assignments, and the last automatic
-- assignment before falling back to each chat's existing model configuration.
UPDATE tasks t SET model_configuration = COALESCE(
  (SELECT d.model_configuration FROM task_dispatch_cycles d WHERE d.chat_id=t.chat_id AND d.state IN ('claimed','running','paused') AND d.model_configuration IS NOT NULL ORDER BY d.created_at DESC, d.id DESC LIMIT 1),
  (SELECT jsonb_build_object('modelId',w.model_id,'reasoningEffort',w.reasoning_effort,'customSubagentModel',w.custom_subagent_model,'subagentModelId',w.subagent_model_id,'subagentReasoningEffort',w.subagent_reasoning_effort) FROM task_workers w WHERE w.id=t.requested_task_worker_id),
  (SELECT d.model_configuration FROM task_dispatch_cycles d WHERE d.chat_id=t.chat_id AND d.model_configuration IS NOT NULL ORDER BY d.created_at DESC, d.id DESC LIMIT 1),
  (SELECT jsonb_build_object('modelId',w.model_id,'reasoningEffort',w.reasoning_effort,'customSubagentModel',w.custom_subagent_model,'subagentModelId',w.subagent_model_id,'subagentReasoningEffort',w.subagent_reasoning_effort) FROM task_workers w WHERE w.id=t.last_task_worker_id),
  (SELECT jsonb_build_object('modelId',w.model_id,'reasoningEffort',w.reasoning_effort,'customSubagentModel',w.custom_subagent_model,'subagentModelId',w.subagent_model_id,'subagentReasoningEffort',w.subagent_reasoning_effort) FROM task_workers w WHERE w.owner_id=c.owner_id AND w.enabled=true AND w.deleted_at IS NULL ORDER BY CASE WHEN t.plan_goal_enabled AND NOT w.allows_plan_goal THEN 1 ELSE 0 END,w.position,w.id LIMIT 1),
  jsonb_build_object('modelId',c.model_id,'reasoningEffort',c.reasoning_effort,'customSubagentModel',c.custom_subagent_model,'subagentModelId',c.subagent_model_id,'subagentReasoningEffort',c.subagent_reasoning_effort)
) FROM chats c WHERE c.id=t.chat_id;
--> statement-breakpoint
UPDATE task_dispatch_cycles d SET model_configuration=t.model_configuration, requested_task_worker_id=NULL, eligibility_code=NULL FROM tasks t WHERE t.chat_id=d.chat_id AND d.state='queued';
--> statement-breakpoint
UPDATE tasks SET requested_task_worker_id=NULL, last_task_worker_id=NULL, continuity_family=NULL;
--> statement-breakpoint
UPDATE task_dispatch_cycles SET eligibility_code=NULL WHERE eligibility_code IN ('assignment-mismatch','continuity-mismatch','plan-goal-unsupported','task-worker-disabled');
--> statement-breakpoint
-- Legacy presets are inert. Release their model foreign keys so retired presets
-- cannot prevent deleting models from Settings.
ALTER TABLE task_workers DROP CONSTRAINT IF EXISTS task_workers_model_id_model_profiles_id_fk;
--> statement-breakpoint
ALTER TABLE task_workers DROP CONSTRAINT IF EXISTS task_workers_subagent_model_id_model_profiles_id_fk;
