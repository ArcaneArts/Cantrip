use super::*;
use crate::{chats::Repository, database::Transaction};
use std::future::Future;

#[derive(Clone, PartialEq)]
struct Source {
    chat: Value,
    target: Value,
    messages: Vec<Value>,
    project: String,
}
async fn read(
    tx: &Transaction<'_>,
    owner: &str,
    id: &str,
    input: &Value,
) -> Result<Option<Source>> {
    let rows=checked(tx.query("SELECT to_jsonb(c)::text FROM chats c INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE c.id=$2 LIMIT 1",&[&owner,&id]).await,&[json!(owner),json!(id)])?;
    let Some(chat) = rows.first().map(super::super::catalog::raw).transpose()? else {
        return Ok(None);
    };
    let project = chat["project_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .context("Project Chat operation received a standalone Chat.")?
        .to_owned();
    let active = chat["active_worktree_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .context("Project Chat operation is missing its worktree.")?;
    let tree = input
        .get("worktreeId")
        .filter(|v| !v.is_null())
        .map(text)
        .transpose()?
        .unwrap_or_else(|| active.to_owned());
    let rows=checked(tx.query("SELECT to_jsonb(w)::text FROM project_worktrees w INNER JOIN project_sources s ON s.id=w.project_source_id AND s.project_id=$1 WHERE w.id=$2 AND s.removed_at IS NULL LIMIT 1",&[&project,&tree]).await,&[json!(project),json!(tree)])?;
    let Some(target) = rows.first().map(super::super::catalog::raw).transpose()? else {
        return Ok(None);
    };
    if target["lifecycle_state"] != "ready" {
        return Ok(None);
    }
    let Some(messages) = read_messages(Executor::Transaction(tx), id, input).await? else {
        return Ok(None);
    };
    Ok(Some(Source {
        chat: dates(chat)?,
        target: dates(target)?,
        messages: messages.into_iter().map(dates).collect::<Result<_>>()?,
        project,
    }))
}
async fn position(tx: &Transaction<'_>, project: &str, table: &str) -> Result<i64> {
    let rows = checked(
        tx.query(
            &format!(
                "SELECT position FROM {table} WHERE project_id=$1 ORDER BY position DESC LIMIT 1"
            ),
            &[&project],
        )
        .await,
        &[json!(project)],
    )?;
    Ok(i64::from(
        rows.first()
            .map(|r| r.get::<i32>(0))
            .transpose()?
            .unwrap_or(-1),
    ))
}
impl Repository {
    pub async fn fork_project<F, Fut>(
        &self,
        owner: &str,
        id: &str,
        input: &Value,
        protect: F,
    ) -> Result<Option<Value>>
    where
        F: FnOnce(Vec<Value>) -> Fut + Send,
        Fut: Future<Output = Result<Vec<Value>>> + Send,
    {
        let (owner, id, input) = (owner.to_owned(), id.to_owned(), input.clone());
        let (o, c, i) = (owner.clone(), id.clone(), input.clone());
        let source = self
            .database
            .transaction(|tx| Box::pin(async move { read(tx, &o, &c, &i).await }))
            .await?;
        let Some(source) = source else {
            return Ok(None);
        };
        let copies = protect(protected_messages(&source.messages)?).await?;
        if !copies_match(&source.messages, &copies) {
            anyhow::bail!("The worker returned inconsistent encrypted fork messages.")
        }
        self.database.transaction(|tx|Box::pin(async move{
            let current=read(tx,&owner,&id,&input).await?;
            if current.as_ref()!=Some(&source){return Err(Conflict("The chat or destination changed while preparing the fork. Retry the fork.").into())}
            let project=&source.project;
            let (chat,terminal,explorer,code,browser,view)=tokio::try_join!(position(tx,project,"chats"),position(tx,project,"terminals"),position(tx,project,"explorers"),position(tx,project,"code_tabs"),position(tx,project,"browsers"),position(tx,project,"project_views"))?;
            let position=[chat,terminal,explorer,code,browser,view].into_iter().max().unwrap()+1;
            let fork=text(&input["id"])?;let label=input["titleProtection"].stringify();
            let worker=text(&source.target["worker_id"])?;let tree=text(&source.target["id"])?;
            let mode=optional(input.get("worktreeMode").filter(|v|!v.is_null()).unwrap_or(&source.chat["worktree_mode"]))?;
            let model=optional(&source.chat["model_id"])?;let reasoning=optional(&source.chat["reasoning_effort"])?;
            let custom=source.chat["custom_subagent_model"].as_bool().context("Subagent setting")?;
            let submodel=optional(&source.chat["subagent_model_id"])?;let subreason=optional(&source.chat["subagent_reasoning_effort"])?;let permission=optional(&source.chat["permission_profile_id"])?;
            let rows=checked(tx.query("INSERT INTO chats(id,owner_id,context_kind,project_id,protected_label,position,active_worker_id,active_worktree_id,worktree_mode,model_id,reasoning_effort,custom_subagent_model,subagent_model_id,subagent_reasoning_effort,permission_profile_id) VALUES($1,$2,'project',$3,$4::text::jsonb,$5::bigint::integer,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING to_jsonb(chats)::text",&[&fork,&owner,&project,&label,&position,&worker,&tree,&mode,&model,&reasoning,&custom,&submodel,&subreason,&permission]).await,&[json!(fork),json!(owner),json!(project),json!(label),json!(position),json!(worker),json!(tree),json!(mode),json!(model),json!(reasoning),json!(custom),json!(submodel),json!(subreason),json!(permission)])?;
            let chat=super::super::catalog::raw(rows.first().context("Database returned no row while forking a chat")?)?;
            let runtime=uuid::Uuid::new_v4().to_string();let lane=uuid::Uuid::new_v4().to_string();
            checked(tx.query("INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id) VALUES($1,$2,$3,$4)",&[&runtime,&fork,&worker,&tree]).await,&[json!(runtime),json!(fork),json!(worker),json!(tree)])?;
            let exclusive=source.target["is_primary"]!=true;let purpose=format!("Forked from {id}");let head=optional(&source.target["head"])?;
            checked(tx.query("INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,starting_head,runtime_session_id) VALUES($1,$2,$3,$4,'user',$5,$6,'suspended',$7,$8)",&[&lane,&fork,&tree,&worker,&exclusive,&purpose,&head,&runtime]).await,&[json!(lane),json!(fork),json!(tree),json!(worker),json!(exclusive),json!(purpose),json!(head),json!(runtime)])?;
            if input["attachToTabLayout"]!=false{crate::project_layout::attach_resource(tx,project,&fork,"chat",&Value::Object(Default::default())).await?;}
            insert_messages(Executor::Transaction(tx),&fork,Some(&tree),None,&source.messages,&copies).await?;
            let boundary=source.messages.last().map(|m|text(&m["created_at"]).and_then(|s|Ok(s.parse::<chrono::DateTime<chrono::Utc>>()?))).transpose()?.unwrap_or_else(crate::auth::now);
            let behavior=checked(tx.query("SELECT id FROM model_behavior_observations WHERE owner_id=$1 AND chat_id=$2 AND started_at<=$3 ORDER BY started_at DESC LIMIT 1",&[&owner,&id,&boundary]).await,&[json!(owner),json!(id),json!(crate::auth::iso(boundary))])?;
            if let Some(row)=behavior.first(){let observation=row.get::<String>(0)?;let at=crate::auth::now();checked(tx.query("UPDATE model_behavior_observations SET fork_count=fork_count+1,updated_at=$1 WHERE id=$2",&[&at,&observation]).await,&[json!(crate::auth::iso(at)),json!(observation)])?;}
            super::super::summary::wire_summary(&chat).map(Some)
        })).await
    }
}
