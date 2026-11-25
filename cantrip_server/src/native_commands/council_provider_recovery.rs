//! The worker reports quota through the exact native terminal receipt.
use super::{
    Repository,
    admit::{reject, text},
    context,
    transaction::TransactionRepository,
};
use crate::{
    database::Transaction,
    wire::{Value, value::json},
};
use anyhow::Result;

pub(super) async fn record_terminal_quota(
    tx: &Transaction<'_>,
    operation: &Value,
    input: &Value,
) -> Result<()> {
    let evidence = &input["reconciliation"];
    if evidence["terminalStatus"] != "failed"
        || input["status"] != "applied"
        || operation["kind"] != "start"
        || operation["origin"] != "gui"
        || operation["identity"]["contextKind"] != "standalone"
    {
        return reject("stale-native-evidence");
    }
    let chat = text(&operation["chat_id"])?;
    let owner = text(&operation["owner_id"])?;
    let run = text(&operation["logical_operation_id"])?;
    let source = text(&operation["operation_id"])?;
    let generation = text(&operation["operation_generation"])?;
    let turn = text(&evidence["nativeTurnId"])?;
    let agents = tx
        .query(
            "SELECT chat_id FROM council_agents WHERE chat_id=$1 AND owner_id=$2",
            &[&chat, &owner],
        )
        .await?;
    if agents.is_empty() {
        return reject("stale-native-evidence");
    }
    tx.query(
        "INSERT INTO council_provider_recoveries(run_id,chat_id,source_operation_id,source_turn_id)
           SELECT COALESCE((
             SELECT previous.run_id FROM managed_queue_claims q
             JOIN council_provider_recoveries previous ON previous.continuation_prompt_id=q.prompt_id
             WHERE q.chat_id=c.id AND previous.chat_id=c.id
               AND q.operation_id=$3 AND q.operation_generation=$5
           ),$1),$2,$3,$4 FROM chats c
           WHERE c.id=$2 AND c.archived_at IS NULL AND NOT c.managed_autonomy_stopped
           ON CONFLICT(source_operation_id) DO NOTHING",
        &[&run, &chat, &source, &turn, &generation],
    )
    .await?;
    Ok(())
}

pub(crate) async fn stop(tx: &Transaction<'_>, chat: &str) -> Result<()> {
    tx.query(
        "WITH stopped AS (
            UPDATE council_provider_recoveries SET phase='cancelled',updated_at=now()
            WHERE chat_id=$1 AND phase IN ('pending','blocked','switching','continuation-queued')
            RETURNING continuation_prompt_id
         ) DELETE FROM queued_prompts p USING stopped s
           WHERE p.id=s.continuation_prompt_id AND (p.state='pending' OR (
               p.state='claimed' AND NOT EXISTS (
                   SELECT 1 FROM managed_queue_claims q
                   WHERE q.prompt_id=p.id AND q.operation_id IS NOT NULL
                     AND q.status IN ('accepted','dispatched','uncertain')
               )
           ))",
        &[&chat],
    )
    .await?;
    Ok(())
}

pub(crate) async fn redact(tx: &Transaction<'_>, chat: &str, message: &str) -> Result<Vec<String>> {
    stop(tx, chat).await?;
    let deleted = tx
        .query(
            "DELETE FROM chat_messages m USING council_provider_recoveries r
         WHERE r.chat_id=$1 AND $2=ANY(r.history_message_ids)
           AND m.chat_id=r.chat_id AND m.id=r.continuation_message_id
         RETURNING m.id",
            &[&chat, &message],
        )
        .await?;
    tx.query(
        "DELETE FROM queued_prompts p USING council_provider_recoveries r
         WHERE r.chat_id=$1 AND $2=ANY(r.history_message_ids) AND p.id=r.continuation_prompt_id",
        &[&chat, &message],
    )
    .await?;
    super::queue::changed(tx, chat).await?;
    deleted
        .into_iter()
        .map(|row| row.get::<String>(0).map_err(Into::into))
        .collect()
}

impl Repository {
    pub(crate) async fn pending_council_provider_recovery(
        &self,
        owner: &str,
        chat: &str,
    ) -> Result<Option<Value>> {
        let rows = self.database.query(
            "SELECT jsonb_build_object(
                'runId',r.run_id,'phase',r.phase,'handoffId',r.handoff_id,
                'sourceOperationId',r.source_operation_id,'sourceTurnId',r.source_turn_id,
                'sourceThreadId',s.identity->>'threadId',
                'modelId',m.model_id,
                'exhaustedRoutes',(
                   SELECT jsonb_agg(jsonb_build_object(
                     'routeId',attempt.identity->>'modelRouteId',
                     'accountId',attempt.identity->>'providerAccountId'
                   ))
                   FROM council_provider_recoveries p JOIN native_commands attempt
                   ON attempt.operation_id=p.source_operation_id AND attempt.chat_id=p.chat_id
                   WHERE p.run_id=r.run_id AND p.chat_id=r.chat_id
                ),
                'sourceReady',s.execution_completed_at IS NOT NULL OR s.logical_completed_at IS NOT NULL,
                'targetModelRouteId',r.target_model_route_id,'targetProviderAccountId',r.target_provider_account_id,
                'continuationPromptId',r.continuation_prompt_id,'sourceMessageId',root.logical_client_message_id)::text
              FROM council_provider_recoveries r
              JOIN native_commands s ON s.operation_id=r.source_operation_id AND s.owner_id=$1 AND s.chat_id=r.chat_id
              JOIN native_commands root ON root.operation_id=r.run_id AND root.chat_id=r.chat_id
              LEFT JOIN model_routes m ON m.id=s.identity->>'modelRouteId'
              JOIN chats c ON c.id=r.chat_id AND c.archived_at IS NULL AND NOT c.managed_autonomy_stopped
              WHERE r.chat_id=$2 AND r.phase IN ('pending','blocked','switching') ORDER BY r.updated_at DESC LIMIT 1",
            &[&owner, &chat],
        ).await?;
        rows.first()
            .map(|row| Ok(serde_json::from_str(row.get::<&str>(0)?)?))
            .transpose()
    }

    pub(crate) async fn set_council_provider_route(
        &self,
        owner: &str,
        chat: &str,
        source: &str,
        target: Option<&Value>,
    ) -> Result<bool> {
        let route = target.and_then(|v| v["routeId"].as_str());
        let account = target.and_then(|v| v["provider"]["accountId"].as_str());
        let phase = if route.is_some() {
            "switching"
        } else {
            "blocked"
        };
        let handoff = route.map(|_| uuid::Uuid::new_v4().to_string());
        let rows = self.database.query(
            "UPDATE council_provider_recoveries r SET phase=$4,target_model_route_id=$5,target_provider_account_id=$6,
                 handoff_id=$7::text::uuid,updated_at=now()
             FROM council_agents a
             WHERE r.source_operation_id=$3 AND r.chat_id=$2 AND a.chat_id=r.chat_id AND a.owner_id=$1
                 AND r.phase IN ('pending','blocked') AND r.phase<>$4
             RETURNING r.run_id",
            &[&owner,&chat,&source,&phase,&route,&account,&handoff],
        ).await?;
        Ok(!rows.is_empty())
    }

    pub(crate) async fn enqueue_council_provider_continuation(
        &self,
        owner: &str,
        recovery: &Value,
        expected: &Value,
        prepared: &Value,
        history_ids: Vec<String>,
    ) -> Result<bool> {
        let (owner, recovery, expected, prepared) = (
            owner.to_owned(),
            recovery.clone(),
            expected.clone(),
            prepared.clone(),
        );
        self.database.transaction(move |tx| Box::pin(async move {
            let chat = text(&expected["chatId"])?;
            let source = text(&recovery["sourceOperationId"])?;
            let prompt = &prepared["queuedPrompt"];
            let id = text(&prompt["id"])?;
            let message = text(&prepared["message"]["id"])?;
            context::lock_chat(tx,&owner,&chat).await?;
            let Some(current) = context::execution(tx,&owner,&chat).await? else { return Ok(false); };
            if current["councilAgent"]["historyEpoch"] != expected["councilAgent"]["historyEpoch"]
                || current["workerId"] != expected["workerId"]
                || current["threadId"] != recovery["sourceThreadId"]
                || current["modelRouteId"] != recovery["targetModelRouteId"]
                || current["providerAccountId"] != recovery["targetProviderAccountId"]
                || !current["executionLaneId"].is_null()
                || current["automationPaused"] == true
            {
                return Ok(false);
            }
            let marker = tx.query(
                "SELECT r.run_id FROM council_provider_recoveries r
                 JOIN chats c ON c.id=r.chat_id AND c.owner_id=$1 AND NOT c.managed_autonomy_stopped
                 WHERE r.source_operation_id=$2 AND r.chat_id=$3 AND r.phase='switching'
                   AND r.handoff_id=$4::text::uuid FOR UPDATE OF r",
                &[&owner,&source,&chat,&text(&recovery["handoffId"])?],
            ).await?;
            if marker.is_empty() {
                return Ok(false);
            }
            let retained = tx.query(
                "SELECT id FROM chat_messages WHERE chat_id=$1 AND id=ANY($2::text[])",
                &[&chat,&history_ids],
            ).await?;
            if retained.len() != history_ids.len() {
                return Ok(false);
            }
            let result = TransactionRepository::new(tx).add_gui_prompt(
                &owner,&current,prompt,
                &json!({"operationId":prompt["idempotencyKey"],"resumeAutonomy":false}),
            ).await?;
            if result["acceptedItem"].is_null() {
                return Ok(false);
            }
            tx.query(
                "UPDATE queued_prompts p SET position=COALESCE((
                   SELECT min(q.position)-1 FROM queued_prompts q WHERE q.chat_id=$2 AND q.state='pending' AND q.id<>p.id
                 ),p.position) WHERE p.id=$1 AND p.chat_id=$2",
                &[&id,&chat],
            ).await?;
            tx.query(
                "UPDATE council_provider_recoveries SET phase='continuation-queued',continuation_prompt_id=$2,
                 continuation_message_id=$3,history_message_ids=$4,updated_at=now() WHERE source_operation_id=$1",
                &[&source,&id,&message,&history_ids],
            ).await?;
            Ok(true)
        })).await
    }
}
