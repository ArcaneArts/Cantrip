use anyhow::{Context, Result};
use cantrip_server::{
    database::Database,
    task_dispatch::{self, Conflict, Eligibility, NotFound, Repository},
    wire::Value,
};
use futures::FutureExt;
use std::sync::{Arc, Mutex};
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let repository = Repository::new(database);
    let owner = input["owner"].as_str().context("Task scheduler owner")?;
    let trace = Arc::new(Mutex::new(Vec::new()));
    let request = Arc::new(input.clone());
    let resolve: Eligibility = Arc::new({
        let trace = trace.clone();
        move |value| {
            let (trace, request) = (trace.clone(), request.clone());
            async move {
                trace.lock().unwrap().push(value.clone());
                anyhow::ensure!(
                    request["failEligibility"] != true,
                    "Controlled Task eligibility failure"
                );
                let cycle = value.get("cycle").unwrap_or(&value);
                let chosen = request["resolutions"].as_array().and_then(|rs| {
                    rs.iter().find(|r| {
                        r.get("chat").is_none_or(|v| v == &cycle["chatId"])
                            && r.get("worker")
                                .is_none_or(|v| v == &value["taskWorker"]["id"])
                    })
                });
                Ok(chosen
                    .map(|r| r["result"].clone())
                    .unwrap_or_else(|| request["resolution"].clone()))
            }
            .boxed()
        }
    });
    let chat = string(input, "chat");
    let cycle = string(input, "cycle");
    let operation = string(input, "operation");
    let kind = string(input, "kind");
    let lease_owner = string(input, "leaseOwner");
    let options = &input["options"];
    let result: Result<Value> = async {
        Ok(
            match input["action"].as_str().context("Task scheduler action")? {
                "get" => repository.get(owner, &cycle).await?.unwrap_or(Value::Null),
                "list" => repository.list(owner).await?,
                "owners" => Value::Array(repository.list_scheduler_owners().await?),
                "plan" => task_dispatch::scheduler_plan(&input["schedulerOwner"]),
                "enqueue" => {
                    repository
                        .enqueue(owner, &chat, &operation, &kind, &input["rowVersion"])
                        .await?
                }
                "claim" => repository
                    .claim_next(owner, &lease_owner, resolve, options)
                    .await?
                    .unwrap_or(Value::Null),
                "resume" => repository
                    .resume_next_paused(owner, &lease_owner, resolve, options)
                    .await?
                    .unwrap_or(Value::Null),
                "recover" => {
                    repository
                        .recover_started_goal(owner, &input["expected"], &lease_owner, options)
                        .await?
                }
                "requeue" => repository.requeue_expired_leases(owner, options).await?,
                "expire" => repository.expire_started_leases(owner, options).await?,
                "defer" => {
                    repository
                        .defer_for_capacity(&input["fence"], options)
                        .await?
                }
                "running" => repository.mark_running(&input["fence"], options).await?,
                "heartbeat" => repository.heartbeat(&input["fence"], options).await?,
                "pause" => {
                    repository
                        .pause(&input["fence"], &input["affinity"], options, false)
                        .await?
                }
                "pause-unstarted" => {
                    repository
                        .pause(&input["fence"], &input["affinity"], options, true)
                        .await?
                }
                "settle" => {
                    repository
                        .settle(
                            &input["fence"],
                            input["state"].as_str().unwrap_or(""),
                            options,
                        )
                        .await?
                }
                _ => anyhow::bail!("Unknown Task scheduler fixture action"),
            },
        )
    }
    .await;
    let trace = Value::Array(trace.lock().unwrap().clone());
    match result {
        Ok(value) => Ok(Value::object([("value", value), ("trace", trace)])),
        Err(error) => {
            let (kind, code) = if let Some(error) = error.downcast_ref::<Conflict>() {
                ("conflict", Value::from_serialize(&error.code))
            } else if error.is::<NotFound>() {
                ("not-found", Value::Null)
            } else {
                return Err(error);
            };
            Ok(Value::object([
                (
                    "error",
                    Value::object([
                        ("kind", Value::from_serialize(&kind)),
                        ("code", code),
                        ("message", Value::from_serialize(&error.to_string())),
                    ]),
                ),
                ("trace", trace),
            ]))
        }
    }
}

fn string(input: &Value, key: &str) -> String {
    input[key]
        .as_js_string()
        .map(|s| s.lossy().into_owned())
        .unwrap_or_default()
}
