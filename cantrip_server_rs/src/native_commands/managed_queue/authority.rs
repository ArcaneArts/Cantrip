use super::*;
pub(super) async fn lock(tx: &Transaction<'_>, owner: &str, chat: &str) -> Result<Value> {
    tx.query("WITH locked_project AS MATERIALIZED (SELECT projects.id FROM projects INNER JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM locked_project INNER JOIN chats ON chats.project_id=locked_project.id WHERE chats.id=$2 FOR UPDATE OF chats",&[&owner,&chat]).await?;
    let row = raw_one(
        tx,
        "SELECT to_jsonb(c)::text FROM chats c WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        &[&chat, &owner],
    )
    .await?;
    let Some(row) = row.filter(|c| c["experience"] == "agent" && c["context_kind"] == "project")
    else {
        return reject("managed-session-ineligible");
    };
    tx.query(
        "INSERT INTO managed_queue_states(chat_id) VALUES($1) ON CONFLICT DO NOTHING",
        &[&chat],
    )
    .await?;
    Ok(row)
}
pub(super) async fn authorize(
    tx: &Transaction<'_>,
    owner: &str,
    worker: &Value,
    session: &Value,
) -> Result<Value> {
    let chat = text(&session["chatId"])?;
    lock(tx, owner, &chat).await?;
    let context = TransactionRepository::new(tx)
        .execution_context(owner, &chat)
        .await?;
    let Some(context) =
        context.filter(|c| crate::chats::managed_console::session_context(c).is_some())
    else {
        return reject("stale-queue-session");
    };
    if context.get("workerId") != Some(worker) {
        return reject("stale-queue-session");
    }
    for (field, input) in [
        ("projectId", "projectId"),
        ("contextKind", "contextKind"),
        ("worktreeId", "placementId"),
        ("threadId", "threadId"),
        ("modelRouteId", "modelRouteId"),
        ("providerAccountId", "providerAccountId"),
    ] {
        if context.get(field) != session.get(input) {
            return reject("stale-queue-session");
        }
    }
    Ok(context)
}
