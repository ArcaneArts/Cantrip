//! Core's immutable system operation admission and protected client outcome.
use super::{
    Manager, account, checked,
    checkpoints::{Checkpoint, Mode},
    key, load_record, same_placement, target,
};
use crate::{
    cantrip_os::{
        docker::LocalDocker,
        lock::InstanceLock,
        operations::{digest, now, save, scope_key},
        text,
    },
    encryption::Service,
    filesystem::Scope,
};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_crypto::content::seal_system_operation_result;
use cantrip_wire::{JsString, Value, value::json};
use std::path::Path;

const COMMAND: &str = "cantripOsSystemOperationCommandSchema";
const UNKNOWN: &str =
    "System delivery is unknown. Observe the original operation; no claimed effect was repeated.";
const FAILED: &str =
    "The system operation failed. Inspect its private outcome and retained recovery state.";

fn save_job(file: &Path, record: &mut Value, exclusive: bool) -> Result<()> {
    record["updatedAt"] = json!(now());
    save(file, record, exclusive)
}

fn load_job(file: &Path, command: &Value) -> Result<Option<Value>> {
    let Some(record) = load_record(file)? else {
        return Ok(None);
    };
    ensure!(
        record["version"].as_i64() == Some(1)
            && checked(COMMAND, record["command"].clone())? == *command
            && matches!(
                record["state"].as_str(),
                Some("running" | "ready" | "failed" | "unknown")
            )
            && ["validated", "captureRequested", "hostRequested"]
                .into_iter()
                .all(|field| record[field].is_boolean()),
        "The system operation ID belongs to a different immutable admission"
    );
    Ok(Some(record))
}

fn operation_context(command: &Value) -> Value {
    let mut context = command["scope"].clone();
    context["targetGeneration"] = command["target"]["generation"].clone();
    context["operationId"] = command["operationId"].clone();
    context["containerId"] = command["target"]["containerId"].clone();
    context
}

fn admission(command: &Value) -> Value {
    let scope = &command["scope"];
    // Keep this ordering identical to the JS schema: the carrier request
    // includes the JSON digest of the original, validated capture context.
    let context = json!({"ownerId":scope["ownerId"],"serverId":scope["serverId"],
        "workerId":scope["workerId"],"instanceId":scope["instanceId"],"guestInstanceId":scope["guestInstanceId"],
        "attachmentGeneration":scope["attachmentGeneration"],"targetGeneration":command["target"]["generation"],
        "operationId":command["operationId"],"checkpointId":command["checkpointId"],
        "containerId":command["target"]["containerId"]});
    json!({"context":context,"container":command["target"]["containerName"],"resumeOriginal":command["resumeOriginal"]})
}

fn output(record: &Value) -> Result<Value> {
    let command = &record["command"];
    let error = match record["state"].as_str() {
        Some("unknown") => json!(UNKNOWN),
        Some("failed") => json!(FAILED),
        _ => Value::Null,
    };
    checked(
        "cantripOsSystemOperationResultSchema",
        json!({"operationId":command["operationId"],
        "targetGeneration":command["target"]["generation"],"action":command["action"],"state":record["state"],
        "phase":record["phase"],"startedAt":record["startedAt"],"updatedAt":record["updatedAt"],
        "protectedResult":record["protectedResult"],"root":record["root"],"error":error}),
    )
}

fn terminal(record: &Value) -> bool {
    matches!(record["state"].as_str(), Some("ready" | "failed"))
        && !record["protectedResult"].is_null()
}

fn protect(record: &mut Value, checkpoint: &Checkpoint<'_>, encryption: &Service) -> Result<()> {
    let command = &record["command"];
    let scope = &command["scope"];
    let capture = checkpoint.details(&record["capture"])?;
    let diagnostic = record["diagnostic"]
        .as_js_string()
        .map(|value| JsString::new(value.units()[..value.len().min(32_768)].to_vec()));
    let clear = json!({"version":1,"command":command,"capture":capture,"replacement":record["host"],"diagnostic":diagnostic});
    let material = key(scope, encryption, None)?;
    let protected = seal_system_operation_result(
        &operation_context(command),
        material.key_revision,
        &material.key,
        &clear,
    )?;
    account(scope, encryption)?;
    record["protectedResult"] = protected;
    Ok(())
}

async fn validate(command: &Value, lifetime: &Scope) -> Result<()> {
    let original = &command["target"];
    let scope = &command["scope"];
    ensure!(
        same_placement(&original["expected"], scope),
        "The system target belongs to another owner, Worker or guest"
    );
    let engine = LocalDocker::current(lifetime).await?;
    let actual = engine
        .record(text(&command["transport"], "container")?, lifetime)
        .await?;
    let observed = target(&engine, &actual, scope, original, false, lifetime).await?;
    ensure!(
        observed["generation"] == original["generation"],
        "The selected Docker target changed; no replacement was substituted"
    );
    Ok(())
}

struct Job<'a> {
    file: &'a Path,
    checkpoint: &'a Checkpoint<'a>,
    encryption: &'a Service,
    lifetime: &'a Scope,
}

impl Job<'_> {
    async fn advance(&self, record: &mut Value, fresh: bool, mode: &str) -> Result<()> {
        let command = record["command"].clone();
        if record["validated"] != true {
            if let Err(error) = validate(&command, self.lifetime).await {
                self.lifetime.check()?;
                record["state"] = json!("failed");
                record["phase"] = json!("validation-failed");
                record["diagnostic"] = json!(error.to_string());
                return Ok(());
            }
            account(&command["scope"], self.encryption)?;
            record["validated"] = json!(true);
            save_job(self.file, record, false)?;
        }
        let mut child = self.checkpoint.run(Mode::Observe).await?;
        account(&command["scope"], self.encryption)?;
        if (fresh || mode == "continue") && record["captureRequested"] != true {
            self.checkpoint.run(Mode::Prepare).await?;
            record["captureRequested"] = json!(true);
            save_job(self.file, record, false)?;
            child = self.checkpoint.run(Mode::Continue).await?;
        } else if mode == "continue" && child.is_some() {
            child = self.checkpoint.run(Mode::Continue).await?;
        }
        if let Some(child) = child {
            record["state"] = child["state"].clone();
            record["phase"] = child["phase"].clone();
            record["capture"] = child;
            record["protectedResult"] = Value::Null;
        } else {
            record["state"] = json!("unknown");
            record["diagnostic"] =
                json!("No original private capture receipt was found; capture was not repeated");
        }
        account(&command["scope"], self.encryption)?;
        save_job(self.file, record, false)
    }

    async fn complete(&self, record: &mut Value, fresh: bool, mode: &str) -> Result<Value> {
        let prepared = record["phase"] == "prepared" && record["captureRequested"] != true;
        if mode == "prepare" || (mode == "observe" && prepared) {
            if record["captureRequested"] == true
                || (prepared && !record["protectedResult"].is_null())
            {
                return output(record);
            }
            record["state"] = json!("running");
            record["phase"] = json!("prepared");
        } else {
            if fresh || mode == "continue" {
                key(&record["command"]["scope"], self.encryption, None)?;
            }
            self.advance(record, fresh, mode).await?;
        }
        protect(record, self.checkpoint, self.encryption)?;
        save_job(self.file, record, false)?;
        output(record)
    }
}

impl Manager {
    pub async fn capture(
        &self,
        raw: &Value,
        encryption: &Service,
        lifetime: &Scope,
    ) -> Result<Value> {
        let mut command = checked(COMMAND, raw.clone())?;
        let mode = command["mode"]
            .as_str()
            .context("System capture mode")?
            .to_owned();
        command["mode"] = json!("execute");
        let scope = &command["scope"];
        account(scope, encryption)?;
        let id = text(&command, "operationId")?;
        let reference = json!({"scope":scope,"operationId":id,"targetGeneration":command["target"]["generation"]});
        let _lock =
            InstanceLock::acquire(&format!("system-job:{}", digest(reference)), lifetime).await?;
        account(scope, encryption)?;
        let file = self
            .data
            .join("cantrip-os-system-jobs")
            .join(scope_key(scope))
            .join(format!("{id}.json"));
        let checkpoint = Checkpoint::new(admission(&command), &self.data, encryption, lifetime)?;
        let current = load_job(&file, &command)?;
        let fresh = current.is_none();
        let mut record = match (current, mode.as_str()) {
            (Some(record), _) => record,
            (None, "observe") => return Ok(Value::Null),
            (None, "continue") => {
                return Err(anyhow!("No original system admission exists to continue"));
            }
            (None, _) => {
                let at = now();
                let mut record = json!({"version":1,"command":command,"state":"running","phase":"reserved",
                    "startedAt":at,"updatedAt":at,"validated":false,"captureRequested":false,"hostRequested":false,
                    "capture":Value::Null,"stage":Value::Null,"host":Value::Null,"root":Value::Null,
                    "protectedResult":Value::Null,"diagnostic":Value::Null});
                save_job(&file, &mut record, true)?;
                record
            }
        };
        if terminal(&record) {
            return output(&record);
        }
        let job = Job {
            file: &file,
            checkpoint: &checkpoint,
            encryption,
            lifetime,
        };
        match job.complete(&mut record, fresh, &mode).await {
            Ok(result) => Ok(result),
            Err(error) => {
                account(scope, encryption)?;
                if let Some(saved) = load_job(&file, &command)?
                    && terminal(&saved)
                {
                    return output(&saved);
                }
                record["state"] = json!("unknown");
                record["protectedResult"] = Value::Null;
                record["diagnostic"] = json!(error.to_string());
                save_job(&file, &mut record, false)?;
                protect(&mut record, &checkpoint, encryption)?;
                save_job(&file, &mut record, false)?;
                output(&record)
            }
        }
    }
}
