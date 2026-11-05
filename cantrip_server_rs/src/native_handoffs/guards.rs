use super::*;
pub(super) async fn assert_source(tx: &Transaction<'_>, owner: &str, source: &Value) -> Result<()> {
    let current = context::execution(tx, owner, &text(&source["chatId"])?).await?;
    let valid = current.as_ref().is_some_and(|c| {
        c["experience"] == "agent"
            && (if c["contextKind"] == "project" {
                c.get("worktreeId")
            } else {
                c.get("scratchRootId")
            }) == source.get("placementId")
            && [
                ("workerId", "workerId"),
                ("contextKind", "contextKind"),
                ("projectId", "projectId"),
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
pub(super) async fn assert_idle(tx: &Transaction<'_>, chat: &str, queued: &Value) -> Result<()> {
    let lane = tx
        .query(
            "SELECT id FROM chat_execution_lanes WHERE chat_id=$1 AND state='active' LIMIT 1",
            &[&chat],
        )
        .await?;
    let command=tx.query("SELECT operation_id FROM native_commands WHERE chat_id=$1 AND status IN ('accepted','dispatched','uncertain') AND NOT (execution_completed_at IS NOT NULL AND goal_recovery_source IS NOT NULL) LIMIT 1",&[&chat]).await?;
    let claims=tx.query("SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE chat_id=$1 AND status IN ('claimed','accepted','dispatched','uncertain') LIMIT 2",&[&chat]).await?;
    if !lane.is_empty() || !command.is_empty() || claims.len() > 1 {
        return reject("handoff-native-operation-pending");
    }
    if let Some(row) = claims.first() {
        let claim: Value = serde_json::from_str(&row.get::<String>(0)?)?;
        let Some(expected) = queued
            .get("goalClaim")
            .filter(|_| truthy(queued.get("autonomousAttempt")))
        else {
            return reject("handoff-native-operation-pending");
        };
        if !goal_claim::retained(&claim, expected) {
            return reject("handoff-native-operation-pending");
        }
        goal_claim::assert_prompt(tx, chat, expected).await?;
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
