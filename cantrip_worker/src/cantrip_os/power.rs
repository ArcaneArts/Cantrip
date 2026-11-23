//! Observe and change Core's admitted retained Docker target.
mod retained;

use super::{
    carrier::DeliveryUnknown, checked, docker::LocalDocker, lock::InstanceLock,
    operations::Operations, text,
};
use crate::filesystem::Scope;
use anyhow::{Result, bail, ensure};
use cantrip_wire::{Value, value::json};
use std::path::{Path, PathBuf};
use tokio::sync::OnceCell;

pub(super) const STATUS: &str = "cantrip-os.power.status";
pub(super) const OPERATION: &str = "cantrip-os.power.operation";

async fn engine<'a>(slot: &'a OnceCell<LocalDocker>, lifetime: &Scope) -> Result<&'a LocalDocker> {
    slot.get_or_try_init(|| LocalDocker::current(lifetime))
        .await
}

fn journal_path(operation: &Path) -> PathBuf {
    operation.with_extension("json.docker")
}

fn observation(value: &Value) -> Result<Value> {
    checked(
        "cantripOsPowerObservationSchema",
        json!({"containerId":value["containerId"],"running":value["running"],
            "status":value["status"],"startedAt":value["startedAt"],"finishedAt":value["finishedAt"]}),
    )
}

fn receipt(command: &Value, carrier: &Value) -> Result<Value> {
    ensure!(
        carrier["state"] == "ready",
        "The retained transition has no verified receipt."
    );
    checked(
        "cantripOsPowerReceiptSchema",
        json!({"targetGeneration":command["powerTarget"]["generation"],
            "containerId":command["powerTarget"]["containerId"],
            "before":observation(&carrier["before"])?,"after":observation(&carrier["after"])?,
            "completionEvidence":carrier["completionEvidence"]}),
    )
}

pub(super) async fn execute(
    operations: &Operations,
    command: &Value,
    lifetime: &Scope,
) -> Result<Value> {
    let command = checked("cantripOsPowerWorkerCommandSchema", command.clone())?;
    let container = text(&command["transport"], "container")?;
    let expected = text(&command["powerTarget"], "containerId")?;
    let slot = OnceCell::new();
    let current = async || {
        observation(
            &retained::inspect(
                engine(&slot, lifetime).await?,
                container,
                expected,
                lifetime,
            )
            .await?,
        )
    };
    if command["type"] == STATUS {
        return current().await;
    }

    let scope = &command["scope"];
    let id = text(&command, "operationId")?;
    let action = text(&command, "action")?;
    let admission = json!({"action":action,"transport":command["transport"],"powerTarget":command["powerTarget"]});
    let request = json!({"operationId":id,"action":action,"container":container,"expectedContainerId":expected});
    let _lock = InstanceLock::acquire(container, lifetime).await?;
    let record = if command["mode"] == "execute" {
        operations
            .execute_record(
                scope,
                id,
                OPERATION,
                admission.clone(),
                Some(json!({"version":1,"admission":admission})),
                async |journal| {
                    let file = journal_path(journal.path());
                    journal.set_checkpoint(json!({"version":1,"admission":admission,"journalPath":file.to_string_lossy()}))?;
                    let carrier =
                        retained::change(engine(&slot, lifetime).await?, &file, &request, lifetime)
                            .await?;
                    if carrier["state"] == "ready" {
                        return receipt(&command, &carrier);
                    }
                    let message = carrier["error"]
                        .as_str()
                        .unwrap_or("The retained transition is not verified.");
                    if carrier["state"] == "failed" {
                        bail!("{message}");
                    }
                    Err(DeliveryUnknown(message.into()).into())
                },
            )
            .await?
    } else {
        let Some(saved) = operations.inspect_record(scope, id)? else {
            return Ok(Value::Null);
        };
        let checkpoint = &saved["checkpoint"];
        ensure!(
            saved["command"] == OPERATION
                && checkpoint["version"] == 1
                && checkpoint["admission"] == admission,
            "The saved power operation belongs to another admission."
        );
        ensure!(
            &saved["scope"] == scope,
            "The saved power admission scope changed."
        );
        if saved["state"] == "unknown" {
            let observed = async {
                if !checkpoint["journalPath"].is_string() {
                    bail!("No retained carrier admission is available. No operation was replayed.");
                }
                let file = journal_path(&operations.file(scope, id)?);
                retained::recover(engine(&slot, lifetime).await?, &file, &request, lifetime)
                    .await?
                    .ok_or_else(|| anyhow::anyhow!("The retained carrier journal is unavailable. No operation was replayed."))
            }.await;
            let (state, receipt, error) = match observed {
                Ok(carrier) => match carrier["state"].as_str() {
                    Some("ready") => ("ready", receipt(&command, &carrier)?, Value::Null),
                    Some("failed") => ("failed", Value::Null, carrier["error"].clone()),
                    _ => ("unknown", Value::Null, carrier["error"].clone()),
                },
                Err(error) => ("unknown", Value::Null, json!(error.to_string())),
            };
            operations.record_observation(&saved, state, receipt, error)?
        } else {
            saved
        }
    };
    let (state, result_error) = match record["state"].as_str() {
        Some("ready") => ("ready", Value::Null),
        Some("unknown") if !record["error"].is_null() => (
            "unknown",
            json!("Power delivery is unknown; observe the original admission before continuing."),
        ),
        Some("failed") if !record["error"].is_null() => (
            "failed",
            json!("The power operation failed. Inspect Worker diagnostics."),
        ),
        Some(state) => (state, Value::Null),
        None => bail!("The saved power operation has no state."),
    };
    let (latest, observation_error) = match current().await {
        Ok(observed) => (observed, Value::Null),
        Err(_) => (
            Value::Null,
            json!("The retained Docker target could not be observed."),
        ),
    };
    checked(
        "cantripOsPowerOperationResultSchema",
        json!({"operationId":id,"action":action,"state":state,
            "startedAt":record["startedAt"],"updatedAt":record["updatedAt"],
            "error":result_error,"receipt":if state=="ready"{record["receipt"].clone()}else{Value::Null},
            "observation":latest,"observationError":observation_error}),
    )
}
