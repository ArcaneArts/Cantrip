use super::*;
pub(super) async fn apply(
    tx: &Transaction<'_>,
    owner: &str,
    worker: &str,
    row: Value,
    value: Value,
    runtime: &Value,
    epoch: &Value,
) -> Result<Value> {
    if row["cancel_requested"] == true {
        return reject("handoff-cancel-requested");
    }
    let prior = row.get("prepared").filter(|p| truthy(Some(p)));
    if let Some(prior) = prior {
        let same = prior.get("threadId") == value.get("threadId")
            && prior.get("runtimeGeneration") == value.get("runtimeGeneration")
            && same_snapshot(&prior["snapshot"], &value["snapshot"]);
        if same {
            if prior.get("reasoningEffort").is_some()
                && value.get("reasoningEffort").is_some()
                && prior.get("reasoningEffort") != value.get("reasoningEffort")
            {
                return reject("handoff-preparation-conflict");
            }
            if row["phase"] == "prepared"
                && prior.get("reasoningEffort").is_none()
                && let Some(reasoning) = value.get("reasoningEffort")
            {
                let mut prior = prior.clone();
                prior["reasoningEffort"] = reasoning.clone();
                return update(tx, &row, json!({"prepared":prior})).await;
            }
            return Ok(row);
        }
        if row["phase"] != "prepared"
            || prior.get("runtimeGeneration") != Some(runtime)
            || (!epoch.is_null()
                && prior["snapshot"]["context"]["settingsVersion"].get("epoch") != Some(epoch))
            || (prior.get("runtimeGeneration") == value.get("runtimeGeneration")
                && (epoch.is_null()
                    || value["snapshot"]["context"]["settingsVersion"].get("epoch") == Some(epoch)))
        {
            return reject("handoff-preparation-conflict");
        }
    } else if !runtime.is_null() || !epoch.is_null() {
        return reject("handoff-preparation-conflict");
    }
    if !matches!(row["phase"].as_str(), Some("preparing" | "prepared")) {
        return reject("handoff-phase-conflict");
    }
    let target = guards::target(
        tx,
        owner,
        &row["target_model_route_id"],
        &row["target_provider_account_id"],
    )
    .await?;
    let context = &value["snapshot"]["context"];
    let selection = &value["snapshot"]["modelAttribution"]["selection"];
    let binding = row
        .get("binding")
        .filter(|b| !b.is_null())
        .unwrap_or(&row["source"]);
    if value.get("threadId") != row["source"].get("threadId")
        || context.get("threadId") != value.get("threadId")
        || context.get("chatId") != row.get("chat_id")
        || context["workerId"] != worker
        || context.get("runtimeGeneration") != value.get("runtimeGeneration")
        || value.get("runtimeGeneration") == binding.get("runtimeGeneration")
        || row["retired_runtime_generations"]
            .as_array()
            .context("Retired runtime identities")?
            .contains(&value["runtimeGeneration"])
        || retired_epoch(
            &row,
            &value["runtimeGeneration"],
            &context["settingsVersion"]["epoch"],
        )
        || selection["status"] != "resolved"
        || selection["workerId"] != worker
        || selection.get("routeId") != row.get("target_model_route_id")
        || selection.get("providerId") != target.get("providerId")
        || selection.get("modelId") != target.get("modelId")
        || selection.get("providerAccountId") != row.get("target_provider_account_id")
    {
        return reject("handoff-prepared-source-mismatch");
    }
    guards::assert_source(tx, owner, binding).await?;
    guards::assert_idle(tx, &text(&row["chat_id"])?).await?;
    let epochs = prior.map_or_else(
        || row["retired_native_epochs"].clone(),
        |p| {
            retire_epoch(
                &row,
                &p["runtimeGeneration"],
                &p["snapshot"]["context"]["settingsVersion"]["epoch"],
            )
        },
    );
    let runtimes = prior
        .filter(|p| p.get("runtimeGeneration") != value.get("runtimeGeneration"))
        .map_or_else(
            || row["retired_runtime_generations"].clone(),
            |p| retire_runtime(&row, &p["runtimeGeneration"]),
        );
    update(tx,&row,json!({"phase":"prepared","prepared":value,"retiredNativeEpochs":epochs,"retiredRuntimeGenerations":runtimes,"errorCode":Value::Null})).await
}
