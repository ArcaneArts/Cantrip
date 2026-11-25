use crate::{
    database::{Database, Transaction},
    wire::Value,
};
use anyhow::Result;

pub(super) async fn pending(database: &Database) -> Result<Vec<Value>> {
    let rows = database.query(
        r#"SELECT jsonb_build_object(
             'ownerId',r.owner_id,'chatId',link.council_chat_id,'operationId',r.id,
             'attempts',r.council_forward_attempts,'requestKey',r.request_key,
             'source',jsonb_build_object('projectId',r.project_id,'chatId',r.chat_id,'requestId',r.id)
                 || CASE WHEN link.target_kind='task' THEN jsonb_build_object('targetKind','task') ELSE '{}'::jsonb END,
             'request',jsonb_build_object(
               'classification',jsonb_build_object('kind',r.kind),'protectedPayload',r.protected_payload
             )
           )::text
           FROM agent_interaction_requests r
           JOIN council_project_interactions link ON link.request_id=r.id
           WHERE r.status='pending' AND r.council_forwarded_at IS NULL AND r.protected_payload IS NOT NULL
             AND r.council_forward_due_at<=now() AND (r.expires_at IS NULL OR r.expires_at>now())
           ORDER BY r.council_forward_due_at,r.id LIMIT 32"#,
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
    id: &str,
) -> Result<bool> {
    let rows = tx
        .query(
            r#"SELECT r.id FROM agent_interaction_requests r
           JOIN council_project_interactions link ON link.request_id=r.id
           WHERE r.id=$1 AND r.owner_id=$2 AND link.council_chat_id=$3
             AND r.status='pending' AND r.council_forwarded_at IS NULL
             AND (r.expires_at IS NULL OR r.expires_at>now())
           FOR UPDATE OF r"#,
            &[&id, &owner, &chat],
        )
        .await?;
    Ok(!rows.is_empty())
}

pub(super) async fn acknowledge(tx: &Transaction<'_>, id: &str) -> Result<()> {
    tx.query(
        "UPDATE agent_interaction_requests SET council_forwarded_at=now() WHERE id=$1",
        &[&id],
    )
    .await?;
    Ok(())
}

pub(super) async fn defer(
    database: &Database,
    id: &str,
    at: &chrono::DateTime<chrono::Utc>,
) -> Result<()> {
    database.query(
        r#"UPDATE agent_interaction_requests SET council_forward_attempts=council_forward_attempts+1,
           council_forward_due_at=$2 WHERE id=$1 AND status='pending' AND council_forwarded_at IS NULL"#,
        &[&id,&at],
    ).await?;
    Ok(())
}
