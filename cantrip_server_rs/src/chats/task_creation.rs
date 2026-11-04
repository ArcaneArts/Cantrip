//! Project Chat and Task creation preserves atomic bindings and replay receipts.
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

#[derive(Debug)]
pub struct ConversationCreationConflict;
impl std::fmt::Display for ConversationCreationConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Conversation creation identity is already in use.")
    }
}
impl std::error::Error for ConversationCreationConflict {}

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
    async fn replay_creation(
        &self,
        owner: &str,
        project: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let (id, request) = (text(&input["id"])?, input.stringify());
        let rows = self.database.query("SELECT to_jsonb(c)::text,r.request=$4::text::jsonb FROM conversation_creation_requests r INNER JOIN chats c ON c.id=r.chat_id WHERE c.id=$1 AND c.owner_id=$2 AND c.project_id=$3", &[&id,&owner,&project,&request]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let chat = raw(row)?;
        if !row.get::<bool>(1)? || !chat["archived_at"].is_null() {
            return Err(ConversationCreationConflict.into());
        }
        Ok(Some(wire_summary(&chat)?))
    }
    pub async fn create_project_chat(
        &self,
        owner: &str,
        project: &str,
        input: &Value,
        connected: Connected<'_>,
    ) -> Result<Option<Value>> {
        let detached = input.get("attachToTabLayout") == Some(&Value::Bool(false));
        if detached && let Some(replay) = self.replay_creation(owner, project, input).await? {
            return Ok(Some(replay));
        }
        match self
            .create_project_experience(owner, project, input, connected, false)
            .await
        {
            Ok(created) => Ok(created.map(|value| value["chat"].clone())),
            Err(cause) => {
                // Placement may race the same identity's committed receipt.
                if detached
                    && let Some(replay) = self.replay_creation(owner, project, input).await?
                {
                    return Ok(Some(replay));
                }
                Err(cause)
            }
        }
    }
    pub async fn create_task(
        &self,
        owner: &str,
        project: &str,
        input: &Value,
        connected: Connected<'_>,
    ) -> Result<Option<Value>> {
        self.create_project_experience(owner, project, input, connected, true)
            .await
    }
    async fn create_project_experience(
        &self,
        owner: &str,
        project: &str,
        input: &Value,
        connected: Connected<'_>,
        task: bool,
    ) -> Result<Option<Value>> {
        let legacy = input
            .get("worktreeId")
            .filter(|id| crate::wire::coercion::truthy(Some(id)))
            .map(|id| json!({"kind":"worktree","projectId":project,"worktreeId":id}));
        anyhow::ensure!(
            !task || input.get("cantripOsBindingId").is_none(),
            "OS placement is currently available for agent chats."
        );
        let os_placement = if let Some(binding) = input.get("cantripOsBindingId") {
            Some(
                crate::cantrip_os::chats::select(
                    crate::database::Executor::Database(&self.database),
                    owner,
                    project,
                    &text(binding)?,
                )
                .await?,
            )
        } else {
            None
        };
        let selected = if let Some(os) = &os_placement {
            Value::from_serialize(&os["selected"])
        } else {
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
            selected
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
            text(&input[if task { "chatId" } else { "id" }])?,
            input["titleProtection"].stringify(),
            text(&input["worktreeMode"])?,
        );
        let auto_title = input.get("autoTitle") == Some(&Value::Bool(true));
        let plan_goal = input["planGoalEnabled"] == true;
        let priority = input["priority"].stringify();
        let columns = task.then(|| crate::tasks::opaque_columns(&input["task"]).stringify());
        let experience = if task { "task" } else { "agent" };
        let github = if task {
            Value::Null
        } else {
            input["githubAgentContext"].clone()
        };
        let github_kind = optional(&github["kind"])?;
        let github_number = github.get("number").map(Value::stringify);
        let github_intent = optional(&github["intent"])?;
        let github_head = optional(&github["headSha"])?;
        let input = input.clone();
        self.database.transaction(|tx| Box::pin(async move {
            let rows = tx.query("INSERT INTO chats(id,owner_id,context_kind,project_id,protected_label,auto_title_pending,experience,position,active_worker_id,active_worktree_id,worktree_mode,model_id,reasoning_effort,custom_subagent_model,subagent_model_id,subagent_reasoning_effort,github_item_kind,github_item_number,github_agent_intent,github_head_sha) VALUES($1,$2,'project',$3,$4::text::jsonb,$5,$15,$6::text::integer,$7,$8,$9,$10,$11,$12,$13,$14,$16,$17::text::integer,$18,$19) RETURNING to_jsonb(chats)::text", &[&id,&owner,&project,&label,&auto_title,&position,&worker,&worktree,&mode,&model,&reasoning,&custom_subagent,&subagent_model,&subagent_reasoning,&experience,&github_kind,&github_number,&github_intent,&github_head]).await.map_err(|error| statement_failure(error, &[&id,&owner,&project,&label,&position,&worker,&worktree,&mode,model.as_deref().unwrap_or(""),reasoning.as_deref().unwrap_or(""),subagent_model.as_deref().unwrap_or(""),subagent_reasoning.as_deref().unwrap_or(""),github_kind.as_deref().unwrap_or(""),github_intent.as_deref().unwrap_or(""),github_head.as_deref().unwrap_or("")]))?;
            let chat = raw(rows.first().context("Database returned no row while creating a chat")?)?;
            if !task && input.get("attachToTabLayout") == Some(&Value::Bool(false)) {
                let request = input.stringify();
                tx.query("INSERT INTO conversation_creation_requests(chat_id,request) VALUES($1,$2::text::jsonb)", &[&id,&request]).await.map_err(|error|statement_failure(error,&[&id,&request]))?;
            }
            if let Some(os)=&os_placement {crate::cantrip_os::chats::capture(tx,&id,&os["source"]).await?;}
            let runtime = uuid::Uuid::new_v4().to_string();
            tx.query("INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id) VALUES($1,$2,$3,$4)", &[&runtime,&id,&worker,&worktree]).await.map_err(|error| statement_failure(error, &[&worker,&worktree]))?;
            let lane = uuid::Uuid::new_v4().to_string();
            tx.query("INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,starting_head,runtime_session_id) VALUES($1,$2,$3,$4,'user',$5,'Initial chat worktree','suspended',$6,$7)", &[&lane,&id,&worktree,&worker,&exclusive,&head,&runtime]).await.map_err(|error| statement_failure(error, &[&worker,&worktree,head.as_deref().unwrap_or("")]))?;
            if !task {
                if input.get("attachToTabLayout") != Some(&Value::Bool(false)) {
                    crate::project_layout::attach_resource(tx,&project,&id,"chat",&input).await?;
                }
                return Ok(Some(json!({"chat":wire_summary(&chat)?,"task":Value::Null})));
            }
            let columns = columns.expect("Task creation columns");
            let rows = tx.query("INSERT INTO tasks(chat_id,plan_goal_enabled,priority,model_configuration,state,stable_state_before_failure,active_operation_kind,plan_authorship,planning_round,has_plan,has_questions,has_final_plan,has_goal_prompt,last_error,protected_content) SELECT $1,$2,$3::text::integer,$4::text::jsonb,v->>'state',v->>'stable_state_before_failure',v->>'active_operation_kind',v->>'plan_authorship',(v->>'planning_round')::integer,(v->>'has_plan')::boolean,(v->>'has_questions')::boolean,(v->>'has_final_plan')::boolean,(v->>'has_goal_prompt')::boolean,NULLIF(v->'last_error','null'::jsonb),v->'protected_content' FROM (SELECT $5::text::jsonb v) input RETURNING to_jsonb(tasks)::text", &[&id,&plan_goal,&priority,&configuration,&columns]).await.map_err(|error| statement_failure(error, &[&priority,&configuration,&columns]))?;
            let task = raw(rows.first().context("Database returned no row while creating a Task record")?)?;
            Ok(Some(json!({"chat":wire_summary(&chat)?,"task":crate::tasks::opaque_summary(&task,None)?})))
        })).await
    }
}
