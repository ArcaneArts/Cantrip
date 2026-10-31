use super::{
    Repository,
    guard::{self, Access, NativeCommandError},
};
use crate::{
    settings::repository::SettingsRepository,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result, bail};

pub struct RuntimeUpdate {
    pub chat: String,
    pub worker: String,
    pub worktree: Option<String>,
    pub thread: Option<String>,
    pub route: String,
    pub status: String,
    /// None retains the existing account on conflict; Some(None) clears it.
    pub provider_account: Option<Option<String>>,
    pub scratch_root: Option<String>,
}
fn nullable(value: &Option<String>) -> Value {
    value
        .as_ref()
        .map(|value| json!(value))
        .unwrap_or(Value::Null)
}
impl Repository {
    pub async fn select_model(
        &self,
        owner: &str,
        chat: &str,
        model: &str,
        reasoning: Option<Option<&str>>,
    ) -> Result<Option<Value>> {
        let models = SettingsRepository::new(self.database.clone())
            .get_model_runtimes(owner, Some(model), None, false, None)
            .await?;
        if models.is_empty() {
            return Ok(None);
        }
        let (owner, chat, model) = (owner.to_owned(), chat.to_owned(), model.to_owned());
        let reasoning = reasoning.map(|value| value.map(str::to_owned));
        self.database.transaction(|tx|Box::pin(async move {
            if tx.query("SELECT id FROM chats WHERE id=$1 AND owner_id=$2 LIMIT 1", &[&chat,&owner]).await?.is_empty() {return Ok(None);}
            guard::lock_chat(tx,&owner,&chat).await?;
            guard::assert_runtime_writable(tx,&chat,None,None,Access::Write).await?;
            let at=crate::auth::now();
            let rows=if let Some(reasoning)=reasoning {
                tx.query("UPDATE chats SET model_id=$2,reasoning_effort=$3,updated_at=$4 WHERE id=$1 RETURNING to_jsonb(chats)::text", &[&chat,&model,&reasoning,&at]).await?
            } else {
                tx.query("UPDATE chats SET model_id=$2,updated_at=$3 WHERE id=$1 RETURNING to_jsonb(chats)::text", &[&chat,&model,&at]).await?
            };
            let row=rows.first().context("Database returned no row after selecting a chat model.")?;
            let raw=serde_json::from_str(&row.get::<String>(0)?)?;
            Ok(Some(super::summary::wire_summary(&raw)?))
        })).await
    }

    pub async fn update_runtime(&self, input: RuntimeUpdate) -> Result<()> {
        if input.worktree.is_none() == input.scratch_root.is_none() {
            bail!("Chat runtime requires exactly one execution root.");
        }
        self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT owner_id FROM chats WHERE id=$1", &[&input.chat]).await?;
            let owner=rows.first().context("Chat not found while updating its runtime.")?.get::<String>(0)?;
            guard::lock_chat(tx,&owner,&input.chat).await?;
            guard::assert_runtime_writable(tx,&input.chat,None,None,Access::Write).await?;
            let rows=tx.query("SELECT state::text FROM native_settings_states WHERE chat_id=$1", &[&input.chat]).await?;
            if let Some(row)=rows.first() {
                let state:Value=serde_json::from_str(&row.get::<String>(0)?)?;
                let binding=super::context::property(Some(&state),"binding")?;
                if truthy(binding) {
                    let binding=binding.unwrap();
                    let placement=input.worktree.as_ref().or(input.scratch_root.as_ref()).unwrap();
                    let same=binding.get("workerId")==Some(&json!(input.worker)) && binding.get("threadId")==Some(&nullable(&input.thread)) && binding.get("placementId")==Some(&json!(placement));
                    let replaced=binding.get("modelRouteId")!=Some(&json!(input.route)) || input.provider_account.as_ref().is_some_and(|account|binding.get("providerAccountId")!=Some(&nullable(account)));
                    if binding.get("modelRouteId")!=Some(&Value::Null) && same && replaced {
                        return Err(NativeCommandError::new("native-runtime-route-replaced",Some("The native route changed before this runtime update. Refresh the bound session."),409).into());
                    }
                }
            }
            let worktree=input.worktree.as_deref();
            let scratch=input.scratch_root.as_deref();
            let account=input.provider_account.as_ref().and_then(|v|v.as_deref());
            let worktree_target=worktree.is_some_and(|value|!value.is_empty());
            let target=if worktree_target{"worktree_id"}else{"scratch_root_id"};
            let account_update=if input.provider_account.is_some(){",provider_account_id=EXCLUDED.provider_account_id"}else{""};
            let at=crate::auth::now();
            let id=uuid::Uuid::new_v4().to_string();
            let query=format!("INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,scratch_root_id,codex_thread_id,model_route_id,provider_account_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(chat_id,worker_id,{target}) WHERE {target} IS NOT NULL DO UPDATE SET codex_thread_id=EXCLUDED.codex_thread_id,model_route_id=EXCLUDED.model_route_id,status=EXCLUDED.status,updated_at=$10{account_update} RETURNING id");
            let rows=tx.query(&query,&[&id,&input.chat,&input.worker,&worktree,&scratch,&input.thread,&input.route,&account,&input.status,&at]).await?;
            let runtime=rows.first().context("Database returned no row after updating a chat runtime.")?.get::<String>(0)?;
            let placement=if worktree_target{worktree}else{scratch};
            let query=format!("UPDATE chat_execution_lanes SET runtime_session_id=$1,codex_thread_id=$2,updated_at=$3 WHERE chat_id=$4 AND worker_id=$5 AND {target}=$6 AND state='active'");
            tx.query(&query,&[&runtime,&input.thread,&crate::auth::now(),&input.chat,&input.worker,&placement]).await?;
            Ok(())
        })).await
    }
}
