//! Exact native quota observations only apply to their originating Council run.
#[path = "council_checkpoint_fallback.rs"]
mod fallback;

use super::{
    Repository,
    admit::{raw_one, reject, text},
    context, settings_persistence, settings_state, suspension,
};
use crate::{
    database::{Executor, Transaction},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};

pub(super) async fn assert_pause(
    tx: &Transaction<'_>,
    owner: &str,
    command: &Value,
    input: &Value,
    chat: &Value,
) -> Result<()> {
    let id = text(&chat["id"])?;
    let operation = text(&command["operation_id"])?;
    let worker = text(&command["worker_id"])?;
    let generation = text(&command["activation_generation"])?;
    let turn = text(&command["intent"]["expectedTurnId"])?;
    let runtime = text(&input["session"]["runtimeGeneration"])?;
    let rows = tx.query(
        "SELECT s.source_operation_id FROM council_live_provider_switches s
         JOIN chats c ON c.id=s.chat_id AND c.owner_id=$1 AND NOT c.managed_autonomy_stopped
         JOIN native_command_activations a ON a.chat_id=s.chat_id AND a.operation_id=s.source_operation_id
         WHERE s.chat_id=$2 AND s.pause_control_id=$3::text::uuid AND a.worker_id=$4
           AND a.generation=$5 AND s.source_turn_id=$6 AND s.source_runtime_generation=$7
           AND a.active AND NOT a.logical_cancelled AND s.phase='pausing'",
        &[&owner,&id,&operation,&worker,&generation,&turn,&runtime],
    ).await?;
    if rows.is_empty() {
        return reject("suspension-control-stale");
    }
    Ok(())
}

pub(super) async fn cancel(tx: &Transaction<'_>, chat: &str) -> Result<()> {
    tx.query(
        "UPDATE council_live_provider_switches SET phase='cancelled',updated_at=now()
         WHERE chat_id=$1 AND phase IN ('observed','pausing','restarting','resuming','reconciling')",
        &[&chat],
    )
    .await?;
    Ok(())
}

pub(super) async fn owns_fallback_stop(
    tx: &Transaction<'_>,
    chat: &str,
    state: &Value,
) -> Result<bool> {
    let Some(control) = state["controlId"].as_str() else {
        return Ok(false);
    };
    let rows = tx
        .query(
            "SELECT source_operation_id FROM council_live_provider_switches
         WHERE chat_id=$1 AND phase='reconciling' AND fallback_stop_id::text=$2
           AND source_thread_id=$3 AND source_turn_id=$4",
            &[
                &chat,
                &control,
                &state["active"]["threadId"].as_str(),
                &state["active"]["turnId"].as_str(),
            ],
        )
        .await?;
    Ok(!rows.is_empty())
}

impl Repository {
    pub(crate) async fn observe_council_quota(
        &self,
        owner: &str,
        chat: &str,
        worker: &str,
        lane: &str,
        event: &Value,
    ) -> Result<()> {
        let thread = text(&event["threadId"])?;
        let turn = text(&event["turnId"])?;
        let runtime = text(&event["runtimeGeneration"])?;
        self.database.query(
            "INSERT INTO council_live_provider_switches(source_operation_id,chat_id,
                 source_thread_id,source_turn_id,source_runtime_generation)
             SELECT n.operation_id,c.id,$5,$6,$7
             FROM chats c JOIN council_agents ca ON ca.chat_id=c.id AND ca.owner_id=c.owner_id
             JOIN native_command_activations a ON a.chat_id=c.id AND a.active AND NOT a.logical_cancelled
             JOIN native_commands n ON n.operation_id=a.operation_id AND n.owner_id=c.owner_id
             WHERE c.owner_id=$1 AND c.id=$2 AND c.active_worker_id=$3 AND c.archived_at IS NULL
               AND NOT c.automation_paused AND NOT c.managed_autonomy_stopped
               AND a.worker_id=$3 AND a.execution_lane_id=$4 AND a.runtime_generation=$7
               AND (a.native_turn_id IS NULL OR a.native_turn_id=$6)
               AND n.kind='start' AND n.identity->>'threadId'=$5 AND n.identity->>'providerAccountId' IS NOT NULL
             ON CONFLICT(source_operation_id) DO NOTHING",
            &[&owner,&chat,&worker,&lane,&thread,&turn,&runtime],
        ).await?;
        Ok(())
    }

    pub(crate) async fn pending_council_live_switch(
        &self,
        owner: &str,
        chat: &str,
    ) -> Result<Option<Value>> {
        let rows = self.database.query(
            "SELECT (to_jsonb(s) || jsonb_build_object('model_id',r.model_id,'provider_id',r.provider_id,
                'from_route',n.identity->>'modelRouteId','from_account',n.identity->>'providerAccountId',
                'source_active',a.active AND NOT a.logical_cancelled AND a.operation_id=s.source_operation_id
                    AND a.native_turn_id=s.source_turn_id AND a.runtime_generation=s.source_runtime_generation,
                'source_ended',NOT COALESCE(a.active,false) OR n.logical_completed_at IS NOT NULL,
                'activation_generation',a.generation))::text
             FROM council_live_provider_switches s
             JOIN native_commands n ON n.operation_id=s.source_operation_id AND n.owner_id=$1
             JOIN chats c ON c.id=s.chat_id AND c.owner_id=$1 AND NOT c.managed_autonomy_stopped AND c.archived_at IS NULL
             JOIN model_routes r ON r.id=n.identity->>'modelRouteId'
             LEFT JOIN native_command_activations a ON a.chat_id=s.chat_id
             WHERE s.chat_id=$2 AND s.phase IN ('observed','pausing','restarting','resuming','reconciling')
             ORDER BY s.updated_at DESC LIMIT 1",
            &[&owner,&chat],
        ).await?;
        rows.first()
            .map(|row| Ok(serde_json::from_str(row.get::<&str>(0)?)?))
            .transpose()
    }

    pub(crate) async fn reserve_council_live_switch(
        &self,
        owner: &str,
        chat: &str,
        source: &str,
        route: &str,
        account: Option<&str>,
    ) -> Result<bool> {
        let control = uuid::Uuid::new_v4().to_string();
        let rows = self.database.query(
            "UPDATE council_live_provider_switches s SET phase='pausing',
               pause_control_id=$6::text::uuid,target_model_route_id=$4,target_provider_account_id=$5,updated_at=now()
             FROM chats c, native_command_activations a
             WHERE c.id=s.chat_id AND c.owner_id=$1 AND c.archived_at IS NULL
               AND NOT c.automation_paused AND NOT c.managed_autonomy_stopped
               AND a.chat_id=s.chat_id AND a.operation_id=s.source_operation_id AND a.active AND NOT a.logical_cancelled
               AND a.native_turn_id=s.source_turn_id AND a.runtime_generation=s.source_runtime_generation
               AND s.chat_id=$2 AND s.source_operation_id=$3 AND s.phase='observed'
             RETURNING s.source_operation_id",
            &[&owner,&chat,&source,&route,&account,&control],
        ).await?;
        Ok(!rows.is_empty())
    }

    pub(crate) async fn set_council_live_switch_phase(
        &self,
        owner: &str,
        chat: &str,
        source: &str,
        previous: &str,
        next: &str,
    ) -> Result<bool> {
        let rows = self
            .database
            .query(
                "UPDATE council_live_provider_switches s SET phase=$5,updated_at=now()
             FROM chats c WHERE c.id=s.chat_id AND c.owner_id=$1 AND s.chat_id=$2
               AND s.source_operation_id=$3 AND s.phase=$4 RETURNING s.source_operation_id",
                &[&owner, &chat, &source, &previous, &next],
            )
            .await?;
        Ok(!rows.is_empty())
    }

    pub(crate) async fn commit_council_live_switch(
        &self,
        owner: &str,
        chat: &str,
        source: &str,
        retirement: &Value,
    ) -> Result<bool> {
        let (owner, chat, source, retirement) = (
            owner.to_owned(),
            chat.to_owned(),
            source.to_owned(),
            retirement.clone(),
        );
        self.database.transaction(move |tx| Box::pin(async move {
            context::lock_chat(tx, &owner, &chat).await?;
            let row = suspension::chat(tx,&owner,&chat).await?;
            let Some(mut state) = suspension::read(&row)? else { return Ok(false); };
            let Some(current) = context::execution(tx,&owner,&chat).await? else { return Ok(false); };
            let Some(entry) = raw_one(tx,
                "SELECT (to_jsonb(s) || jsonb_build_object('from_route',n.identity->>'modelRouteId',
                    'from_account',n.identity->>'providerAccountId'))::text
                 FROM council_live_provider_switches s JOIN native_commands n ON n.operation_id=s.source_operation_id
                 JOIN native_command_activations a ON a.chat_id=s.chat_id AND a.operation_id=s.source_operation_id
                 WHERE s.chat_id=$1 AND s.source_operation_id=$2 AND n.owner_id=$3 AND s.phase='restarting'
                   AND a.active AND NOT a.logical_cancelled AND a.native_turn_id=s.source_turn_id AND
                   a.runtime_generation=s.source_runtime_generation",
                &[&chat,&source,&owner],
            ).await? else {return Ok(false);};
            let checkpoint = &state["checkpoint"]["suspension"];
            if row["managed_autonomy_stopped"] == true
                || state["phase"] != "paused"
                || state["controlId"] != entry["pause_control_id"]
                || !suspension::same_source(&state, &row, &current)
                || retirement["retired"] != true
                || retirement["runtimeGeneration"] != entry["source_runtime_generation"]
                || retirement["threadId"] != entry["source_thread_id"]
                || retirement["turnId"] != entry["source_turn_id"]
                || retirement["checkpointId"] != checkpoint["checkpointId"]
            {
                return Ok(false);
            }
            let target_route = text(&entry["target_model_route_id"])?;
            let target_account = entry["target_provider_account_id"].as_str();
            let old_route = text(&entry["from_route"])?;
            let old_account = entry["from_account"].as_str();
            let settings = settings_persistence::get(Executor::Transaction(tx), &owner, &chat)
                .await?.context("The Council settings source was removed.")?;
            let binding = &settings["binding"];
            if !settings["pending"].as_array().is_some_and(Vec::is_empty)
                || (!binding.is_null() && (binding["threadId"] != entry["source_thread_id"]
                    || binding["runtimeGeneration"] != entry["source_runtime_generation"]
                    || binding["modelRouteId"] != entry["from_route"]
                    || binding["providerAccountId"] != entry["from_account"]))
            {
                return Ok(false);
            }
            let rows = tx.query(
                "UPDATE chat_runtime_sessions rt SET model_route_id=$1,provider_account_id=$2,updated_at=now()
                 FROM model_routes target, model_routes old
                 WHERE rt.chat_id=$3 AND rt.worker_id=$4 AND rt.scratch_root_id=$5 AND rt.codex_thread_id=$6
                   AND rt.model_route_id=$7 AND rt.provider_account_id IS NOT DISTINCT FROM $8::text AND target.id=$1
                   AND target.enabled AND old.id=$7
                   AND ($2::text IS NULL OR EXISTS (
                       SELECT 1 FROM model_provider_accounts account WHERE account.id=$2
                         AND account.provider_id=target.provider_id AND account.enabled
                   ))
                   AND old.provider_id=target.provider_id AND old.model_id=target.model_id
                 RETURNING rt.id",
                &[&target_route,&target_account,&chat,&text(&current["workerId"])?,
                &text(&current["scratchRootId"])? ,&text(&entry["source_thread_id"])? ,&old_route,&old_account],
            ).await?;
            if rows.is_empty() {
                return Ok(false);
            }
            anyhow::ensure!(rows.len()==1,"The Council turn has more than one runtime.");
            if !binding.is_null() {
                // The previous process is gone. A fresh observation establishes
                // the replacement binding; retained user settings stay in Core.
                settings_persistence::change(tx, &chat, |current| settings_state::retire_binding(current.clone())).await?;
            }
            state["target"]["modelRouteId"] = json!(target_route);
            state["target"]["providerAccountId"] = json!(target_account);
            suspension::save(tx,&owner,&chat,state,true).await?;
            tx.query("UPDATE council_live_provider_switches SET phase='resuming',updated_at=now() WHERE source_operation_id=$1",&[&source]).await?;
            Ok(true)
        })).await
    }

    pub(crate) async fn council_live_checkpoint_source(
        &self,
        owner: &str,
        chat: &str,
    ) -> Result<Option<Value>> {
        let rows = self.database.query(
            "SELECT jsonb_build_object('modelRouteId',n.identity->>'modelRouteId',
                 'providerAccountId',n.identity->>'providerAccountId')::text
             FROM council_live_provider_switches s JOIN native_commands n ON n.operation_id=s.source_operation_id
             JOIN chats c ON c.id=s.chat_id AND c.owner_id=n.owner_id AND c.owner_id=$1
             WHERE s.chat_id=$2 AND s.phase IN ('resuming','reconciling','cancelled') AND c.archived_at IS NULL
               AND c.native_suspension_state->'active'->>'threadId'=s.source_thread_id
               AND c.native_suspension_state->'active'->>'turnId'=s.source_turn_id
               AND c.native_suspension_state->'target'->>'modelRouteId'=s.target_model_route_id
               AND c.native_suspension_state->'target'->>'providerAccountId' IS NOT DISTINCT FROM s.target_provider_account_id
               AND c.native_suspension_state->'checkpoint' IS NOT NULL
             ORDER BY s.updated_at DESC LIMIT 1",
            &[&owner,&chat],
        ).await?;
        rows.first()
            .map(|row| {
                let raw = row
                    .get::<&str>(0)
                    .context("Council checkpoint source binding")?;
                Ok(serde_json::from_str(raw)?)
            })
            .transpose()
    }
}
