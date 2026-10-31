use super::{LaneRepository, branch_leases, conflict, optional, raw, reads, required, text};
use crate::{
    database::Transaction,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::Result;
pub(super) async fn runtime(
    tx: &Transaction<'_>,
    chat: &str,
    root: &Value,
    operation: &str,
) -> Result<Value> {
    let worker = text(&root["workerId"])?;
    let tree = text(&root["id"])?;
    tx.query("INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id) VALUES($1,$2,$3,$4) ON CONFLICT(chat_id,worker_id,worktree_id) WHERE worktree_id IS NOT NULL DO NOTHING",&[&uuid::Uuid::new_v4().to_string(),&chat,&worker,&tree]).await?;
    required(&tx.query("SELECT to_jsonb(r)::text FROM chat_runtime_sessions r WHERE chat_id=$1 AND worker_id=$2 AND worktree_id=$3 LIMIT 1",&[&chat,&worker,&tree]).await?,operation)
}
pub(super) async fn move_chat(
    tx: &Transaction<'_>,
    chat: &str,
    root: &Value,
    agent_managed: bool,
) -> Result<Vec<crate::database::Row>> {
    let worker = text(&root["workerId"])?;
    let tree = text(&root["id"])?;
    tx.query("UPDATE terminals SET active_worker_id=$1,worktree_id=$2,updated_at=$3 WHERE linked_chat_id=$4",&[&worker,&tree,&crate::auth::now(),&chat]).await?;
    tx.query("UPDATE chats SET active_worker_id=$1,active_worktree_id=$2,placement_revision=placement_revision+1,worktree_mode=CASE WHEN $3 THEN 'agent-managed' ELSE worktree_mode END,updated_at=$4 WHERE id=$5 RETURNING to_jsonb(chats)::text",&[&worker,&tree,&agent_managed,&crate::auth::now(),&chat]).await
}
impl LaneRepository {
    pub async fn release(
        &self,
        owner: &str,
        chat: &str,
        lane: &str,
        return_to_primary: bool,
    ) -> Result<Option<Value>> {
        let Some(context) = self.lane_context(owner, chat, lane).await? else {
            return Ok(None);
        };
        if matches!(
            context["chat"]["status"].as_str(),
            Some("running" | "waiting-for-approval")
        ) || context["lane"]["state"] == "active"
        {
            return Err(conflict(
                "Finish the active chat execution before releasing its lane.",
            ));
        }
        for row in self
            .database
            .query(
                "SELECT status FROM terminals WHERE linked_chat_id=$1",
                &[&chat],
            )
            .await?
        {
            if row.get::<String>(0)? == "running" {
                return Err(conflict(
                    "Stop the linked Codex console before releasing its lane.",
                ));
            }
        }
        let (chat, lane) = (chat.to_owned(), lane.to_owned());
        self.database.transaction(|tx|Box::pin(async move{
            let rows=tx.query("UPDATE chat_execution_lanes SET state='released',released_at=$1,updated_at=$2 WHERE id=$3 AND state<>'released' RETURNING to_jsonb(chat_execution_lanes)::text",&[&crate::auth::now(),&crate::auth::now(),&lane]).await?;
            let Some(released)=rows.first().map(raw).transpose()? else{return Ok(Some(json!({"chat":context["chat"],"lane":context["lane"],"returnedToPrimary":false})));};
            branch_leases::release(tx,&lane).await?;
            let mut returned=false;
            if return_to_primary && !truthy(context["worktree"].get("isPrimary")) && context["chat"].get("activeWorktreeId")==context["worktree"].get("id"){
                let roots=tx.query("SELECT to_jsonb(w)::text FROM project_worktrees w INNER JOIN project_sources s ON s.id=w.project_source_id AND s.project_id=$1 WHERE w.is_primary=true AND s.worker_id=$2 AND s.removed_at IS NULL LIMIT 1",&[&text(&context["chat"]["projectId"])?,&text(&context["lane"]["workerId"])?]).await?;
                let primary=roots.first().map(raw).transpose()?;
                let Some(primary)=primary.filter(|p|p["lifecycle_state"]=="ready") else{return Err(conflict("Primary is not ready, so this lane cannot be released safely."));};
                let primary=json!({"id":primary["id"],"workerId":primary["worker_id"],"head":primary["head"]});
                let runtime=runtime(tx,&chat,&primary,"selecting the Primary runtime").await?;
                if tx.query("SELECT id FROM chat_execution_lanes WHERE chat_id=$1 AND worktree_id=$2 AND state<>'released' LIMIT 1",&[&chat,&text(&primary["id"])?]).await?.is_empty(){
                    tx.query("INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,starting_head,runtime_session_id,codex_thread_id) VALUES($1,$2,$3,$4,'user',false,'Returned to Primary after lane release','suspended',$5,$6,$7)",&[&uuid::Uuid::new_v4().to_string(),&chat,&text(&primary["id"])?,&text(&primary["workerId"])?,&optional(&primary["head"])?,&text(&runtime["id"])?,&optional(&runtime["codex_thread_id"])?]).await?;
                }
                move_chat(tx,&chat,&primary,true).await?;returned=true;
            }
            let row=required(&tx.query("SELECT to_jsonb(c)::text FROM chats c WHERE id=$1 LIMIT 1",&[&chat]).await?,"selecting a released chat")?;
            Ok(Some(json!({"chat":super::super::summary::wire_summary(&row)?,"lane":reads::summary(&released,false)?,"returnedToPrimary":returned})))
        })).await
    }
}
