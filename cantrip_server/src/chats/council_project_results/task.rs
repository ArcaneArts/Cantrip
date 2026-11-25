use crate::{
    database::{Database, Transaction},
    wire::Value,
};
use anyhow::Result;

pub(super) async fn pending(database: &Database) -> Result<Vec<Value>> {
    let rows = database.query(
        r#"SELECT jsonb_build_object(
             'ownerId',owner_id,'chatId',source_chat_id,'operationId',operation_id,
             'attempts',callback_attempts,'result',result,'cycleId',cycle_id,
             'source',jsonb_build_object(
               'projectId',project_id,'chatId',target_chat_id,'targetKind','task',
               'inputMessageId',input_message_id,'threadId',thread_id,'turnId',turn_id,'status',status
             )
           )::text FROM council_project_task_results
           WHERE callback_due_at<=now() ORDER BY callback_due_at,operation_id LIMIT 32"#,
        &[],
    ).await?;
    rows.iter()
        .map(|row| Ok(serde_json::from_str(row.get::<&str>(0)?)?))
        .collect()
}

pub(super) async fn lock_pending(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    operation: &str,
    cycle: &str,
    status: &str,
) -> Result<bool> {
    let rows = tx.query(
        r#"SELECT c.operation_id FROM council_project_creations c
           JOIN council_project_task_results r USING (source_chat_id,operation_id)
           WHERE r.owner_id=$1 AND c.source_chat_id=$2 AND c.operation_id=$3::text::uuid
             AND r.cycle_id=$4 AND r.status=$5 AND c.callback_delivered_at IS NULL FOR UPDATE OF c"#,
        &[&owner,&chat,&operation,&cycle,&status],
    ).await?;
    Ok(!rows.is_empty())
}

pub(super) async fn acknowledge(tx: &Transaction<'_>, chat: &str, operation: &str) -> Result<()> {
    tx.query(
        "UPDATE council_project_creations SET callback_delivered_at=now() WHERE source_chat_id=$1 AND operation_id=$2::text::uuid",
        &[&chat,&operation],
    ).await?;
    Ok(())
}

pub(super) async fn defer(
    database: &Database,
    chat: &str,
    operation: &str,
    at: &chrono::DateTime<chrono::Utc>,
) -> Result<()> {
    database.query(
        r#"UPDATE council_project_creations SET callback_attempts=callback_attempts+1,callback_due_at=$3
           WHERE source_chat_id=$1 AND operation_id=$2::text::uuid AND callback_delivered_at IS NULL"#,
        &[&chat,&operation,&at],
    ).await?;
    Ok(())
}
