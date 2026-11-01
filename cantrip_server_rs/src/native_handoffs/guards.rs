use super::*;
pub(super) async fn assert_source(tx: &Transaction<'_>, owner: &str, source: &Value) -> Result<()> {
    let current = context::execution(tx, owner, &text(&source["chatId"])?).await?;
    let valid = current.as_ref().is_some_and(|c| {
        c["experience"] == "agent"
            && c["contextKind"] == "project"
            && [
                ("workerId", "workerId"),
                ("contextKind", "contextKind"),
                ("projectId", "projectId"),
                ("worktreeId", "placementId"),
                ("threadId", "threadId"),
                ("modelRouteId", "modelRouteId"),
                ("providerAccountId", "providerAccountId"),
            ]
            .iter()
            .all(|(a, b)| c.get(a) == source.get(b))
    });
    if !valid {
        return reject("handoff-source-replaced");
    }
    let state =
        settings_persistence::get(Executor::Transaction(tx), owner, &text(&source["chatId"])?)
            .await?;
    if state
        .as_ref()
        .and_then(|s| s.get("binding"))
        .is_none_or(|b| b.is_null() || !deep_equal(b, source))
    {
        return reject("handoff-source-replaced");
    }
    Ok(())
}
pub(super) async fn assert_idle(tx: &Transaction<'_>, chat: &str) -> Result<()> {
    let lane = tx
        .query(
            "SELECT id FROM chat_execution_lanes WHERE chat_id=$1 AND state='active' LIMIT 1",
            &[&chat],
        )
        .await?;
    let command=tx.query("SELECT operation_id FROM native_commands WHERE chat_id=$1 AND status IN ('accepted','dispatched','uncertain') LIMIT 1",&[&chat]).await?;
    let claim=tx.query("SELECT id FROM managed_queue_claims WHERE chat_id=$1 AND status IN ('claimed','accepted','dispatched','uncertain') LIMIT 1",&[&chat]).await?;
    if !lane.is_empty() || !command.is_empty() || !claim.is_empty() {
        return reject("handoff-native-operation-pending");
    }
    Ok(())
}
pub(super) async fn target(
    tx: &Transaction<'_>,
    owner: &str,
    route: &Value,
    account: &Value,
) -> Result<Value> {
    let route = text(route)?;
    let found=one(Executor::Transaction(tx),"SELECT jsonb_build_object('modelId',r.model_id,'providerId',r.provider_id,'kind',p.kind)::text FROM model_routes r INNER JOIN model_profiles m ON m.id=r.model_id INNER JOIN model_providers p ON p.id=r.provider_id WHERE r.id=$1 AND m.owner_id=$2 AND p.owner_id=$2 AND r.enabled=true",&[&route,&owner]).await?;
    let Some(found) = found else {
        return reject("handoff-target-not-found");
    };
    if truthy(Some(account)) {
        let rows=tx.query("SELECT id FROM model_provider_accounts WHERE id=$1 AND provider_id=$2 AND enabled=true",&[&text(account)?,&text(&found["providerId"])?]).await?;
        if rows.is_empty() {
            return reject("handoff-target-account-mismatch");
        }
    } else if matches!(found["kind"].as_str(), Some("chatgpt" | "grok")) {
        return reject("handoff-target-account-required");
    }
    Ok(found)
}
