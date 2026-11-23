//! The same carrier journal read by the Node worker and host tools.
use super::super::{
    carrier::DeliveryUnknown,
    docker::{DockerApiError, LocalDocker, segment},
    operations::{now, save},
    text,
};
use crate::filesystem::Scope;
use anyhow::{Result, anyhow, ensure};
use cantrip_wire::{Value, parse_json_text, value::json};
use hyper::Method;
use std::{fs, io, path::Path, time::Duration};

fn desired(record: &Value, observation: &Value) -> bool {
    if record["before"].is_null() {
        return false;
    }
    if record["request"]["action"] == "stop" {
        return observation["running"] == false;
    }
    observation["running"] == true
        && (record["request"]["action"] != "restart"
            || observation["startedAt"] != record["before"]["startedAt"])
}

fn load(file: &Path, request: &Value) -> Result<Option<Value>> {
    let bytes = match fs::read_to_string(file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let record =
        parse_json_text(&bytes).map_err(|_| anyhow!("Invalid retained Docker journal."))?;
    ensure!(
        record["version"] == 1 && &record["request"] == request,
        "This lifecycle operation already belongs to another target or action."
    );
    ensure!(
        matches!(
            record["state"].as_str(),
            Some("running" | "ready" | "failed" | "unknown")
        ) && matches!(
            record["phase"].as_str(),
            Some("reserved" | "mutation-requested" | "mutation-acknowledged" | "verified")
        ) && (record["state"] != "ready"
            || (record["phase"] == "verified"
                && record["after"]["containerId"] == request["expectedContainerId"]
                && matches!(
                    record["completionEvidence"].as_str(),
                    Some("acknowledged-and-observed" | "observed-state")
                )
                && desired(&record, &record["after"]))),
        "The saved lifecycle record has no matching transition evidence."
    );
    Ok(Some(record))
}

pub(super) async fn inspect(
    engine: &LocalDocker,
    reference: &str,
    expected: &str,
    lifetime: &Scope,
) -> Result<Value> {
    let actual = engine.record(reference, lifetime).await?;
    ensure!(
        actual["Id"] == expected,
        "The retained Docker container changed; no replacement was selected."
    );
    let state = &actual["State"];
    ensure!(
        matches!(state["Running"], Value::Bool(_)),
        "Docker returned no actual container running state."
    );
    Ok(json!({"containerId":actual["Id"],"name":actual["Name"],
        "running":state["Running"],"status":state["Status"],
        "startedAt":state["StartedAt"],"finishedAt":state["FinishedAt"]}))
}

fn persist(file: &Path, record: &mut Value) -> Result<()> {
    record["updatedAt"] = json!(now());
    save(file, record, false)
}

async fn observe(
    engine: &LocalDocker,
    file: &Path,
    request: &Value,
    mut record: Value,
    lifetime: &Scope,
) -> Result<Value> {
    if matches!(record["state"].as_str(), Some("ready" | "failed")) {
        return Ok(record);
    }
    let expected = text(request, "expectedContainerId")?;
    match inspect(engine, expected, expected, lifetime).await {
        Ok(current) if record["phase"] != "reserved" && desired(&record, &current) => {
            record["state"] = json!("ready");
            record["phase"] = json!("verified");
            record["after"] = current;
            record["completionEvidence"] = json!("observed-state");
            record["error"] = Value::Null;
        }
        current => {
            let message = match current {
                Err(error) => error.to_string(),
                Ok(_) if record["phase"] == "reserved" =>
                    "No Docker mutation was dispatched by this admission. A repeated request only observes it.".to_owned(),
                Ok(_) => "The admitted Docker transition is not verified. No mutation was replayed.".to_owned(),
            };
            record["state"] = json!("unknown");
            record["error"] = json!(message);
        }
    }
    persist(file, &mut record)?;
    Ok(record)
}

pub(super) async fn recover(
    engine: &LocalDocker,
    file: &Path,
    request: &Value,
    lifetime: &Scope,
) -> Result<Option<Value>> {
    match load(file, request)? {
        Some(record) => observe(engine, file, request, record, lifetime)
            .await
            .map(Some),
        None => Ok(None),
    }
}

pub(super) async fn change(
    engine: &LocalDocker,
    file: &Path,
    request: &Value,
    lifetime: &Scope,
) -> Result<Value> {
    if let Some(record) = load(file, request)? {
        return observe(engine, file, request, record, lifetime).await;
    }
    let time = now();
    let mut record = json!({"version":1,"request":request,"state":"running","phase":"reserved",
        "startedAt":time,"updatedAt":time,"before":Value::Null,"after":Value::Null,
        "completionEvidence":Value::Null,"error":Value::Null});
    save(file, &record, true)?;

    let expected = text(request, "expectedContainerId")?;
    let action = text(request, "action")?;
    let result: Result<()> = async {
        record["before"] = inspect(engine, text(request, "container")?, expected, lifetime).await?;
        record["phase"] = json!("mutation-requested");
        persist(file, &mut record)?;
        let wait = if action == "start" { "" } else { "?t=20" };
        engine
            .request(
                Method::POST,
                &format!("/containers/{}/{action}{wait}", segment(expected)),
                None,
                Duration::from_secs(90),
                lifetime,
            )
            .await?;
        record["phase"] = json!("mutation-acknowledged");
        persist(file, &mut record)?;
        record["after"] = inspect(engine, expected, expected, lifetime).await?;
        if !desired(&record, &record["after"]) {
            return Err(DeliveryUnknown(
                "Docker acknowledged the request but its intended state is not verified.".into(),
            )
            .into());
        }
        record["state"] = json!("ready");
        record["phase"] = json!("verified");
        record["completionEvidence"] = json!("acknowledged-and-observed");
        Ok(())
    }
    .await;
    if let Err(error) = result {
        record["state"] = json!(
            if record["phase"] == "reserved" || error.is::<DockerApiError>() {
                "failed"
            } else {
                "unknown"
            }
        );
        record["error"] = json!(error.to_string());
    }
    persist(file, &mut record).map_err(|_| {
        DeliveryUnknown(
            "The lifecycle outcome could not be recorded. Observe this operation before retrying."
                .into(),
        )
    })?;
    Ok(record)
}
