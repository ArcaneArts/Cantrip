//! Core's immutable system operation admission and protected client outcome.
use super::{
    Manager, account, checked,
    checkpoints::{Checkpoint, Mode},
    identity, key, load_record,
    replacement::{Mode as ReplacementMode, Replacement},
    same_placement, target,
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
use std::path::{Path, PathBuf};

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

fn job_path(root: &Path, scope: &Value, id: &str) -> PathBuf {
    root.join("cantrip-os-system-jobs")
        .join(scope_key(scope))
        .join(format!("{id}.json"))
}

fn same_owner(scope: &Value, original: &Value) -> Result<()> {
    ensure!(
        ["ownerId", "serverId", "workerId", "instanceId"]
            .into_iter()
            .all(|field| scope[field] == original[field]),
        "The system source belongs to another owning instance"
    );
    Ok(())
}

fn previous_job(root: &Path, scope: &Value, reference: &Value) -> Result<(PathBuf, Value)> {
    let original = &reference["scope"];
    same_owner(scope, original)?;
    let file = job_path(root, original, text(reference, "operationId")?);
    let record = load_record(&file)?.context("The original replacement is unavailable")?;
    let command = checked(COMMAND, record["command"].clone())?;
    ensure!(
        record["version"].as_u64() == Some(1)
            && command["action"] == "replace"
            && command["operationId"] == reference["operationId"]
            && command["target"]["generation"] == reference["targetGeneration"]
            && &command["scope"] == original,
        "The original replacement belongs to another immutable admission."
    );
    Ok((file, record))
}

fn host_request(record: &Value, file: &Path) -> Result<Value> {
    let command = &record["command"];
    let stage = &record["stage"];
    let mut request = json!({"operationId":command["operationId"],"container":command["target"]["containerName"],
        "instanceId":command["scope"]["instanceId"],"scopeKey":digest(command.clone()),"startTarget":command["startTarget"],
        "action":command["action"]});
    if command["action"] == "replace" {
        request["expectedContainerId"] = command["target"]["containerId"].clone();
        request["source"] = if command["source"]["kind"] == "base" {
            command["source"].clone()
        } else {
            let snapshot = &stage["manifest"]["snapshot"];
            ensure!(
                snapshot.is_object(),
                "The original checkpoint has no authenticated manifest."
            );
            let context = &command["source"]["capture"]["context"];
            json!({"kind":"checkpoint","imageId":snapshot["imageId"],"operationId":context["operationId"],
                "requestSha256":snapshot["requestSha256"],"containerId":context["containerId"]})
        };
        request["archive"] = if stage.is_object() {
            let path = file.with_extension("json.tar");
            json!({"path":path.to_str().context("The private staging path is not representable.")?,
                "bytes":stage["receipt"]["archiveBytes"],"sha256":stage["receipt"]["archiveSha256"]})
        } else {
            Value::Null
        };
    }
    Ok(request)
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

fn protect(
    record: &mut Value,
    checkpoint: Option<&Checkpoint<'_>>,
    encryption: &Service,
) -> Result<()> {
    let command = &record["command"];
    let scope = &command["scope"];
    let capture = match checkpoint {
        Some(checkpoint) => checkpoint.details(&record["capture"])?,
        None => Value::Null,
    };
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
    root: &'a Path,
    checkpoint: Option<Checkpoint<'a>>,
    encryption: &'a Service,
    lifetime: &'a Scope,
}

impl Job<'_> {
    async fn validate(&self, command: &Value) -> Result<()> {
        let scope = &command["scope"];
        let target = &command["target"];
        if command["action"] != "rollback" {
            return validate(command, self.lifetime).await;
        }
        ensure!(
            target["expected"]["ownerId"] == scope["ownerId"]
                && target["expected"]["workerId"] == scope["workerId"],
            "The system target ownership changed."
        );
        let (_, prior) = previous_job(self.root, scope, &command["replacement"])?;
        ensure!(
            prior["command"]["target"] == *target,
            "Rollback requires the original replacement's exact management target."
        );
        Ok(())
    }

    async fn stage(&self, record: &mut Value, mutate: bool) -> Result<bool> {
        let command = &record["command"];
        if command["source"]["kind"] != "checkpoint" {
            return Ok(true);
        }
        let source = &command["source"]["capture"];
        same_owner(&command["scope"], &source["context"])?;
        if record["stage"].is_null() {
            let checkpoint =
                Checkpoint::new(source.clone(), self.root, self.encryption, self.lifetime)?;
            let Some(stage) = checkpoint
                .stage(&self.file.with_extension("json.tar"), mutate)
                .await?
            else {
                return Ok(false);
            };
            record["stage"] = stage;
            record["phase"] = json!("archive-authenticated");
            save_job(self.file, record, false)?;
        }
        Ok(true)
    }

    async fn replace(&self, record: &mut Value, fresh: bool, mode: &str) -> Result<()> {
        let mutate = fresh || mode == "continue";
        if !self.stage(record, mutate).await? {
            record["state"] = json!("unknown");
            record["phase"] = json!("awaiting-archive-authentication");
            return Ok(());
        }
        let command = record["command"].clone();
        let scope = &command["scope"];
        let mut request = host_request(record, self.file)?;
        let mut prior = None;
        if command["action"] == "rollback" {
            let (file, source) = previous_job(self.root, scope, &command["replacement"])?;
            let source_request = host_request(&source, &file)?;
            request["replacementOperationId"] = source["command"]["operationId"].clone();
            request["replacementRequestSha256"] = json!(digest(source_request));
            request["expectedOriginalId"] = source["command"]["target"]["containerId"].clone();
            prior = Some(file.with_extension("json.docker"));
        }
        let engine = LocalDocker::current(self.lifetime).await?;
        let carrier = Replacement {
            journal: &self.file.with_extension("json.docker"),
            prior: prior.as_deref(),
            request: &request,
            owner: scope,
            engine: &engine,
            encryption: self.encryption,
            lifetime: self.lifetime,
        };
        let mut observed = carrier.run(ReplacementMode::Observe).await?;
        account(scope, self.encryption)?;
        if observed.is_none() && mutate && record["hostRequested"] != true {
            record["hostRequested"] = json!(true);
            save_job(self.file, record, false)?;
            observed = carrier.run(ReplacementMode::Execute).await?;
        } else if observed.is_some() && mode == "continue" {
            observed = carrier.run(ReplacementMode::Continue).await?;
        }
        if let Some(observed) = observed {
            let operation = &observed["operation"];
            record["state"] = operation["state"].clone();
            record["phase"] = operation["phase"].clone();
            record["diagnostic"] = operation["error"].clone();
            record["root"] = self.root_proof(&engine, &command, operation).await?;
            record["host"] = observed;
            record["protectedResult"] = Value::Null;
        } else {
            record["state"] = json!("unknown");
            record["diagnostic"] =
                json!("The original root transition has no observable host admission");
        }
        account(scope, self.encryption)?;
        save_job(self.file, record, false)
    }

    async fn root_proof(
        &self,
        engine: &LocalDocker,
        command: &Value,
        operation: &Value,
    ) -> Result<Value> {
        let scope = &command["scope"];
        let mut guest = Value::Null;
        let mut attachment = "unavailable";
        if let Some(id) = operation["targetContainerId"].as_str()
            && let Ok(current) = identity::current(
                engine,
                id,
                command["target"]["expected"]["identityPath"].as_str(),
                self.lifetime,
            )
            .await
        {
            if current.attachment.is_null() {
                guest = current.id;
                attachment = "unattached";
            } else if current.attachment["owner_id"] == scope["ownerId"]
                && current.attachment["worker_id"] == scope["workerId"]
            {
                guest = current.id;
                attachment = "owned";
            }
        }
        checked(
            "cantripOsSystemRootReceiptSchema",
            json!({"requestSha256":operation["requestSha256"],
            "originalContainerId":operation["originalContainerId"],"targetContainerId":operation["targetContainerId"],
            "retainedContainerId":operation["retainedContainerId"],"runtimeHandlesRestored":false,
            "guestInstanceId":guest,"guestAttachment":attachment}),
        )
    }

    async fn advance(&self, record: &mut Value, fresh: bool, mode: &str) -> Result<()> {
        let command = record["command"].clone();
        if record["validated"] != true {
            if let Err(error) = self.validate(&command).await {
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
        if let Some(checkpoint) = &self.checkpoint {
            return self.capture(record, checkpoint, fresh, mode).await;
        }
        self.replace(record, fresh, mode).await
    }

    async fn capture(
        &self,
        record: &mut Value,
        checkpoint: &Checkpoint<'_>,
        fresh: bool,
        mode: &str,
    ) -> Result<()> {
        let command = record["command"].clone();
        let mut child = checkpoint.run(Mode::Observe).await?;
        account(&command["scope"], self.encryption)?;
        if (fresh || mode == "continue") && record["captureRequested"] != true {
            checkpoint.run(Mode::Prepare).await?;
            record["captureRequested"] = json!(true);
            save_job(self.file, record, false)?;
            child = checkpoint.run(Mode::Continue).await?;
        } else if mode == "continue" && child.is_some() {
            child = checkpoint.run(Mode::Continue).await?;
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
        let claimed = record["captureRequested"] == true || record["hostRequested"] == true;
        let prepared = record["phase"] == "prepared" && !claimed;
        if mode == "prepare" || (mode == "observe" && prepared) {
            if claimed || (prepared && !record["protectedResult"].is_null()) {
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
        protect(record, self.checkpoint.as_ref(), self.encryption)?;
        save_job(self.file, record, false)?;
        output(record)
    }
}

impl Manager {
    pub async fn operation(
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
        let file = job_path(&self.data, scope, id);
        let checkpoint = if command["action"] == "capture" {
            Some(Checkpoint::new(
                admission(&command),
                &self.data,
                encryption,
                lifetime,
            )?)
        } else {
            None
        };
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
            root: &self.data,
            checkpoint,
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
                protect(&mut record, job.checkpoint.as_ref(), encryption)?;
                save_job(&file, &mut record, false)?;
                output(&record)
            }
        }
    }
}
