//! Durable private guest backup operations.
mod archive;
mod capture;
mod carrier;

use super::{
    carrier::{DeliveryUnknown, Transport},
    checked,
    operations::{Journal, Operations, digest, now, scope_key},
    text,
};
use crate::{
    encryption::{ComponentKey, Service},
    filesystem::Scope,
};
use anyhow::{Context, Result, bail, ensure};
use cantrip_crypto::{
    Zeroizing,
    content::{BackupCipher, BackupFrame},
};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use std::path::{Path, PathBuf};

pub(super) const CAPTURE: &str = "cantrip-os.backup.capture";
pub(super) const OBSERVE: &str = "cantrip-os.backup.observe";
const COMPONENT: &str = "repository-content";
const INCOMPLETE: &str = "The backup operation is incomplete. Observe or recover its saved admission; uncertain mutations were not replayed.";

pub(super) struct Manager {
    root: PathBuf,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    New,
    Observe,
    Recover,
}

struct Job<'a> {
    root: &'a Path,
    command: &'a Value,
    encryption: &'a Service,
    lifetime: &'a Scope,
    mode: Mode,
}

struct Outcome {
    state: &'static str,
    receipt: Value,
    error: Value,
}

impl Manager {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_owned(),
        }
    }

    pub async fn execute(
        &self,
        operations: &Operations,
        raw: &Value,
        encryption: &Service,
        lifetime: &Scope,
    ) -> Result<Value> {
        let capture = raw["type"] == CAPTURE;
        let schema = if capture {
            "cantripOsBackupCaptureCommandSchema"
        } else {
            "cantripOsBackupObserveCommandSchema"
        };
        let command = checked(schema, raw.clone())?;
        let scope = &command["scope"];
        let id = text(&command, "operationId")?;
        account(encryption, scope)?;
        let record = if capture {
            let job = Job {
                root: &self.root,
                command: &command,
                encryption,
                lifetime,
                mode: Mode::New,
            };
            job.request()?;
            operations.execute_record(
                scope, id, CAPTURE, command.clone(),
                Some(json!({"version":1,"command":command,"phase":"admitted"})),
                async |journal| {
                    let result = capture::run(&job, journal).await;
                    match result {
                        Ok(outcome) if outcome.state == "ready" => Ok(outcome.receipt),
                        Ok(outcome) if outcome.state == "failed" => {
                            let message = outcome.error.as_str().unwrap_or("The guest recovery operation failed.");
                            bail!("{message}");
                        }
                        Ok(_) => Err(DeliveryUnknown("Guest operation did not return a completed receipt.".into()).into()),
                        Err(error) if journal.checkpoint()["phase"] != "admitted" => {
                            Err(DeliveryUnknown(format!("The admitted guest operation requires observation or recovery: {error}")).into())
                        }
                        Err(error) => Err(error),
                    }
                },
            ).await?
        } else {
            ensure!(
                command["action"] == "capture",
                "This worker does not support the requested backup action."
            );
            let mode = if command["mode"] == "observe" {
                Mode::Observe
            } else {
                Mode::Recover
            };
            if !command["continuationScope"].is_null() {
                let mut expected = scope.clone();
                expected["runtimeGeneration"] =
                    command["continuationScope"]["runtimeGeneration"].clone();
                ensure!(
                    command["mode"] == "continue" && command["continuationScope"] == expected,
                    "Continuation cannot change the saved attachment, instance, owner or Worker."
                );
            }
            operations
                .reconcile_existing(scope, id, CAPTURE, async |journal| {
                    let stored = checked(
                        "cantripOsBackupCaptureCommandSchema",
                        journal.checkpoint()["command"].clone(),
                    )?;
                    checked(
                        "cantripOsBackupPhaseSchema",
                        journal.checkpoint()["phase"].clone(),
                    )?;
                    ensure!(
                        journal.checkpoint()["version"] == 1
                            && stored["operationId"] == id
                            && &stored["scope"] == scope
                            && journal.record()["admissionFingerprint"]
                                == digest(Value::Array(vec![json!(CAPTURE), stored.clone()])),
                        "Stored backup admission has changed or is incomplete."
                    );
                    let job = Job {
                        root: &self.root,
                        command: &stored,
                        encryption,
                        lifetime,
                        mode,
                    };
                    let outcome = capture::run(&job, journal).await?;
                    let error = if outcome.receipt.is_null() && outcome.error.is_null() {
                        journal.record()["error"].clone()
                    } else {
                        outcome.error
                    };
                    journal.outcome(outcome.state, outcome.receipt, error);
                    Ok(())
                })
                .await?
        };
        result(encryption, scope, id, &record)
    }
}

fn account(service: &Service, scope: &Value) -> Result<()> {
    let (owner, server) = service.bound_identity()?;
    ensure!(
        scope["ownerId"].as_js_string() == Some(&owner)
            && scope["serverId"] == server
            && scope["workerId"].as_js_string() == Some(service.worker_id()),
        "The backup account or logical Server changed."
    );
    Ok(())
}

fn material(service: &Service, scope: &Value, revision: Option<u64>) -> Result<ComponentKey> {
    let bound = service.bound_component(COMPONENT, revision)?;
    ensure!(
        scope["ownerId"].as_js_string() == Some(&bound.owner_id)
            && scope["serverId"] == bound.server_id,
        "The private backup account or Server changed."
    );
    Ok(bound.component)
}

fn context(scope: &Value, id: &str) -> Value {
    json!({"ownerId":scope["ownerId"],"serverId":scope["serverId"],"backupId":id})
}

fn protect(service: &Service, scope: &Value, id: &str, value: Value) -> Result<Value> {
    let protected = checked("cantripOsBackupPrivateResultSchema", value)?;
    let key = material(service, scope, None)?;
    let context = context(scope, id);
    let cipher = BackupCipher::new(&context, key.key_revision, &key.key)?;
    let bytes = Zeroizing::new(protected.stringify().into_bytes());
    checked(
        "cantripOsBackupResponseEnvelopeSchema",
        cipher.seal(BackupFrame::Metadata, 2, &bytes)?,
    )
}

fn result(service: &Service, scope: &Value, id: &str, record: &Value) -> Result<Value> {
    let mut protected = Value::Null;
    let receipt = &record["receipt"];
    if !receipt.is_null() {
        ensure!(
            receipt["kind"] == "backup-result" && receipt["action"] == "capture",
            "The backup result belongs to another action."
        );
        protected = checked(
            "cantripOsBackupResponseEnvelopeSchema",
            receipt["protectedResult"].clone(),
        )?;
    } else if let Some(error) = record["error"].as_js_string() {
        let message = JsString::new(error.units()[..error.len().min(8192)].to_vec());
        protected = protect(
            service,
            scope,
            id,
            json!({"action":"error","operationAction":"capture","message":message}),
        )
        .unwrap_or(Value::Null);
    }
    let state = record["state"].as_str().unwrap_or("unknown");
    let phase = record["checkpoint"]["phase"]
        .as_str()
        .unwrap_or("recovery-required");
    let time = record["updatedAt"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(now);
    checked(
        "cantripOsBackupOperationResultSchema",
        json!({
            "operationId":id,"action":"capture","state":state,"phase":phase,
            "startedAt":record["startedAt"],"updatedAt":time,"protectedResult":protected,
            "error":if matches!(state,"ready" | "running") { Value::Null } else { json!(INCOMPLETE) },
        }),
    )
}

impl Job<'_> {
    fn request(&self) -> Result<Value> {
        let frame = checked(
            "cantripOsBackupRequestEnvelopeSchema",
            self.command["protectedRequest"].clone(),
        )?;
        let revision = frame["envelope"]["keyRevision"]
            .as_u64()
            .context("Backup request key revision")?;
        let scope = &self.command["scope"];
        let id = text(self.command, "operationId")?;
        let key = material(self.encryption, scope, Some(revision))?;
        let context = context(scope, id);
        let cipher = BackupCipher::new(&context, revision, &key.key)?;
        let bytes = cipher.open(BackupFrame::Metadata, 1, &frame)?;
        let content = std::str::from_utf8(&bytes)?;
        let value = parse_json_text(content.strip_prefix('\u{feff}').unwrap_or(content))
            .map_err(|_| cantrip_crypto::decryption_error())?;
        let request = checked("cantripOsBackupPrivateRequestSchema", value)?;
        ensure!(
            request["workspaceId"] == self.command["workspace"]["id"]
                && request["action"] == "capture",
            "Private backup intent does not match its canonical admission."
        );
        Ok(request)
    }

    fn location(&self) -> Result<PathBuf> {
        Ok(self
            .root
            .join("cantrip-os-backups")
            .join(scope_key(&self.command["scope"]))
            .join(text(self.command, "operationId")?)
            .join("archive.ctos"))
    }

    fn transport(&self) -> Result<Transport> {
        Transport::from_value(&self.command["transport"])
    }

    fn expected(&self, mutation: bool) -> String {
        let scope = &self.command["scope"];
        let mut expected = json!({"guestInstanceId":scope["guestInstanceId"],"ownerId":scope["ownerId"],
            "workerId":scope["workerId"]});
        if mutation {
            expected["runtimeGeneration"] = scope["runtimeGeneration"].clone();
        }
        expected.stringify()
    }
}

fn phase(journal: &mut Journal<'_>, value: &str) -> Result<()> {
    let mut checkpoint = journal.checkpoint().clone();
    checkpoint["phase"] = json!(value);
    journal.set_checkpoint(checkpoint)
}
