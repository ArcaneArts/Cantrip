use super::*;
use crate::chats::Repository;
use std::future::Future;

impl Repository {
    pub async fn fork_standalone<F, Fut>(
        &self,
        owner: &str,
        id: &str,
        input: &Value,
        is_connected: impl Fn(&str) -> bool + Send + Sync,
        protect: F,
    ) -> Result<Option<Value>>
    where
        F: FnOnce(Vec<Value>) -> Fut + Send,
        Fut: Future<Output = Result<Vec<Value>>> + Send,
    {
        if truthy(input.get("worktreeId")) || truthy(input.get("worktreeMode")) {
            return Err(Conflict("Standalone Chat forks do not accept worktree settings.").into());
        }
        let rows=checked(self.database.query("SELECT to_jsonb(c)::text FROM chats c WHERE id=$1 AND owner_id=$2 AND context_kind='standalone' AND archived_at IS NULL LIMIT 1",&[&id,&owner]).await,&[json!(id),json!(owner)])?;
        let Some(source) = rows.first().map(super::super::catalog::raw).transpose()? else {
            return Ok(None);
        };
        let Some(messages) = read_messages(Executor::Database(&self.database), id, input).await?
        else {
            return Ok(None);
        };
        let copies = protect(protected_messages(&messages)?).await?;
        if copies.len() != messages.len() {
            anyhow::bail!("The worker returned an incomplete encrypted fork.")
        }
        let mut created = self
            .create_standalone(
                owner,
                &json!({"id":input["id"],"titleProtection":input["titleProtection"]}),
                is_connected,
            )
            .await?;
        let fork = text(&created["chat"]["id"])?;
        let result=async{
            let model=optional(&source["model_id"])?;let reasoning=optional(&source["reasoning_effort"])?;let permission=optional(&source["permission_profile_id"])?;let at=crate::auth::now();
            let rows=checked(self.database.query("UPDATE chats SET model_id=$1,reasoning_effort=$2,permission_profile_id=$3,updated_at=$4 WHERE id=$5 AND owner_id=$6 RETURNING to_jsonb(chats)::text",&[&model,&reasoning,&permission,&at,&fork,&owner]).await,&[json!(model),json!(reasoning),json!(permission),json!(crate::auth::iso(at)),json!(fork),json!(owner)])?;
            let row=super::super::catalog::raw(rows.first().context("Database returned no row while copying standalone Chat settings")?)?;
            if !copies_match(&messages,&copies){anyhow::bail!("The worker returned inconsistent encrypted fork messages.")}
            let root=text(&created["chat"]["activeScratchRootId"])?;
            insert_messages(Executor::Database(&self.database),&fork,None,Some(&root),&messages,&copies).await?;
            created["chat"]=super::super::summary::wire_summary(&row)?;
            Ok(Some(created))
        }.await;
        if result.is_err() {
            checked(
                self.database
                    .query(
                        "DELETE FROM chats WHERE id=$1 AND owner_id=$2",
                        &[&fork, &owner],
                    )
                    .await,
                &[json!(fork), json!(owner)],
            )?;
        }
        result
    }
}
