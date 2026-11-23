//! Disposable local filesystem oracle, never shipped as a service entry point.
use anyhow::{Result, anyhow};
use cantrip_wire::{Value, parse_json_text, value::json};
use cantrip_worker::{
    filesystem::paths,
    replicas::placement::{Manager, PlacementError, probe_managed_link},
};
use std::{
    io::{self, BufRead},
    sync::Arc,
};
async fn operation(manager: &Manager, method: &str, input: &Value) -> Result<Value> {
    match method {
        "prepare" => manager.prepare(input).await,
        "claimStaging" => manager.claim_staging(input).await.map(|_| Value::Null),
        "cleanupStaging" => manager.cleanup_staging(input).await.map(|_| Value::Null),
        "writeCreatedMarker" => manager
            .write_created_marker(input)
            .await
            .map(|_| Value::Null),
        "classifyExisting" => manager.classify_existing(input).await,
        "record" => manager.record(input).await.map(|_| Value::Null),
        "materializeManagedLink" => manager.materialize_managed_link(input).await,
        "verifyPlacementOwnership" => manager
            .verify_placement_ownership(input)
            .await
            .map(|_| Value::Null),
        "releasePlacement" => manager.release_placement(input).await.map(|_| Value::Null),
        "isPlacementReleased" => manager
            .is_placement_released(input)
            .await
            .map(|value| json!(value)),
        "forgetPlacement" => manager
            .forget_placement(&input["projectId"], &input["canonicalPath"])
            .await
            .map(|_| Value::Null),
        "removeManagedLinkIfMatching" => manager.remove_managed_link_if_matching(input).await,
        _ => Err(anyhow!("Unknown placement fixture method")),
    }
}
fn outcome(result: Result<Value>) -> Value {
    match result {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => {
            let mut result = json!({"ok":false,"error":cantrip_worker::error::message(&error)});
            if let Some(error) = error.downcast_ref::<PlacementError>() {
                result["code"] = json!(error.code);
                result["retryable"] = json!(error.retryable);
            }
            result
        }
    }
}
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    let mut owner = None;
    for line in io::stdin().lock().lines() {
        let input = parse_json_text(&line?).map_err(|error| anyhow!("{}", error.lossy()))?;
        let directory = paths::native(input["directory"].as_js_string().unwrap());
        let worker = input["workerId"].as_js_string().unwrap();
        if owner.as_ref().is_none_or(
            |(path, id, _): &(std::path::PathBuf, cantrip_wire::JsString, Arc<Manager>)| {
                *path != directory || id != worker
            },
        ) {
            owner = Some((
                directory.clone(),
                worker.clone(),
                Arc::new(Manager::new(&directory, worker.clone())),
            ));
        }
        let manager = &owner.as_ref().unwrap().2;
        let result = if input["method"] == "probe" {
            outcome(Ok(json!(probe_managed_link(&directory).await)))
        } else if input["method"] == "batch" {
            let values =
                futures::future::join_all(input["operations"].as_array().unwrap().iter().map(
                    |item| async {
                        outcome(
                            operation(manager, item["method"].as_str().unwrap(), &item["input"])
                                .await,
                        )
                    },
                ))
                .await;
            json!({"ok":true,"value":values})
        } else {
            outcome(operation(manager, input["method"].as_str().unwrap(), &input["input"]).await)
        };
        println!(
            "{}",
            json!({"id":input["id"],"result":result})
                .stringify()
                .replace('\u{2028}', "\\u2028")
                .replace('\u{2029}', "\\u2029")
        );
    }
    Ok(())
}
