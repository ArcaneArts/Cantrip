//! Durable private guest backup operations.
mod archive;
mod capture;
mod carrier;
mod restore;

use super::{
    assert_scope,
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
use std::{
    fs::File,
    io,
    path::{Path, PathBuf},
};

const OBSERVE: &str = "cantrip-os.backup.observe";
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
    Continue,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Action {
    Capture,
    Restore,
    Rollback,
    Reset,
}

impl Action {
    const ALL: [Self; 4] = [Self::Capture, Self::Restore, Self::Rollback, Self::Reset];

    fn kind(self) -> &'static str {
        match self {
            Self::Capture => "cantrip-os.backup.capture",
            Self::Restore => "cantrip-os.backup.restore",
            Self::Rollback => "cantrip-os.backup.rollback",
            Self::Reset => "cantrip-os.backup.reset",
        }
    }

    fn tag(self) -> &'static str {
        match self {
            Self::Capture => "capture",
            Self::Restore => "restore",
            Self::Rollback => "rollback",
            Self::Reset => "reset",
        }
    }

    fn schema(self) -> &'static str {
        match self {
            Self::Capture => "cantripOsBackupCaptureCommandSchema",
            Self::Restore => "cantripOsBackupRestoreCommandSchema",
            Self::Rollback => "cantripOsBackupRollbackCommandSchema",
            Self::Reset => "cantripOsBackupResetCommandSchema",
        }
    }
}

pub(super) fn supports(kind: &str) -> bool {
    kind == OBSERVE || Action::ALL.iter().any(|action| action.kind() == kind)
}

struct Job<'a> {
    root: &'a Path,
    command: &'a Value,
    encryption: &'a Service,
    lifetime: &'a Scope,
    mode: Mode,
    action: Action,
    mutation_scope: &'a Value,
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
        let new = raw["type"] != OBSERVE;
        let action = Action::ALL
            .into_iter()
            .find(|action| {
                if new {
                    raw["type"] == action.kind()
                } else {
                    raw["action"] == action.tag()
                }
            })
            .context("Unsupported backup action")?;
        let schema = if new {
            action.schema()
        } else {
            "cantripOsBackupObserveCommandSchema"
        };
        let command = checked(schema, raw.clone())?;
        let scope = &command["scope"];
        let id = text(&command, "operationId")?;
        account(encryption, scope)?;
        let record = if new {
            let job = Job {
                root: &self.root,
                command: &command,
                encryption,
                lifetime,
                mode: Mode::New,
                action,
                mutation_scope: scope,
            };
            job.request()?;
            operations.execute_record(
                scope, id, action.kind(), command.clone(),
                Some(json!({"version":1,"command":command,"phase":"admitted"})),
                async |journal| {
                    let result = job.run(journal).await;
                    match result {
                        Ok(outcome) if outcome.state == "ready" => Ok(outcome.receipt),
                        Ok(outcome) if outcome.state == "failed" => {
                            let message = outcome.error.as_str().unwrap_or("The guest recovery operation failed.");
                            bail!("{message}");
                        }
                        Ok(_) => Err(DeliveryUnknown("Guest operation did not return a completed receipt.".into()).into()),
                        Err(error) if !matches!(journal.checkpoint()["phase"].as_str(), Some("admitted" | "verifying")) => {
                            Err(DeliveryUnknown(format!("The admitted guest operation requires observation or recovery: {error}")).into())
                        }
                        Err(error) if action == Action::Restore => {
                            job.clear_staging().await.with_context(|| format!(
                                "{error} Worker restore staging cleanup could not be confirmed."
                            ))?;
                            Err(error)
                        }
                        Err(error) => Err(error),
                    }
                },
            ).await?
        } else {
            let mode = match text(&command, "mode")? {
                "observe" => Mode::Observe,
                "continue" => Mode::Continue,
                _ => Mode::Recover,
            };
            let mutation_scope = if !command["continuationScope"].is_null() {
                let mut expected = scope.clone();
                expected["runtimeGeneration"] =
                    command["continuationScope"]["runtimeGeneration"].clone();
                ensure!(
                    mode == Mode::Continue && command["continuationScope"] == expected,
                    "Continuation cannot change the saved attachment, instance, owner or Worker."
                );
                &command["continuationScope"]
            } else {
                scope
            };
            operations
                .reconcile_existing(scope, id, action.kind(), async |journal| {
                    let stored = checked(action.schema(), journal.checkpoint()["command"].clone())?;
                    checked(
                        "cantripOsBackupPhaseSchema",
                        journal.checkpoint()["phase"].clone(),
                    )?;
                    ensure!(
                        journal.checkpoint()["version"] == 1
                            && stored["operationId"] == id
                            && &stored["scope"] == scope
                            && journal.record()["admissionFingerprint"]
                                == digest(Value::Array(vec![json!(action.kind()), stored.clone()])),
                        "Stored backup admission has changed or is incomplete."
                    );
                    let job = Job {
                        root: &self.root,
                        command: &stored,
                        encryption,
                        lifetime,
                        mode,
                        action,
                        mutation_scope,
                    };
                    let outcome = job.run(journal).await?;
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
        result(encryption, scope, id, action, &record)
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

fn result(
    service: &Service,
    scope: &Value,
    id: &str,
    action: Action,
    record: &Value,
) -> Result<Value> {
    let mut protected = Value::Null;
    let receipt = &record["receipt"];
    if !receipt.is_null() {
        ensure!(
            receipt["kind"] == "backup-result" && receipt["action"] == action.tag(),
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
            json!({"action":"error","operationAction":action.tag(),"message":message}),
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
            "operationId":id,"action":action.tag(),"state":state,"phase":phase,
            "startedAt":record["startedAt"],"updatedAt":time,"protectedResult":protected,
            "error":if matches!(state,"ready" | "running") { Value::Null } else { json!(INCOMPLETE) },
        }),
    )
}

impl Job<'_> {
    async fn run(&self, journal: &mut Journal<'_>) -> Result<Outcome> {
        match self.action {
            Action::Capture => capture::run(self, journal).await,
            Action::Restore => restore::restore(self, journal).await,
            Action::Rollback => restore::rollback(self, journal).await,
            Action::Reset => restore::reset(self, journal).await,
        }
    }

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
                && request["action"] == self.action.tag()
                && (self.action != Action::Restore
                    || (request["backupId"] == self.command["backupId"]
                        && request["replace"] == self.command["replace"]))
                && (self.action != Action::Rollback
                    || request["restoreOperationId"] == self.command["restoreOperationId"]),
            "Private backup intent does not match its canonical admission."
        );
        Ok(request)
    }

    fn location(&self) -> Result<PathBuf> {
        Ok(backup_directory(self.root, &self.command["scope"], self.id()?).join("archive.ctos"))
    }

    fn id(&self) -> Result<&str> {
        text(self.command, "operationId")
    }

    fn staging(&self) -> Result<PathBuf> {
        Ok(backup_directory(self.root, &self.command["scope"], self.id()?).join("restore-staging"))
    }

    async fn clear_staging(&self) -> Result<()> {
        match tokio::fs::remove_dir_all(self.staging()?).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn transport(&self) -> Result<Transport> {
        Transport::from_value(&self.command["transport"])
    }

    fn expected(&self, mutation: bool) -> String {
        let scope = if mutation {
            self.mutation_scope
        } else {
            &self.command["scope"]
        };
        let mut expected = json!({"guestInstanceId":scope["guestInstanceId"],"ownerId":scope["ownerId"],
            "workerId":scope["workerId"]});
        if mutation {
            expected["runtimeGeneration"] = scope["runtimeGeneration"].clone();
        }
        expected.stringify()
    }

    fn workspace(&self) -> Value {
        let workspace = &self.command["workspace"];
        json!({"id":workspace["guestWorkspaceId"],"uid":workspace["uid"],
            "gid":workspace["gid"],"home":workspace["homeGuestPath"]})
    }

    fn workspace_matches(&self, actual: &Value) -> bool {
        let expected = self.workspace();
        ["id", "uid", "gid", "home"]
            .into_iter()
            .all(|field| actual[field] == expected[field])
    }

    async fn assert_current(&self, transport: &Transport) -> Result<()> {
        assert_scope(transport, self.mutation_scope, true, self.lifetime).await?;
        Ok(())
    }

    async fn control(
        &self,
        transport: &Transport,
        mutation: bool,
        arguments: &[&str],
        input: Option<File>,
    ) -> Result<Value> {
        let expected = self.expected(mutation);
        let mut args = vec!["--expect", expected.as_str()];
        let workspace = self.workspace();
        let identity =
            json!({"uid":workspace["uid"],"gid":workspace["gid"],"home":workspace["home"]})
                .stringify();
        if mutation {
            args.extend(["--expect-workspace", &identity]);
        }
        args.extend(arguments);
        let observed = carrier::control(transport, &args, self.lifetime, input).await?;
        ensure!(
            observed["operation_id"] == self.command["operationId"]
                && observed["action"] == self.action.tag(),
            "Guest recovery receipt belongs to another operation."
        );
        Ok(observed)
    }

    async fn observe_guest(
        &self,
        transport: &Transport,
        journal: &mut Journal<'_>,
    ) -> Result<Value> {
        let id = self.id()?;
        let saved = self
            .control(transport, false, &["inspect", id], None)
            .await?;
        let unfinished = matches!(saved["state"].as_str(), Some("unknown" | "restoring"))
            || (saved["maintenance"].is_object() && saved["maintenance"]["released"] != true);
        if !unfinished || saved["active"] == true {
            return Ok(saved);
        }
        if self.mode == Mode::Observe {
            phase(journal, "recovery-required")?;
            return Ok(saved);
        }
        self.control(transport, false, &["recover", id], None).await
    }

    async fn cleanup_guest(&self, transport: &Transport) -> Result<Vec<&'static str>> {
        if self.mode == Mode::Observe {
            return Ok(vec![
                "Guest transfer staging cleanup was not requested during observation.",
            ]);
        }
        if self
            .control(transport, false, &["forget", self.id()?], None)
            .await
            .is_err()
        {
            return Ok(vec![
                "Guest transfer staging cleanup could not be confirmed.",
            ]);
        }
        Ok(vec![])
    }

    fn complete(&self, journal: &mut Journal<'_>, value: Value) -> Result<Outcome> {
        let envelope = protect(self.encryption, &self.command["scope"], self.id()?, value)?;
        phase(journal, "complete")?;
        let receipt =
            json!({"kind":"backup-result","action":self.action.tag(),"protectedResult":envelope});
        Ok(Outcome {
            state: "ready",
            receipt,
            error: Value::Null,
        })
    }
}

fn backup_directory(root: &Path, scope: &Value, id: &str) -> PathBuf {
    root.join("cantrip-os-backups")
        .join(scope_key(scope))
        .join(id)
}

fn phase(journal: &mut Journal<'_>, value: &str) -> Result<()> {
    let mut checkpoint = journal.checkpoint().clone();
    checkpoint["phase"] = json!(value);
    journal.set_checkpoint(checkpoint)
}
