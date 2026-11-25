//! Positive native evidence can settle a steer whose Worker died before replying.
use super::{
    Repository,
    admit::{raw_one, text},
    context, queue, queued_prompt,
    recovery::terminal_reconciliation,
    settlement,
};
use crate::{
    chats::{message_writes, steering},
    database::Executor,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};

const CANDIDATES: &str = r#"
  FROM native_commands n
  JOIN chats c ON c.id=n.chat_id AND c.owner_id=n.owner_id
  JOIN native_command_activations a ON a.chat_id=c.id
     AND a.generation=n.activation_generation AND a.execution_lane_id=n.execution_lane_id
     AND a.worker_id=n.worker_id AND a.active
  JOIN managed_queue_claims q ON q.chat_id=c.id AND q.operation_id=n.operation_id
     AND q.operation_generation=n.operation_generation AND q.status IN ('dispatched','uncertain')
  JOIN queued_prompts p ON p.id=q.prompt_id AND p.chat_id=c.id
     AND p.state='claimed' AND p.revision=q.prompt_revision
  WHERE n.owner_id=$1 AND n.worker_id=$2 AND c.active_worker_id=$2
    AND n.intent->>'workerGeneration'<>$3
    AND c.context_kind='council' AND c.archived_at IS NULL
    AND n.method='turn/steer' AND n.origin='gui' AND n.status IN ('dispatched','uncertain')
    AND n.intent->>'expectedTurnId'=a.native_turn_id
    AND n.identity->>'runtimeGeneration'=a.runtime_generation
"#;

impl Repository {
    pub(crate) async fn council_steer_recovery_chats(
        &self,
        owner: &str,
        worker: &str,
        process: &str,
    ) -> Result<Vec<String>> {
        let rows = self
            .database
            .query(
                &format!("SELECT DISTINCT c.id {CANDIDATES}"),
                &[&owner, &worker, &process],
            )
            .await?;
        rows.iter().map(|row| row.get(0)).collect()
    }

    pub(crate) async fn council_steer_recovery_inputs(
        &self,
        owner: &str,
        worker: &str,
        process: &str,
        chat: &str,
    ) -> Result<Vec<Value>> {
        let rows = self.database.query(&format!(
            "SELECT jsonb_build_object(
               'operationId',n.operation_id,'operationGeneration',n.operation_generation,
               'clientUserMessageId',COALESCE(p.opaque_content->>'nativeClientUserMessageId','cantrip:' || (p.opaque_content->'pendingMessage'->>'id')))::text
             {CANDIDATES} AND c.id=$4 ORDER BY p.position LIMIT 64"
        ), &[&owner,&worker,&process,&chat]).await?;
        rows.iter()
            .map(|row| Ok(serde_json::from_str(row.get::<&str>(0)?)?))
            .collect()
    }

    pub(crate) async fn settle_council_steer_recovery(
        &self,
        owner: &str,
        worker: &str,
        process: &str,
        chat: &str,
        recovery: &Value,
        candidates: Vec<Value>,
        observed: &Value,
    ) -> Result<Option<Vec<Value>>> {
        let Some(root) = terminal_reconciliation(worker, recovery, observed) else {
            return Ok(None);
        };
        let Some(items) = observed["observedInputs"].as_array() else {
            return Ok(None);
        };
        let mut observations = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            let mut matches = items
                .iter()
                .filter(|item| item["clientUserMessageId"] == candidate["clientUserMessageId"]);
            let Some(item) = matches.next().filter(|_| matches.next().is_none()) else {
                // A missing item cannot justify admitting the steer again.
                return Ok(None);
            };
            observations.push((candidate, item.clone()));
        }
        let (owner, worker, process, chat) = (
            owner.to_owned(),
            worker.to_owned(),
            process.to_owned(),
            chat.to_owned(),
        );
        let observed = observed.clone();
        self.database.transaction(move |tx| Box::pin(async move {
            context::lock_chat(tx,&owner,&chat).await?;
            let ex = Executor::Transaction(tx);
            let Some(current) = context::execution(tx,&owner,&chat).await? else { return Ok(None) };
            let mut rows = Vec::with_capacity(observations.len());
            for (candidate, item) in observations {
                let operation = text(&candidate["operationId"])?;
                let generation = text(&candidate["operationGeneration"])?;
                let Some(row) = raw_one(tx, &format!(
                    "SELECT (to_jsonb(n) || jsonb_build_object('promptId',p.id,
                        'clientUserMessageId',COALESCE(p.opaque_content->>'nativeClientUserMessageId','cantrip:' || (p.opaque_content->'pendingMessage'->>'id'))))::text
                      {CANDIDATES} AND c.id=$4 AND n.operation_id=$5 AND n.operation_generation=$6"
                ), &[&owner,&worker,&process,&chat,&operation,&generation]).await? else { return Ok(None) };
                if current["executionLaneId"] != row["execution_lane_id"]
                    || current["threadId"] != observed["threadId"]
                    || row["identity"]["threadId"] != observed["threadId"]
                    || row["intent"]["expectedTurnId"] != observed["turnId"]
                    || row["identity"]["runtimeGeneration"] == observed["runtimeGeneration"]
                    || row["clientUserMessageId"] != item["clientUserMessageId"]
                {
                    return Ok(None);
                }
                rows.push((row, item, operation));
            }
            let attribution = steering::attribution(&current);
            let now = crate::auth::now();
            let mut messages = Vec::with_capacity(rows.len());
            for (mut row, item, operation) in rows {
                let prompt = queued_prompt::encrypted_get(ex,&owner,&text(&row["promptId"])?).await?
                    .context("Recovered Council prompt is unavailable.")?;
                let message = message_writes::write_in_transaction(
                    tx,&owner,&chat,&prompt["pendingMessage"],attribution.as_ref(),false,
                ).await?.context("Recovered Council prompt could not be retained.")?;
                row["status"] = json!("applied");
                row["terminal_evidence"] = json!({"kind":"council-steer-observed",
                    "runtimeGeneration":observed["runtimeGeneration"],"nativeTurnId":observed["turnId"],
                    "clientUserMessageId":item["clientUserMessageId"],"itemId":item["itemId"]});
                tx.query(
                    "UPDATE native_commands SET status='applied',rejection_code=NULL,terminal_evidence=$1::text::jsonb,
                       execution_completed_at=COALESCE(execution_completed_at,$2),updated_at=$2 WHERE operation_id=$3",
                    &[&row["terminal_evidence"].stringify(),&now,&operation],
                ).await?;
                queue::settle(tx,&row,observed["turnId"].as_str(),None).await?;
                messages.push(message);
            }
            settlement::settle(tx,&owner,&root).await?;
            Ok(Some(messages))
        })).await
    }
}
