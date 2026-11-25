//! Core routes opaque results and owns queue admission. The assigned Council
//! worker opens its account's result and prepares the attributed input.
use crate::{
    chats::{Repository, recovery},
    database::Database,
    native_commands::{
        runtime::logical_delivery::{Backend, DurableDelivery, LogicalDelivery},
        transaction::TransactionRepository,
    },
    operations::logging::{LogCall, Logger},
    wire::{Value, value::json},
    workers::command_bus::LimitedCommandBus,
};
use anyhow::{Context, Result, ensure};
use futures::{FutureExt, future::BoxFuture};
use std::{sync::Arc, time::Duration};

struct Delivery {
    database: Arc<Database>,
    chats: Repository,
    commands: Arc<LimitedCommandBus>,
    recovery: Arc<recovery::Service>,
}

pub(crate) fn new(
    database: Arc<Database>,
    commands: Arc<LimitedCommandBus>,
    recovery: Arc<recovery::Service>,
    logger: Logger,
) -> Arc<LogicalDelivery> {
    DurableDelivery::with_backend(
        Arc::new(Delivery {
            chats: Repository::new(database.clone()),
            database,
            commands,
            recovery,
        }),
        Arc::new(move |_, entry| {
            logger(LogCall::event(
                "warn",
                "Council project result remains pending for delivery",
                json!({"event":"council.project-result.pending","chatId":entry.as_ref().map(|entry|entry["chatId"].clone()),"operationId":entry.map(|entry|entry["operationId"].clone())}),
            ));
        }),
        Arc::new(|| crate::auth::now().timestamp_millis()),
        Duration::from_secs(1),
    )
}

fn identity(value: &Value) -> Result<&str> {
    value.as_str().context("Council project result identity")
}

impl Delivery {
    async fn admit(&self, entry: Value) -> Result<()> {
        let owner = identity(&entry["ownerId"])?;
        let chat = identity(&entry["chatId"])?;
        let operation = identity(&entry["operationId"])?;
        let result_status = identity(&entry["source"]["status"])?.to_owned();
        let Some(context) = self.chats.execution_context(owner, chat).await? else {
            return Ok(());
        };
        ensure!(
            context.get("councilAgent").is_some(),
            "Council agent changed."
        );
        let worker = identity(&context["workerId"])?;
        let key = format!("council-project-result:{chat}:{operation}");
        let id = uuid::Uuid::new_v4().to_string();
        let prompt_id = uuid::Uuid::new_v4().to_string();
        let draft = json!({
            "type":"council.project-result.prepare","chatId":chat,"messageId":id,"promptId":prompt_id,
            "idempotencyKey":key,"configuration":context["modelConfiguration"],"source":entry["source"],
            "result":entry["result"],
        });
        let input = self
            .commands
            .request(worker, draft, Some(Duration::from_secs(10)), None)
            .await?;
        let input =
            crate::settings::parse_response("encryptedChatTurnCreateSchema", input.as_ref())?;
        ensure!(
            input["message"]["id"] == id
                && input["queuedPrompt"]["id"] == prompt_id
                && input["message"]["idempotencyKey"] == key
                && input["queuedPrompt"]["idempotencyKey"] == key,
            "Council worker returned another result input."
        );
        let prompt = input["queuedPrompt"].clone();
        let (scope_owner, scope_chat, scope_worker, scope_operation) = (
            owner.to_owned(),
            chat.to_owned(),
            worker.to_owned(),
            operation.to_owned(),
        );
        let inserted = self.database.transaction(move |tx| async move {
            let (owner, chat, worker, operation) = (&scope_owner, &scope_chat, &scope_worker, &scope_operation);
            if tx.query("SELECT id FROM chats WHERE owner_id=$1 AND id=$2 FOR UPDATE", &[owner, chat]).await?.is_empty() {
                return Ok(false);
            }
            if tx.query("SELECT operation_id FROM council_project_deliveries WHERE source_chat_id=$1 AND operation_id=$2::text::uuid AND result_status IS NOT NULL AND callback_delivered_at IS NULL FOR UPDATE", &[chat, operation]).await?.is_empty() {
                return Ok(false);
            }
            let repository = TransactionRepository::new(tx);
            let current = repository.execution_context(owner, chat).await?.context("Council agent is unavailable.")?;
            ensure!(current.get("councilAgent").is_some() && current["workerId"] == worker.as_str(), "Council placement changed before result delivery.");
            ensure!(current["modelConfiguration"]["modelId"] == prompt["modelId"], "Council model changed before result delivery.");
            let queued = repository.add_gui_prompt(owner, &current, &prompt, &json!({"operationId":key,"resumeAutonomy":false})).await?;
            ensure!(!queued["acceptedItem"].is_null(), "Council could not queue the project result.");
            tx.query("UPDATE council_project_deliveries SET result_status=$3,callback_delivered_at=now() WHERE source_chat_id=$1 AND operation_id=$2::text::uuid", &[chat, operation, &result_status]).await?;
            Ok(true)
        }.boxed()).await?;
        if inserted {
            drop(self.recovery.dispatch(owner, chat));
        }
        Ok(())
    }
}

impl Backend for Delivery {
    fn pending(&self) -> BoxFuture<'_, Result<Vec<Value>>> {
        async move {
            // Logical closure may precede the terminal history commit. Allow
            // that exact turn's row to arrive before reporting missing evidence.
            let rows = self.database.query(
                r#"SELECT jsonb_build_object(
                    'ownerId',source.owner_id,'chatId',d.source_chat_id,'operationId',d.operation_id,
                    'attempts',d.callback_attempts,'result',result.message,
                    'source',jsonb_build_object(
                      'projectId',target.project_id,'chatId',d.target_chat_id,'inputMessageId',d.input_message_id,
                      'threadId',d.result_thread_id,'turnId',d.result_turn_id,'status',COALESCE(terminal.status,d.result_status)
                    )
                  )::text
                  FROM council_project_deliveries d
                  JOIN council_agents source ON source.chat_id=d.source_chat_id
                  JOIN chats target ON target.id=d.target_chat_id AND target.owner_id=source.owner_id
                  LEFT JOIN native_commands n ON n.operation_id=d.result_operation_id AND n.chat_id=target.id
                  LEFT JOIN LATERAL (
                    SELECT t.status FROM native_history_turns t
                    JOIN native_history_bindings b ON b.id=t.binding_id
                    WHERE b.chat_id=target.id AND b.thread_id=d.result_thread_id AND t.turn_id=d.result_turn_id
                      AND t.status IN ('completed','failed','interrupted')
                    ORDER BY t.revision DESC LIMIT 1
                  ) terminal ON true
                  LEFT JOIN LATERAL (
                    SELECT jsonb_build_object('id',m.id,'protectedContent',m.protected_content,
                      'classification',jsonb_build_object('role',m.role,'mode',m.mode,'attachmentIds',m.attachment_ids)) AS message
                    FROM native_history_items h
                    JOIN chat_messages m ON m.id=h.message_id AND m.chat_id=h.chat_id
                    WHERE h.chat_id=d.target_chat_id AND h.thread_id=d.result_thread_id AND h.turn_id=d.result_turn_id
                      AND h.component='assistant' AND h.identity_kind='canonical' AND h.state='completed'
                      AND m.role='assistant' AND m.protected_content IS NOT NULL
                    ORDER BY h.item_ordinal DESC,h.component_ordinal DESC LIMIT 1
                  ) result ON COALESCE(terminal.status,d.result_status)='completed'
                  WHERE d.result_status IS NOT NULL AND d.callback_delivered_at IS NULL AND d.callback_due_at<=now()
                    AND (d.result_status<>'unavailable' OR terminal.status IS NOT NULL OR d.result_turn_id IS NULL
                      OR n.execution_completed_at IS NULL OR n.execution_completed_at<=now()-interval '10 seconds')
                  ORDER BY d.callback_due_at,d.operation_id LIMIT 64"#,
                &[],
            ).await?;
            rows.iter()
                .map(|row| Ok(serde_json::from_str(row.get::<&str>(0)?)?))
                .collect()
        }.boxed()
    }

    fn request(&self, entry: Value) -> BoxFuture<'_, Result<()>> {
        self.admit(entry).boxed()
    }

    fn acknowledge(&self, _entry: Value) -> BoxFuture<'_, Result<()>> {
        // Admission and acknowledgment commit in the same transaction.
        async { Ok(()) }.boxed()
    }

    fn defer(&self, entry: Value, at: i64) -> BoxFuture<'_, Result<()>> {
        async move {
            let at = chrono::DateTime::from_timestamp_millis(at).context("Council result retry date")?;
            self.database.query("UPDATE council_project_deliveries SET callback_attempts=callback_attempts+1,callback_due_at=$3 WHERE source_chat_id=$1 AND operation_id=$2::text::uuid AND callback_delivered_at IS NULL", &[&identity(&entry["chatId"])?, &identity(&entry["operationId"])?, &at]).await?;
            Ok(())
        }.boxed()
    }
}
