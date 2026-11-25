//! Convert a definitive refused Resume into a terminal native Stop and one retry.
use super::{Repository, context, raw_one, suspension, text};
use crate::wire::{Value, value::json};
use anyhow::Result;

impl Repository {
    pub(crate) async fn begin_council_checkpoint_fallback(
        &self,
        owner: &str,
        chat: &str,
        source: &str,
        observed: &Value,
    ) -> Result<bool> {
        let (owner, chat, source, observed) = (
            owner.to_owned(),
            chat.to_owned(),
            source.to_owned(),
            observed.clone(),
        );
        self.database.transaction(move |tx| Box::pin(async move {
            context::lock_chat(tx, &owner, &chat).await?;
            let row = suspension::chat(tx, &owner, &chat).await?;
            let Some(mut state) = suspension::read(&row)? else { return Ok(false); };
            let Some(current) = context::execution(tx, &owner, &chat).await? else { return Ok(false); };
            if state != observed
                || state["phase"] != "error"
                || state["action"] != "resume"
                || state["error"]["code"] != "checkpoint-incompatible"
                || state["checkpoint"].is_null()
                || !suspension::same_source(&state, &row, &current)
            {
                return Ok(false);
            }
            let stop = uuid::Uuid::new_v4().to_string();
            let active = &state["active"];
            let execution = &state["executionOwner"];
            let changed = tx.query(
                "UPDATE council_live_provider_switches s SET phase='reconciling',
                   fallback_stop_id=$4::text::uuid,updated_at=now()
                 FROM chats c, native_command_activations a, native_commands n
                 WHERE c.id=s.chat_id AND c.owner_id=$1 AND c.archived_at IS NULL
                   AND NOT c.managed_autonomy_stopped
                   AND s.chat_id=$2 AND s.source_operation_id=$3 AND s.phase='resuming'
                   AND s.source_thread_id=$5 AND s.source_turn_id=$6
                   AND s.target_model_route_id=$7 AND s.target_provider_account_id IS NOT DISTINCT FROM $8::text
                   AND a.chat_id=s.chat_id AND a.active AND NOT a.logical_cancelled
                   AND a.operation_id=$9 AND a.runtime_generation=$10 AND a.native_turn_id=$6
                   AND n.operation_id=a.operation_id AND n.operation_generation=$11
                   AND n.intent->'restoredSuspension'->>'controlId'=$12
                   AND n.intent->'restoredSuspension'->'source'->>'operationId'=s.source_operation_id
                   AND n.execution_completed_at IS NULL AND n.status='applied'
                 RETURNING s.source_operation_id",
                &[&owner,&chat,&source,&stop,&text(&active["threadId"])?,
                  &text(&active["turnId"])?,&text(&state["target"]["modelRouteId"])?,
                  &state["target"]["providerAccountId"].as_str(),&text(&execution["operationId"])?,
                  &text(&execution["runtimeGeneration"])?,&text(&execution["operationGeneration"])?,
                  &text(&state["controlId"])?],
            ).await?;
            if changed.is_empty() {
                return Ok(false);
            }
            state["controlId"] = json!(stop);
            state["actorControlId"] = Value::Null;
            state["action"] = json!("stop");
            state["phase"] = json!("stopping");
            state["error"] = Value::Null;
            state["requestedAt"] = json!(crate::auth::iso(crate::auth::now()));
            suspension::save(tx, &owner, &chat, state, true).await?;
            Ok(true)
        })).await
    }

    pub(crate) async fn finish_council_checkpoint_fallback(
        &self,
        owner: &str,
        chat: &str,
        source: &str,
    ) -> Result<bool> {
        let (owner, chat, source) = (owner.to_owned(), chat.to_owned(), source.to_owned());
        self.database.transaction(move |tx| Box::pin(async move {
            context::lock_chat(tx, &owner, &chat).await?;
            let chat_row = suspension::chat(tx, &owner, &chat).await?;
            let Some(state) = suspension::read(&chat_row)? else { return Ok(false); };
            if state["phase"] != "stopped"
                || state["action"] != "stop"
                || chat_row["managed_autonomy_stopped"] == true
                || !chat_row["archived_at"].is_null()
            {
                return Ok(false);
            }
            let proof = raw_one(tx,
                "SELECT to_jsonb(n)::text FROM council_live_provider_switches s
                 JOIN native_commands source ON source.operation_id=s.source_operation_id
                 JOIN native_commands root ON root.operation_id=source.logical_operation_id
                 JOIN native_commands n ON n.operation_id=$4 AND n.logical_operation_id=root.operation_id
                   AND n.operation_generation=$5 AND n.owner_id=$1 AND n.chat_id=s.chat_id
                 WHERE s.chat_id=$2 AND s.source_operation_id=$3 AND s.phase='reconciling'
                   AND s.fallback_stop_id::text=$6 AND n.execution_completed_at IS NOT NULL
                   AND root.logical_completed_at IS NOT NULL
                   AND n.intent->'restoredSuspension'->>'action'='stop'
                   AND n.intent->'restoredSuspension'->>'controlId'=$6",
                &[&owner,&chat,&source,&text(&state["executionOwner"]["operationId"])?,
                  &text(&state["executionOwner"]["operationGeneration"])?,&text(&state["controlId"])?],
            ).await?;
            let Some(proof) = proof.filter(|proof| {
                suspension::owns_execution(&state, proof) && suspension::terminal_proof(&state, proof)
            }) else { return Ok(false); };
            let native_interrupted = proof["terminal_evidence"]["terminalStatus"] == "interrupted";
            if native_interrupted {
                tx.query(
                    "INSERT INTO council_provider_recoveries(run_id,chat_id,source_operation_id,source_turn_id)
                     SELECT COALESCE((
                         SELECT previous.run_id FROM managed_queue_claims q
                         JOIN council_provider_recoveries previous ON previous.continuation_prompt_id=q.prompt_id
                         WHERE q.chat_id=s.chat_id AND previous.chat_id=s.chat_id
                           AND q.operation_id=n.operation_id AND q.operation_generation=n.operation_generation
                       ),n.logical_operation_id),s.chat_id,s.source_operation_id,s.source_turn_id
                     FROM council_live_provider_switches s JOIN native_commands n ON n.operation_id=s.source_operation_id
                     WHERE s.chat_id=$1 AND s.source_operation_id=$2
                     ON CONFLICT(source_operation_id) DO NOTHING",
                    &[&chat,&source],
                ).await?;
            }
            tx.query(
                "UPDATE council_live_provider_switches SET phase=$3,updated_at=now()
                 WHERE chat_id=$1 AND source_operation_id=$2",
                &[&chat,&source,&if native_interrupted { "continued" } else { "completed" }],
            ).await?;
            Ok(true)
        })).await
    }
}
