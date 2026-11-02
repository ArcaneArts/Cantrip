use super::*;
pub(super) async fn apply(
    tx: &Transaction<'_>,
    owner: &str,
    worker: &str,
    row: Value,
    side: &str,
    expected: &Value,
    value: Value,
) -> Result<Value> {
    if if side == "source" {
        !matches!(row["phase"].as_str(), Some("preparing" | "prepared"))
    } else {
        row["phase"] != "committed"
    } {
        return reject("handoff-phase-conflict");
    }
    let chat = text(&row["chat_id"])?;
    let state = settings_persistence::get(Executor::Transaction(tx), owner, &chat).await?;
    let Some(state) = state
        .filter(|s| truthy(s.get("binding")) && s["pending"].as_array().is_some_and(Vec::is_empty))
    else {
        return reject("handoff-settings-pending");
    };
    let current = &state["binding"];
    let prior = if let Some(binding) = row.get("binding").filter(|b| !b.is_null()) {
        binding.clone()
    } else if side == "source" {
        row["source"].clone()
    } else {
        let mut prior = row["source"].clone();
        prior["bindingId"] = current["bindingId"].clone();
        prior["runtimeGeneration"] = row["prepared"]["runtimeGeneration"].clone();
        prior["nativeEpoch"] =
            row["prepared"]["snapshot"]["context"]["settingsVersion"]["epoch"].clone();
        prior["modelRouteId"] = row["target_model_route_id"].clone();
        prior["providerAccountId"] = row["target_provider_account_id"].clone();
        prior
    };
    guards::assert_source(tx, owner, &prior).await?;
    guards::assert_idle(tx, &chat).await?;
    let (route, account) = if side == "source" {
        (
            &row["source"]["modelRouteId"],
            &row["source"]["providerAccountId"],
        )
    } else {
        (
            &row["target_model_route_id"],
            &row["target_provider_account_id"],
        )
    };
    let target = guards::target(tx, owner, route, account).await?;
    let context = &value["snapshot"]["context"];
    let selection = &value["snapshot"]["modelAttribution"]["selection"];
    let selected = if side == "source" && selection["status"] == "resolved" {
        guards::target(tx, owner, &selection["routeId"], account).await?
    } else {
        target.clone()
    };
    let selection_matches = if selection["status"] == "resolved" {
        selection["workerId"] == worker
            && selection.get("providerId") == target.get("providerId")
            && selected.get("providerId") == target.get("providerId")
            && selection.get("modelId") == selected.get("modelId")
            && selection.get("providerAccountId") == Some(account)
            && (side == "source" || selection.get("routeId") == Some(route))
    } else {
        side == "source"
    };
    if value.get("threadId") != row["source"].get("threadId")
        || context.get("threadId") != value.get("threadId")
        || context.get("chatId") != row.get("chat_id")
        || context["workerId"] != worker
        || context.get("runtimeGeneration") != value.get("runtimeGeneration")
        || !selection_matches
        || row["retired_runtime_generations"]
            .as_array()
            .context("Retired runtime identities")?
            .contains(&value["runtimeGeneration"])
        || retired_epoch(
            &row,
            &value["runtimeGeneration"],
            &context["settingsVersion"]["epoch"],
        )
        || (side == "source"
            && row["prepared"].get("runtimeGeneration") == value.get("runtimeGeneration"))
    {
        return reject("handoff-recovery-source-mismatch");
    }
    if current.get("runtimeGeneration") == value.get("runtimeGeneration")
        && current.get("nativeEpoch") == context["settingsVersion"].get("epoch")
    {
        return if truthy(state.get("effective"))
            && same_snapshot(&state["effective"], &value["snapshot"])
        {
            Ok(row)
        } else {
            reject("handoff-recovery-conflict")
        };
    }
    if current.get("bindingId") != Some(expected) {
        return reject("handoff-recovery-conflict");
    }
    let mut binding = current.clone();
    binding["bindingId"] = json!(uuid::Uuid::new_v4().to_string());
    binding["runtimeGeneration"] = value["runtimeGeneration"].clone();
    binding["nativeEpoch"] = context["settingsVersion"]["epoch"].clone();
    let next = settings_state::bind(&state, expected, &binding, &value["snapshot"])?;
    if let Some(reasoning) = value.get("reasoningEffort") {
        tx.query(
            "UPDATE chats SET reasoning_effort=$1,updated_at=$2 WHERE id=$3",
            &[&optional(reasoning)?, &crate::auth::now(), &chat],
        )
        .await?;
    }
    tx.query(
        "UPDATE native_settings_states SET state=$1::text::jsonb,updated_at=$2 WHERE chat_id=$3",
        &[&next.stringify(), &crate::auth::now(), &chat],
    )
    .await?;
    let retired = if current.get("runtimeGeneration") == value.get("runtimeGeneration") {
        row["retired_runtime_generations"].clone()
    } else {
        retire_runtime(&row, &current["runtimeGeneration"])
    };
    let mut patch = json!({"binding":binding,"retiredNativeEpochs":retire_epoch(&row,&current["runtimeGeneration"],&current["nativeEpoch"]),"retiredRuntimeGenerations":retired,"errorCode":Value::Null});
    if side == "destination" {
        patch["prepared"] = value;
    }
    update(tx, &row, patch).await
}
