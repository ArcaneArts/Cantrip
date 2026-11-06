//! Task pause intent shares the canonical chat lock/revision, not a scheduler.
use super::{Repository, guard::lock_chat};
use crate::{
    database::{Executor, Transaction},
    wire::{Value, value::json},
};
use anyhow::Result;

fn saved_suspension(raw: Option<String>) -> Result<Option<Value>> {
    raw.map(|raw| {
        let state: Value = serde_json::from_str(&raw)?;
        crate::settings::parse_response("nativeSuspensionRecordSchema", Some(&state)).map_err(
            |_| {
                super::guard::NativeCommandError::new("suspension-state-unreadable", None, 409)
                    .into()
            },
        )
    })
    .transpose()
}

async fn intent(tx: &Transaction<'_>, owner: &str, chat: &str) -> Result<Option<Value>> {
    let Some(context) =
        Repository::execution_context_with(Executor::Transaction(tx), owner, chat).await?
    else {
        return Ok(None);
    };
    if context["experience"] != "task"
        || context["contextKind"] != "project"
        || context["managedInputRevision"].as_f64().unwrap_or(0.0) <= 0.0
    {
        return Ok(None);
    }
    let cycles = tx.query("SELECT id,goal_order_epoch FROM task_dispatch_cycles WHERE owner_id=$1 AND chat_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", &[&owner,&chat]).await?;
    let cycle = cycles.first().map(|row| row.get::<String>(0)).transpose()?;
    let source = super::native_task_suspension::source(tx, &context).await?;
    let bound = source
        .as_ref()
        .map(|source| &source.context)
        .unwrap_or(&context);
    let rows = tx
        .query(
            "SELECT native_suspension_state::text FROM chats WHERE owner_id=$1 AND id=$2",
            &[&owner, &chat],
        )
        .await?;
    let saved = saved_suspension(
        rows.first()
            .map(|row| row.get::<Option<String>>(0))
            .transpose()?
            .flatten(),
    )?;
    let resuming = saved.as_ref().is_some_and(|state| {
        !state["target"]["taskRound"].is_null() && state["phase"] == "resuming"
    });
    let mut value = json!({"paused":if resuming {json!(false)} else {context["automationPaused"].clone()},"scope":json!({
        "revision":context["managedInputRevision"],"workerId":context["workerId"],
        "projectId":context["projectId"],"worktreeId":context["worktreeId"],
        "threadId":bound["threadId"],"modelRouteId":bound["modelRouteId"],
        "providerAccountId":bound["providerAccountId"],"cycleId":cycle,
        "orderEpoch":cycles.first().map(|row|row.get::<i64>(1)).transpose()?.unwrap_or(0)
    })});
    if let Some(source) = source {
        value["scope"]["taskRound"] = source.task_round;
    }
    Ok(Some(crate::settings::parse_response(
        "taskPauseIntentSchema",
        Some(&value),
    )?))
}
impl Repository {
    pub async fn fence_task_interrupt(
        &self,
        owner: &str,
        chat: &str,
        revision: i32,
    ) -> Result<Option<Value>> {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",&[&owner]).await?;
            lock_chat(tx,&owner,&chat).await?;
            if intent(tx,&owner,&chat).await?.is_none_or(|v|v["paused"]!=true || v["scope"]["revision"]!=revision) {return Ok(None);}
            let cycles=tx.query("SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE owner_id=$1 AND chat_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",&[&owner,&chat]).await?;
            if let Some(row)=cycles.first() {
                let cycle:Value=serde_json::from_str(&row.get::<String>(0)?)?;
                crate::tasks::Repository::defer_round_input_for_interrupt(tx,&owner,&cycle).await?;
                if cycle["operation_kind"]=="finalize" {
                    crate::tasks::Repository::defer_goal_input_for_interrupt(tx,&owner,&cycle).await?;
                }
                // Pause dispatch authority even before receipt creation; retain
                // actual runtime affinity and never declare native settlement.
                tx.query("UPDATE task_dispatch_cycles SET state='paused',fencing_token=fencing_token+1,paused_at=now(),updated_at=now() WHERE id=$1 AND state IN ('claimed','running')",
                    &[&cycle["id"].as_str().ok_or_else(||anyhow::anyhow!("Task interrupt cycle"))?]).await?;
                let mut marker=cycle["goal_cycle_recovery"].clone();
                if !marker.is_null() && marker["settled"].is_null() {
                    marker["admission"]=Value::Null;
                    marker["settled"]=json!({"reason":"ineligible","turnId":marker["turnId"],"operationId":Value::Null});
                }
                tx.query("UPDATE task_dispatch_cycles SET goal_order_epoch=goal_order_epoch+1,goal_cycle_recovery=NULLIF($2::text::jsonb,'null'::jsonb) WHERE id=$1",
                    &[&cycle["id"].as_str().ok_or_else(||anyhow::anyhow!("Task interrupt cycle"))?,&marker.stringify()]).await?;
            }
            intent(tx,&owner,&chat).await
        })).await
    }
    pub async fn task_pause_intent(&self, owner: &str, chat: &str) -> Result<Option<Value>> {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    lock_chat(tx, &owner, &chat).await?;
                    intent(tx, &owner, &chat).await
                })
            })
            .await
    }

    pub async fn request_task_pause(
        &self,
        owner: &str,
        chat: &str,
        paused: bool,
        expected: Option<i32>,
    ) -> Result<Option<Value>> {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database.transaction(|tx| Box::pin(async move {
            lock_chat(tx, &owner, &chat).await?;
            let rows = tx.query("SELECT managed_input_revision,native_suspension_state::text FROM chats WHERE owner_id=$1 AND id=$2 AND experience='task'", &[&owner,&chat]).await?;
            let Some(current) = rows.first() else {return Ok(None);};
            if expected.is_some_and(|expected| current.get::<i32>(0).ok() != Some(expected)) {return Ok(None);}
            let saved = saved_suspension(current.get::<Option<String>>(1)?)?;
            let held = saved.as_ref().is_some_and(|state| !state["target"]["taskRound"].is_null() && !state["checkpoint"].is_null() &&
                matches!(state["phase"].as_str(),Some("paused"|"pausing"|"resuming"|"error")));
            if held && saved.as_ref().is_none_or(|state|state["action"] != "stop") && !(paused && saved.as_ref().is_some_and(|state|state["phase"] == "error" && state["action"] == "resume")) {
                crate::native_commands::task_suspension::request_locked(tx, &owner, &chat, if paused {"pause"} else {"resume"}, None).await?;
            }
            let hold = held || paused;
            let updated = tx.query("UPDATE chats SET automation_paused=$3,managed_input_revision=managed_input_revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 AND experience='task' AND ($4::integer IS NULL OR managed_input_revision=$4) RETURNING id", &[&owner,&chat,&hold,&expected]).await?;
            if updated.is_empty() { return Ok(None); }
            tx.query("INSERT INTO managed_queue_states(chat_id,revision) VALUES($1,1) ON CONFLICT(chat_id) DO UPDATE SET revision=managed_queue_states.revision+1,notification_due_at=now()", &[&chat]).await?;
            intent(tx, &owner, &chat).await
        })).await
    }
}
