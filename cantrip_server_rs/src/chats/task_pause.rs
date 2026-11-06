//! Task pause intent shares the canonical chat lock/revision, not a scheduler.
use super::{Repository, guard::lock_chat};
use crate::{
    database::{Executor, Transaction},
    wire::{Value, value::json},
};
use anyhow::Result;

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
    let cycles = tx.query("SELECT id FROM task_dispatch_cycles WHERE owner_id=$1 AND chat_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", &[&owner,&chat]).await?;
    let cycle = cycles.first().map(|row| row.get::<String>(0)).transpose()?;
    let value = json!({"paused":context["automationPaused"],"scope":json!({
        "revision":context["managedInputRevision"],"workerId":context["workerId"],
        "projectId":context["projectId"],"worktreeId":context["worktreeId"],
        "threadId":context["threadId"],"modelRouteId":context["modelRouteId"],
        "providerAccountId":context["providerAccountId"],"cycleId":cycle
    })});
    Ok(Some(crate::settings::parse_response(
        "taskPauseIntentSchema",
        Some(&value),
    )?))
}
impl Repository {
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
            let updated = tx.query("UPDATE chats SET automation_paused=$3,managed_input_revision=managed_input_revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 AND experience='task' AND ($4::integer IS NULL OR managed_input_revision=$4) RETURNING id", &[&owner,&chat,&paused,&expected]).await?;
            if updated.is_empty() { return Ok(None); }
            tx.query("INSERT INTO managed_queue_states(chat_id,revision) VALUES($1,1) ON CONFLICT(chat_id) DO UPDATE SET revision=managed_queue_states.revision+1,notification_due_at=now()", &[&chat]).await?;
            intent(tx, &owner, &chat).await
        })).await
    }
}
