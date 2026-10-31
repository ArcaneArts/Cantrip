use super::{
    LaneError, LaneRepository, branch_leases, conflict, optional, query, raw, reads, release,
    required, text,
};
use crate::{
    database::Executor,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::Result;
use futures::FutureExt;
fn executing(status: &Value) -> bool {
    matches!(status.as_str(), Some("running" | "waiting-for-approval"))
}
fn schedule_error<T>(result: Result<T>) -> Result<T> {
    result.map_err(|error| {
        if error.is::<LaneError>() {
            return error;
        }
        if let Some(lease) = error.downcast_ref::<branch_leases::LeaseError>() {
            return conflict(&lease.message);
        }
        let message = error.to_string().to_lowercase();
        if message.contains("unique") || message.contains("duplicate") {
            return conflict("The target worktree is already leased by another chat.");
        }
        error
    })
}
impl LaneRepository {
    pub async fn schedule_transition(
        &self,
        owner: &str,
        chat: &str,
        expected_lane: &Value,
        target: &Value,
        kind: &str,
        purpose: &str,
    ) -> Result<Option<Value>> {
        let Some(current) = super::super::Repository::execution_context_with(
            Executor::Database(&self.database),
            owner,
            chat,
        )
        .boxed()
        .await?
        else {
            return Ok(None);
        };
        if current["contextKind"] != "project" {
            return Err(conflict(
                "Standalone Chats do not support worktree transitions.",
            ));
        }
        if current["worktreeMode"] == "pinned" {
            return Err(conflict(
                "This chat is pinned. Return it to Agent managed before allowing autonomous worktree transitions.",
            ));
        }
        if !executing(&current["status"]) || current.get("executionLaneId") != Some(expected_lane) {
            return Err(conflict(
                "The originating execution lane is no longer active.",
            ));
        }
        if current.get("worktreeId") == Some(target) {
            return Err(conflict(if kind == "release" {
                "The chat is already running in Primary."
            } else {
                "The chat is already running in that worktree."
            }));
        }
        // Compare wire identities before PostgreSQL text encoding replaces
        // unpaired UTF-16 units. A decoded SQL identifier is not the input.
        let target = text(target)?;
        let Some(target) = crate::projects::targets::TargetRepository::new(self.database.clone())
            .worktree_context(owner, &text(&current["projectId"])?, &target)
            .boxed()
            .await?
        else {
            return Ok(None);
        };
        if target["worktree"]["lifecycleState"] != "ready" {
            return Ok(None);
        }
        if target.get("workerId") != current.get("workerId") {
            return Err(conflict(
                "Moving a chat to another worker requires a durable relocation.",
            ));
        }
        if kind == "release" && !truthy(target["worktree"].get("isPrimary")) {
            return Err(conflict(
                "A release transition must return the chat to Primary.",
            ));
        }
        let consoles = self
            .database
            .query(
                "SELECT status FROM terminals WHERE linked_chat_id=$1",
                &[&chat],
            )
            .await?;
        for row in consoles {
            if row.get::<String>(0)? == "running" {
                return Err(conflict(
                    "Stop the linked Codex console before changing worktrees.",
                ));
            }
        }
        let (chat, kind, purpose) = (chat.to_owned(), kind.to_owned(), purpose.to_owned());
        let lookup_chat = chat.clone();
        let result=self.database.transaction(|tx|Box::pin(async move{
            let ex=Executor::Transaction(tx);let now=crate::auth::now();
            query(ex,"UPDATE chat_execution_lanes SET state='suspended',transition_kind=NULL,updated_at=$1 WHERE chat_id=$2 AND state='delivering'",&[&now,&chat],&[json!(crate::auth::iso(now)),json!(chat)]).await?;
            let tree=&target["worktree"];let worker=text(&target["workerId"])?;let id=text(&tree["id"])?;
            let runtime_id=uuid::Uuid::new_v4().to_string();
            query(ex,"INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id) VALUES($1,$2,$3,$4) ON CONFLICT(chat_id,worker_id,worktree_id) WHERE worktree_id IS NOT NULL DO NOTHING",&[&runtime_id,&chat,&worker,&id],&[json!(runtime_id),json!(chat),json!(worker),json!(id)]).await?;
            let runtime=required(&query(ex,"SELECT to_jsonb(r)::text FROM chat_runtime_sessions r WHERE chat_id=$1 AND worker_id=$2 AND worktree_id=$3 LIMIT 1",&[&chat,&worker,&id],&[json!(chat),json!(worker),json!(id)]).await?,"selecting a transition runtime")?;
            let rows=query(ex,"SELECT to_jsonb(l)::text FROM chat_execution_lanes l WHERE chat_id=$1 AND worktree_id=$2 AND state<>'released' ORDER BY created_at DESC LIMIT 1",&[&chat,&id],&[json!(chat),json!(id)]).await?;
            let lane=rows.first().map(raw).transpose()?;let lane_id=lane.as_ref().map(|l|text(&l["id"])).transpose()?.unwrap_or_else(||uuid::Uuid::new_v4().to_string());
            let exclusive=!truthy(tree.get("isPrimary"));let runtime_id=text(&runtime["id"])?;let thread=optional(&runtime["codex_thread_id"])?;
            if lane.is_some(){
                let now=crate::auth::now();
                query(ex,"UPDATE chat_execution_lanes SET acquiring_actor='agent',exclusive=$1,purpose=$2,state='delivering',transition_kind=$3,runtime_session_id=$4,codex_thread_id=$5,updated_at=$6 WHERE id=$7",&[&exclusive,&purpose,&kind,&runtime_id,&thread,&now,&lane_id],&[json!(exclusive),json!(purpose),json!(kind),json!(runtime_id),json!(thread),json!(crate::auth::iso(now)),json!(lane_id)]).await?;
            }else{
                let head=optional(&tree["head"])?;
                query(ex,"INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,transition_kind,starting_head,runtime_session_id,codex_thread_id) VALUES($1,$2,$3,$4,'agent',$5,$6,'delivering',$7,$8,$9,$10) RETURNING id",&[&lane_id,&chat,&id,&worker,&exclusive,&purpose,&kind,&head,&runtime_id,&thread],&[json!(lane_id),json!(chat),json!(id),json!(worker),json!(exclusive),json!(purpose),json!(kind),json!(head),json!(runtime_id),json!(thread)]).await?.first().ok_or_else(||anyhow::anyhow!("Database returned no row after scheduling a worktree transition."))?;
            }
            let root=json!({"id":tree["id"],"branch":tree["branch"],"detached":tree["detached"],"worker_id":target["workerId"]});
            branch_leases::acquire(tx,&text(&current["projectId"])?,&chat,&lane_id,&root).await?;
            Ok(lane_id)
        })).await;
        let lane = schedule_error(result)?;
        self.lane_context(owner, &lookup_chat, &lane).boxed().await
    }
    pub async fn cancel_transition(&self, owner: &str, chat: &str, lane: &str) -> Result<bool> {
        let Some(context) = self
            .lane_context(owner, chat, lane)
            .boxed()
            .await?
            .filter(|c| c["lane"]["state"] == "delivering")
        else {
            return Ok(false);
        };
        let lane = lane.to_owned();
        self.database.transaction(|tx|Box::pin(async move{
            let rows=tx.query("UPDATE chat_execution_lanes SET state='suspended',transition_kind=NULL,updated_at=$1 WHERE id=$2 RETURNING id",&[&crate::auth::now(),&lane]).await?;
            if !rows.is_empty()&&truthy(context["worktree"].get("isPrimary")){branch_leases::release(tx,&lane).await?;}
            Ok(rows.len()==1)
        })).await
    }
    pub async fn apply_transition(
        &self,
        owner: &str,
        chat: &str,
        lane: &str,
    ) -> Result<Option<Value>> {
        let Some(pending) = self
            .lane_context(owner, chat, lane)
            .boxed()
            .await?
            .filter(|p| p["lane"]["state"] == "delivering")
        else {
            return Ok(None);
        };
        if !truthy(pending["lane"].get("transitionKind")) {
            return Ok(None);
        }
        if pending["worktree"]["lifecycleState"] != "ready" {
            return Err(conflict(
                "The target worktree is no longer ready for execution.",
            ));
        }
        if pending["worktree"].get("workerId") != pending["chat"].get("activeWorkerId") {
            return Err(conflict(
                "Moving a chat to another worker requires a durable relocation.",
            ));
        }
        if executing(&pending["chat"]["status"]) {
            return Err(conflict(
                "Finish the active turn before applying its worktree transition.",
            ));
        }
        let (chat, lane) = (chat.to_owned(), lane.to_owned());
        self.database.transaction(|tx|Box::pin(async move{
            let from=&pending["chat"]["activeWorktreeId"];let kind=&pending["lane"]["transitionKind"];
            if kind=="release"{
                let lanes=tx.query("UPDATE chat_execution_lanes SET state='released',released_at=$1,updated_at=$2 WHERE chat_id=$3 AND worktree_id=$4 AND state<>'released' RETURNING id",&[&crate::auth::now(),&crate::auth::now(),&chat,&optional(from)?]).await?;
                for lane in lanes{branch_leases::release(tx,&lane.get::<String>(0)?).await?;}
            }
            let row=required(&tx.query("UPDATE chat_execution_lanes SET state='suspended',transition_kind=NULL,updated_at=$1 WHERE id=$2 AND state='delivering' RETURNING to_jsonb(chat_execution_lanes)::text",&[&crate::auth::now(),&lane]).await?,"applying a worktree transition")?;
            if truthy(pending["worktree"].get("isPrimary")){branch_leases::release(tx,&text(&row["id"])?).await?;}
            let chat=required(&release::move_chat(tx,&chat,&pending["worktree"],false).await?,"switching chat worktrees")?;
            Ok(Some(json!({"chat":super::super::summary::wire_summary(&chat)?,"fromWorktreeId":from,"lane":reads::summary(&row,false)?,"transitionKind":kind,"worktree":pending["worktree"]})))
        })).await
    }
}
