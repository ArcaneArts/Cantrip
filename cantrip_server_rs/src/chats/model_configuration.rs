//! Persist full root/child configuration under the same native runtime fence.
use super::{Repository, catalog::raw, execution_lanes::LaneError, guard, summary::wire_summary};
use crate::wire::{Value, coercion::truthy};
use anyhow::{Context, Result};
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Model configuration identity")?
        .lossy()
        .into_owned())
}
impl Repository {
    pub async fn set_model_configuration(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let (owner, chat, input) = (owner.to_owned(), chat.to_owned(), input.clone());
        self.database.transaction(|tx|Box::pin(async move {
            if !truthy(input.get("modelId")){return Ok(None)}
            let model=text(&input["modelId"])?;
            let child=input.get("subagentModelId").filter(|v|!v.is_null()).map(text).transpose()?;
            let owned_child=child.as_deref().filter(|id|!id.is_empty());
            let models=tx.query("SELECT id FROM model_profiles WHERE owner_id=$1 AND (id=$2 OR id=$3)",&[&owner,&model,&owned_child]).await?;
            let expected=if owned_child.is_some_and(|c|c!=model){2}else{1};
            if models.len()!=expected{return Ok(None)}
            let rows=tx.query("SELECT context_kind FROM chats WHERE id=$1 AND owner_id=$2 LIMIT 1",&[&chat,&owner]).await?;
            let Some(row)=rows.first()else{return Ok(None)};
            if row.get::<String>(0)?=="standalone" && (truthy(input.get("customSubagentModel")) || input.get("subagentModelId")!=Some(&Value::Null) || input.get("subagentReasoningEffort")!=Some(&Value::Null)) {
                return Err(LaneError::Conflict("Standalone Chat does not support subagent configuration.".into()).into())
            }
            guard::lock_chat(tx,&owner,&chat).await?;
            guard::assert_runtime_writable(tx,&chat,None,None,guard::Access::Write).await?;
            let reasoning=input.get("reasoningEffort").filter(|v|!v.is_null()).map(text).transpose()?;
            let child_reasoning=input.get("subagentReasoningEffort").filter(|v|!v.is_null()).map(text).transpose()?;
            let custom=input.get("customSubagentModel").and_then(Value::as_bool);
            let rows=tx.query("UPDATE chats SET model_id=$3,reasoning_effort=CASE WHEN $4 THEN $5 ELSE reasoning_effort END,custom_subagent_model=CASE WHEN $6 THEN $7 ELSE custom_subagent_model END,subagent_model_id=CASE WHEN $8 THEN $9 ELSE subagent_model_id END,subagent_reasoning_effort=CASE WHEN $10 THEN $11 ELSE subagent_reasoning_effort END,updated_at=$12 WHERE id=$1 AND owner_id=$2 RETURNING to_jsonb(chats)::text",&[&chat,&owner,&model,&input.get("reasoningEffort").is_some(),&reasoning,&input.get("customSubagentModel").is_some(),&custom,&input.get("subagentModelId").is_some(),&child,&input.get("subagentReasoningEffort").is_some(),&child_reasoning,&crate::auth::now()]).await?;
            rows.first().map(|row|wire_summary(&raw(row)?)).transpose()
        })).await
    }
}
