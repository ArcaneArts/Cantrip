//! A Task and its Chat execution bindings are created in one transaction.
use super::{
    Repository,
    catalog::{raw, statement_failure},
    summary::wire_summary,
};
use crate::{
    projects::{
        placement::{Connected, PlacementRepository},
        targets::TargetRepository,
    },
    wire::{Value, value::json},
};
use anyhow::{Context, Result};

fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Task creation identity")?
        .lossy()
        .into_owned())
}
fn optional(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        Ok(None)
    } else {
        text(value).map(Some)
    }
}
impl Repository {
    pub async fn create_task(
        &self,
        owner: &str,
        project: &str,
        input: &Value,
        connected: Connected<'_>,
    ) -> Result<Option<Value>> {
        let legacy = input
            .get("worktreeId")
            .filter(|id| crate::wire::coercion::truthy(Some(id)))
            .map(|id| json!({"kind":"worktree","projectId":project,"worktreeId":id}));
        let placement = PlacementRepository::new(self.database.clone())?
            .resolve(
                owner,
                project,
                "chat",
                input.get("target").or(legacy.as_ref()),
                connected,
                false,
            )
            .await?;
        let Some(selected) = TargetRepository::new(self.database.clone())
            .worktree_context(
                owner,
                project,
                &text(&placement["placement"]["worktreeId"])?,
            )
            .await?
        else {
            return Ok(None);
        };
        let worker = text(&selected["workerId"])?;
        let worktree = text(&selected["worktree"]["id"])?;
        let exclusive = selected["worktree"]["isPrimary"] != true;
        let head = optional(&selected["worktree"]["head"])?;
        let rows = self
            .database
            .query(
                "SELECT to_jsonb(s)::text FROM user_settings s WHERE user_id=$1 LIMIT 1",
                &[&owner],
            )
            .await?;
        let settings = raw(rows
            .first()
            .context("Database returned no row while loading default chat model configuration")?)?;
        let model = optional(&settings["default_model_id"])?;
        let reasoning = optional(&settings["default_reasoning_effort"])?;
        let custom_subagent = settings["default_custom_subagent_model"] == true;
        let subagent_model = optional(&settings["default_subagent_model_id"])?;
        let subagent_reasoning = optional(&settings["default_subagent_reasoning_effort"])?;
        let defaults = json!({"modelId":settings["default_model_id"],"reasoningEffort":settings["default_reasoning_effort"],"customSubagentModel":custom_subagent,"subagentModelId":settings["default_subagent_model_id"],"subagentReasoningEffort":settings["default_subagent_reasoning_effort"]});
        let configuration = input
            .get("modelConfiguration")
            .unwrap_or(&defaults)
            .stringify();
        let position = crate::project_layout::next_position(&self.database, project)
            .await?
            .to_string();
        let (owner, project, id, label, mode) = (
            owner.to_owned(),
            project.to_owned(),
            text(&input["chatId"])?,
            input["titleProtection"].stringify(),
            text(&input["worktreeMode"])?,
        );
        let auto_title = input.get("autoTitle") == Some(&Value::Bool(true));
        let plan_goal = input["planGoalEnabled"] == true;
        let priority = input["priority"].stringify();
        let columns = crate::tasks::opaque_columns(&input["task"]).stringify();
        self.database.transaction(|tx| Box::pin(async move {
            let rows = tx.query("INSERT INTO chats(id,owner_id,context_kind,project_id,protected_label,auto_title_pending,experience,position,active_worker_id,active_worktree_id,worktree_mode,model_id,reasoning_effort,custom_subagent_model,subagent_model_id,subagent_reasoning_effort,github_item_kind,github_item_number,github_agent_intent,github_head_sha) VALUES($1,$2,'project',$3,$4::text::jsonb,$5,'task',$6::text::integer,$7,$8,$9,$10,$11,$12,$13,$14,NULL,NULL,NULL,NULL) RETURNING to_jsonb(chats)::text", &[&id,&owner,&project,&label,&auto_title,&position,&worker,&worktree,&mode,&model,&reasoning,&custom_subagent,&subagent_model,&subagent_reasoning]).await.map_err(|error| statement_failure(error, &[&id,&owner,&project,&label,&position,&worker,&worktree,&mode,model.as_deref().unwrap_or(""),reasoning.as_deref().unwrap_or(""),subagent_model.as_deref().unwrap_or(""),subagent_reasoning.as_deref().unwrap_or("")]))?;
            let chat = raw(rows.first().context("Database returned no row while creating a chat")?)?;
            let runtime = uuid::Uuid::new_v4().to_string();
            tx.query("INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id) VALUES($1,$2,$3,$4)", &[&runtime,&id,&worker,&worktree]).await.map_err(|error| statement_failure(error, &[&worker,&worktree]))?;
            let lane = uuid::Uuid::new_v4().to_string();
            tx.query("INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,starting_head,runtime_session_id) VALUES($1,$2,$3,$4,'user',$5,'Initial chat worktree','suspended',$6,$7)", &[&lane,&id,&worktree,&worker,&exclusive,&head,&runtime]).await.map_err(|error| statement_failure(error, &[&worker,&worktree,head.as_deref().unwrap_or("")]))?;
            // No pane membership or conversation-creation receipt is created for Tasks.
            let rows = tx.query("INSERT INTO tasks(chat_id,plan_goal_enabled,priority,model_configuration,state,stable_state_before_failure,active_operation_kind,plan_authorship,planning_round,has_plan,has_questions,has_final_plan,has_goal_prompt,last_error,protected_content) SELECT $1,$2,$3::text::integer,$4::text::jsonb,v->>'state',v->>'stable_state_before_failure',v->>'active_operation_kind',v->>'plan_authorship',(v->>'planning_round')::integer,(v->>'has_plan')::boolean,(v->>'has_questions')::boolean,(v->>'has_final_plan')::boolean,(v->>'has_goal_prompt')::boolean,NULLIF(v->'last_error','null'::jsonb),v->'protected_content' FROM (SELECT $5::text::jsonb v) input RETURNING to_jsonb(tasks)::text", &[&id,&plan_goal,&priority,&configuration,&columns]).await.map_err(|error| statement_failure(error, &[&priority,&configuration,&columns]))?;
            let task = raw(rows.first().context("Database returned no row while creating a Task record")?)?;
            Ok(Some(json!({"chat":wire_summary(&chat)?,"task":crate::tasks::opaque_summary(&task,None)?})))
        })).await
    }
}
