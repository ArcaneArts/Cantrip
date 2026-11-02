use super::*;
pub(super) async fn apply(
    tx: &Transaction<'_>,
    owner: &str,
    worker: &str,
    row: Value,
) -> Result<Value> {
    if matches!(row["phase"].as_str(), Some("committed" | "completed")) {
        return Ok(row);
    }
    if row["cancel_requested"] == true {
        return reject("handoff-cancel-requested");
    }
    if row["phase"] != "prepared" || !truthy(row.get("prepared")) {
        return reject("handoff-not-prepared");
    }
    let previous = row
        .get("binding")
        .filter(|b| !b.is_null())
        .unwrap_or(&row["source"]);
    guards::assert_source(tx, owner, previous).await?;
    let chat = text(&row["chat_id"])?;
    guards::assert_idle(tx, &chat).await?;
    let target = guards::target(
        tx,
        owner,
        &row["target_model_route_id"],
        &row["target_provider_account_id"],
    )
    .await?;
    let state = settings_persistence::get(Executor::Transaction(tx), owner, &chat).await?;
    let Some(state) = state
        .filter(|s| truthy(s.get("binding")) && s["pending"].as_array().is_some_and(Vec::is_empty))
    else {
        return reject("handoff-settings-pending");
    };
    let prepared = &row["prepared"];
    let selection = &prepared["snapshot"]["modelAttribution"]["selection"];
    if selection["status"] != "resolved"
        || selection.get("providerId") != target.get("providerId")
        || selection.get("modelId") != target.get("modelId")
    {
        return reject("handoff-target-replaced");
    }
    let mut binding = row["source"].clone();
    binding["bindingId"] = json!(uuid::Uuid::new_v4().to_string());
    binding["modelRouteId"] = row["target_model_route_id"].clone();
    binding["providerAccountId"] = row["target_provider_account_id"].clone();
    binding["runtimeGeneration"] = prepared["runtimeGeneration"].clone();
    binding["nativeEpoch"] = prepared["snapshot"]["context"]["settingsVersion"]["epoch"].clone();
    let next = settings_state::bind(
        &state,
        &state["binding"]["bindingId"],
        &binding,
        &prepared["snapshot"],
    )?;
    let root = if row["source"]["contextKind"] == "project" {
        "worktree_id"
    } else {
        "scratch_root_id"
    };
    let sql = format!(
        "UPDATE chat_runtime_sessions SET model_route_id=$1,provider_account_id=$2,status='ready',updated_at=$3 WHERE chat_id=$4 AND worker_id=$5 AND codex_thread_id=$6 AND {root}=$7 RETURNING id"
    );
    let updated = tx
        .query(
            &sql,
            &[
                &text(&row["target_model_route_id"])?,
                &optional(&row["target_provider_account_id"])?,
                &crate::auth::now(),
                &chat,
                &worker,
                &text(&row["source"]["threadId"])?,
                &text(&row["source"]["placementId"])?,
            ],
        )
        .await?;
    if updated.len() != 1 {
        return reject("handoff-runtime-replaced");
    }
    if let Some(reasoning) = prepared.get("reasoningEffort") {
        tx.query(
            "UPDATE chats SET model_id=$1,reasoning_effort=$2,updated_at=$3 WHERE id=$4",
            &[
                &text(&target["modelId"])?,
                &optional(reasoning)?,
                &crate::auth::now(),
                &chat,
            ],
        )
        .await?;
    } else {
        tx.query(
            "UPDATE chats SET model_id=$1,updated_at=$2 WHERE id=$3",
            &[&text(&target["modelId"])?, &crate::auth::now(), &chat],
        )
        .await?;
    }
    tx.query(
        "UPDATE native_settings_states SET state=$1::text::jsonb,updated_at=$2 WHERE chat_id=$3",
        &[&next.stringify(), &crate::auth::now(), &chat],
    )
    .await?;
    update(tx,&row,json!({"phase":"committed","binding":binding,"retiredRuntimeGenerations":retire_runtime(&row,&previous["runtimeGeneration"]),"errorCode":Value::Null})).await
}
pub(super) async fn finish(tx: &Transaction<'_>, row: Value, outcome: &str) -> Result<Value> {
    if row["phase"] == outcome {
        return Ok(row);
    }
    if if outcome == "completed" {
        row["phase"] != "committed"
    } else {
        !matches!(row["phase"].as_str(), Some("preparing" | "prepared"))
    } {
        return reject("handoff-phase-conflict");
    }
    let retired = if outcome == "cancelled" && truthy(row.get("prepared")) {
        retire_runtime(&row, &row["prepared"]["runtimeGeneration"])
    } else {
        row["retired_runtime_generations"].clone()
    };
    let result = update(
        tx,
        &row,
        json!({"phase":outcome,"errorCode":Value::Null,"retiredRuntimeGenerations":retired}),
    )
    .await?;
    let chat = text(&row["chat_id"])?;
    tx.query(
        "INSERT INTO managed_queue_states(chat_id) VALUES($1) ON CONFLICT DO NOTHING",
        &[&chat],
    )
    .await?;
    crate::native_commands::queue_state_changed(tx, &chat).await?;
    Ok(result)
}
