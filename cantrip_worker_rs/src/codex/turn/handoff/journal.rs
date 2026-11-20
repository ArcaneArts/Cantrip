//! The version-one handoff journal is shared with the retiring worker.
use crate::http::checked;
use anyhow::{Context, Result, bail, ensure};
use cantrip_history::files::{
    ensure_directory, flush_directory, queue, read_json, write_immutable,
};
use cantrip_wire::{JsString, Value, parse_json_text, payload_digest, value::json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    future::Future,
    io::ErrorKind,
    path::{Path, PathBuf},
};

pub(super) struct Journal {
    root: PathBuf,
    scope: Value,
    state: Value,
}

pub(super) struct Plan {
    root: PathBuf,
    record: Value,
    pub source_home: PathBuf,
}

impl Journal {
    pub fn new(data: &Path, scope: Value, state: Value) -> Result<Self> {
        ensure!(
            ["serverId", "ownerId", "workerId"]
                .iter()
                .all(|field| nonempty(&scope[*field])),
            "Missing native handoff journal owner."
        );
        ensure!(
            scope["workerId"] == state["workerId"]
                && scope["workerId"] == state["source"]["workerId"]
                && nonempty(&state["chatId"])
                && state["chatId"] == state["source"]["chatId"],
            "Handoff journal belongs to another worker or chat."
        );
        let operation = operation_id(&state["operationId"]).context("Invalid handoff operation")?;
        let key = payload_digest(&json!([
            scope["serverId"].clone(),
            scope["ownerId"].clone(),
            scope["workerId"].clone(),
            state["chatId"].clone(),
        ]));
        Ok(Self {
            root: data
                .join("managed-runtime-handoffs")
                .join(key)
                .join(operation),
            scope,
            state,
        })
    }

    fn withdrawal_identity(&self) -> Value {
        json!({
            "version":1, "scope":self.scope, "chatId":self.state["chatId"],
            "operationId":self.state["operationId"],
            "sourceBindingId":self.state["source"]["bindingId"],
            "sourceOperationId":self.state["queuedSource"]["operationId"],
            "sourceOperationGeneration":self.state["queuedSource"]["operationGeneration"],
        })
    }

    pub async fn saved_withdrawal(&self) -> Result<Option<Value>> {
        let Some(bytes) = read_optional(&self.root.join("withdrawal.json")).await? else {
            return Ok(None);
        };
        let mut stored = parse_json(&bytes)?;
        let Value::Object(fields) = &mut stored else {
            bail!("Invalid handoff withdrawal journal.");
        };
        let record = fields
            .shift_remove("record")
            .context("Missing handoff withdrawal proof")?;
        ensure!(
            stored == self.withdrawal_identity(),
            "The handoff withdrawal reservation changed."
        );
        Ok(Some(checked(
            "workerInferenceJournalRecordSchema",
            &record,
        )?))
    }

    pub async fn save_withdrawal(&self, record: &Value) -> Result<()> {
        let mut stored = self.withdrawal_identity();
        stored["record"] = checked("workerInferenceJournalRecordSchema", record)?;
        let root = self.root.clone();
        queue(&self.root)
            .run(move || {
                ensure_directory(&root)?;
                publish(&root.join("withdrawal.json"), &stored)
            })
            .await
    }

    pub async fn retire_withdrawal(&self) -> Result<()> {
        if self.saved_withdrawal().await?.is_some() {
            tokio::fs::remove_file(self.root.join("withdrawal.json")).await?;
            flush_directory(&self.root)?;
        }
        Ok(())
    }

    /// Only a source that is still authorized to export may create a plan.
    /// Once created its native boundary and source home never change.
    pub async fn prepare<F>(self, capture: impl FnOnce() -> F + Send + 'static) -> Result<Plan>
    where
        F: Future<Output = Result<(PathBuf, Option<JsString>, Value)>> + Send + 'static,
    {
        queue(&self.root)
            .run_async(async move {
                let filename = self.root.join("plan.json");
                let identity = json!({
                    "version":1, "scope":self.scope, "chatId":self.state["chatId"],
                    "threadId":self.state["source"]["threadId"],
                    "operationId":self.state["operationId"],
                    "sourceBindingId":self.state["source"]["bindingId"],
                });
                let epoch = goal_epoch(&self.state);
                let record = match read_optional(&filename).await? {
                    Some(bytes) => parse_json(&bytes)?,
                    None => {
                        ensure!(
                            matches!(self.state["phase"].as_str(), Some("preparing" | "prepared")),
                            "Committed handoff has no worker export plan."
                        );
                        let (home, last_turn, previous) = capture().await?;
                        let mut record = identity.clone();
                        record["sourceHome"] =
                            json!(home.to_str().context("Invalid handoff source path")?);
                        record["expectedLastTurnId"] = json!(last_turn);
                        record["previousOperationId"] = previous;
                        if let Some(epoch) = epoch {
                            record["expectedGoalEpoch"] = epoch.clone();
                        }
                        validate_plan(&record, &identity, epoch, &self.state)?;
                        ensure_directory(&self.root)?;
                        publish(&filename, &record)?;
                        record
                    }
                };
                let source_home = validate_plan(&record, &identity, epoch, &self.state)?;
                Ok(Plan {
                    root: self.root,
                    record,
                    source_home,
                })
            })
            .await
    }
}

impl Plan {
    pub fn last_turn(&self) -> &Value {
        &self.record["expectedLastTurnId"]
    }

    pub fn previous_operation(&self) -> &Value {
        &self.record["previousOperationId"]
    }

    pub async fn export<F>(
        &self,
        capture: impl FnOnce(Value) -> F + Send + 'static,
    ) -> Result<Value>
    where
        F: Future<Output = Result<Value>> + Send + 'static,
    {
        let root = self.root.clone();
        let plan = self.record.clone();
        let home = self.source_home.clone();
        queue(&root)
            .run_async(async move {
                ensure!(
                    read_json(&root.join("plan.json"))? == plan,
                    "Handoff export requires its persisted reservation plan."
                );
                let operation = plan["operationId"].as_str().unwrap();
                let filename = home
                    .join("managed-history-exports")
                    .join(format!("{operation}.json"));
                let receipt_file = root.join("export.json");
                let receipt = read_optional(&receipt_file).await?;
                let bytes = match read_optional(&filename).await? {
                    Some(bytes) => bytes,
                    None => {
                        ensure!(receipt.is_none(), "Committed handoff export is missing.");
                        let mut input = json!({
                            "threadId":plan["threadId"],"transferId":operation,
                            "expectedHandoffOperation":operation,
                            "expectedLastTurnId":plan["expectedLastTurnId"],
                        });
                        if let Some(epoch) = plan.get("expectedGoalEpoch") {
                            input["expectedGoalEpoch"] = epoch.clone();
                        }
                        let response = capture(input).await?;
                        let path = Path::new(
                            response["path"]
                                .as_str()
                                .context("Missing native export path")?,
                        );
                        ensure!(
                            response["threadId"] == plan["threadId"]
                                && path.is_absolute()
                                && tokio::fs::canonicalize(path).await?
                                    == tokio::fs::canonicalize(&filename).await?,
                            "Native export returned another handoff artifact."
                        );
                        tokio::fs::read(&filename).await?
                    }
                };
                let artifact = parse_json(&bytes)?;
                ensure!(
                    matches!(artifact["version"].as_i64(), Some(2 | 3))
                        && artifact["thread_id"] == plan["threadId"]
                        && artifact["metadata"]["id"] == plan["threadId"],
                    "Native export contains another conversation."
                );
                let path = filename.to_str().context("Invalid handoff export path")?;
                let mut transfer = json!({
                    "threadId":plan["threadId"],"transferId":operation,"path":path,
                });
                let digest: String = Sha256::digest(&bytes)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
                transfer["sha256"] = json!(digest);
                transfer["version"] = json!(1);
                if let Some(bytes) = receipt {
                    ensure!(
                        parse_json(&bytes)? == transfer,
                        "Committed handoff artifact changed."
                    );
                }
                publish(&receipt_file, &transfer)?;
                Ok(json!({"threadId":plan["threadId"],"transferId":operation,"path":path}))
            })
            .await
    }
}

fn validate_plan(
    record: &Value,
    identity: &Value,
    epoch: Option<&Value>,
    state: &Value,
) -> Result<PathBuf> {
    let persisted_epoch = record.get("expectedGoalEpoch");
    ensure!(
        record
            .as_object()
            .is_some_and(|fields| fields.len() == 9 + usize::from(persisted_epoch.is_some()))
            && identity
                .as_object()
                .unwrap()
                .iter()
                .all(
                    |(key, value)| record.as_object().and_then(|fields| fields.get(key))
                        == Some(value)
                )
            && record
                .get("expectedLastTurnId")
                .is_some_and(|value| value.is_null() || nonempty(value))
            && record
                .get("previousOperationId")
                .is_some_and(|value| value.is_null() || operation_id(value).is_some())
            && (!(persisted_epoch.is_some() || state["queuedSource"].get("taskGoal").is_some())
                || persisted_epoch == epoch),
        "Handoff journal reservation changed."
    );
    let home = PathBuf::from(
        record["sourceHome"]
            .as_str()
            .context("Missing handoff source home")?,
    );
    ensure!(home.is_absolute(), "Invalid handoff source home.");
    Ok(home)
}

fn goal_epoch(state: &Value) -> Option<&Value> {
    let queued = &state["queuedSource"];
    [
        &queued["taskGoalInput"]["goalEpoch"],
        &queued["taskGoal"]["identity"]["recovery"]["taskGoalCycle"]["goalEpoch"],
        &queued["goalRecovery"]["goalEpoch"],
        &queued["goalClaim"]["goalEpoch"],
        &queued["autonomousAttempt"]["goalEpoch"],
    ]
    .into_iter()
    .find(|epoch| nonempty(epoch))
}

fn nonempty(value: &Value) -> bool {
    value.as_js_string().is_some_and(|value| !value.is_empty())
}

pub(super) fn operation_id(value: &Value) -> Option<&str> {
    let text = value.as_str()?;
    let id = uuid::Uuid::parse_str(text).ok()?;
    (id.hyphenated().to_string().eq_ignore_ascii_case(text)
        && (id.is_nil()
            || id.is_max()
            || (id.get_variant() == uuid::Variant::RFC4122
                && (1..=8).contains(&id.get_version_num()))))
    .then_some(text)
}

async fn read_optional(path: &Path) -> Result<Option<Vec<u8>>> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn parse_json(bytes: &[u8]) -> Result<Value> {
    parse_json_text(&String::from_utf8_lossy(bytes))
        .map_err(|_| anyhow::anyhow!("Invalid native handoff journal or artifact JSON."))
}

fn publish(path: &Path, value: &Value) -> Result<()> {
    if !write_immutable(path, &value.stringify())? && parse_json(&fs::read(path)?)? != *value {
        bail!("Conflicting handoff journal publication.");
    }
    Ok(())
}
