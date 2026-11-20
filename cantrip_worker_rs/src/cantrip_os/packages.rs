//! Package administration that remains available with a broken guest executor.
mod catalog;
mod protection;

use super::{
    carrier::{DeliveryUnknown, Program, Transport},
    checked,
    docker::LocalDocker,
    lock::InstanceLock,
    operations::{Admission, Journal, Operations, digest},
    text,
};
use crate::{encryption::Service, filesystem::Scope};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{Value, parse_json_text, value::json};
use catalog::Catalog;
use std::{fs::File, path::Path};
use uuid::Uuid;

pub(super) const STATUS: &str = "cantrip-os.packages.status";
pub(super) const OPERATION: &str = "cantrip-os.packages.operation";
const RESCUE: &str = include_str!("../../../cantrip_os/host/package-job.py");

pub(super) struct Manager {
    catalog: Catalog,
}

fn account(scope: &Value, encryption: &Service) -> Result<()> {
    let (owner, server) = encryption.bound_identity()?;
    ensure!(
        scope["ownerId"].as_js_string() == Some(&owner)
            && scope["serverId"] == server
            && scope["workerId"].as_js_string() == Some(encryption.worker_id()),
        "The package operation belongs to another Worker, account or Server."
    );
    Ok(())
}

fn guest_request(command: &Value) -> Result<Value> {
    let target = &command["target"];
    let mut expected = target["expected"].clone();
    expected["bootId"] = target["bootId"].clone();
    expected["initStart"] = target["initStart"].clone();
    let key = digest(Value::Array(vec![
        command["scope"].clone(),
        target["generation"].clone(),
    ]));
    checked(
        "cantripOsGuestPackageRequestSchema",
        json!({"version":2,"operationId":command["operationId"],"scopeKey":key,
            "action":command["action"],"configuration":command["configuration"],
            "expected":expected,"packages":command["packages"]}),
    )
}

fn verify_guest(command: &Value, request: &Value, raw: Value) -> Result<Value> {
    let guest = checked("cantripOsGuestPackageRecordSchema", raw)?;
    ensure!(
        &guest["request"] == request,
        "The guest package journal belongs to a different original admission."
    );
    if guest["state"] == "ready" {
        let receipt = &guest["receipt"];
        let packages = receipt["packages"]
            .as_array()
            .context("Installed package receipt")?;
        let helpers = receipt["helpers"]
            .as_array()
            .context("Package helper receipt")?;
        let expected = command["packages"]
            .as_array()
            .context("Admitted packages")?;
        ensure!(
            receipt["exitCode"] == 0
                && receipt["configurationPolicy"] == command["configuration"]
                && receipt["runtimeHandlesRestored"] == false
                && packages.len() == expected.len()
                && helpers.len() == expected.len(),
            "The guest has no verified package/helper completion receipt."
        );
        for artifact in expected {
            let name = &artifact["name"];
            let version = text(artifact, "version")?;
            let architecture = text(artifact, "architecture")?;
            let installed = format!("install ok installed\t{version}\t{architecture}");
            ensure!(
                packages.iter().any(|package| package["name"] == *name
                    && package["exitCode"] == 0
                    && package["status"] == installed)
                    && helpers
                        .iter()
                        .any(|helper| helper["name"] == *name && helper["exitCode"] == 0),
                "The guest has no verified package/helper completion receipt."
            );
        }
    }
    Ok(guest)
}

struct Carrier<'a> {
    pinned: Transport,
    container_id: Value,
    expected: Option<String>,
    lifetime: &'a Scope,
}

impl<'a> Carrier<'a> {
    async fn resolve(command: &Value, transport: Transport, lifetime: &'a Scope) -> Result<Self> {
        let target = &command["target"];
        let (pinned, container_id) = match transport {
            Transport::Docker(ref name) => {
                let observed = LocalDocker::current(lifetime)
                    .await?
                    .record(name, lifetime)
                    .await?;
                let id = checked("cantripOsPackageShaSchema", observed["Id"].clone())?;
                ensure!(
                    target.is_null() || target["containerId"] == id,
                    "The selected Docker instance was replaced; no replacement was used."
                );
                let pinned =
                    Transport::Docker(id.as_str().context("Docker package target")?.to_owned());
                (pinned, id)
            }
            Transport::Ssh { .. } => {
                ensure!(
                    target["containerId"].is_null(),
                    "A Docker package target cannot use SSH."
                );
                (transport, Value::Null)
            }
        };
        let expected = (!target.is_null()).then(|| target["expected"].stringify());
        Ok(Self {
            pinned,
            container_id,
            expected,
            lifetime,
        })
    }

    async fn control(&self, action: &[&str], input: Option<File>) -> Result<Value> {
        let mut arguments = vec!["-c", RESCUE];
        if let Some(expected) = &self.expected {
            arguments.extend(["--expect", expected]);
        }
        arguments.extend_from_slice(action);
        let (program, args) = self.pinned.spec(Program::Python, &arguments);
        let result = self
            .lifetime
            .capture_file(program, &args, 4 * 1024 * 1024, input)
            .await
            .map_err(|error| DeliveryUnknown(format!("Package carrier failed: {error}")))?;
        if result.code != Some(0) || result.overflow.is_some() {
            let tail = &result.stderr[result.stderr.len().saturating_sub(16384)..];
            let diagnostic = String::from_utf8_lossy(tail);
            return Err(DeliveryUnknown(format!(
                "Package carrier ended {}: {}",
                result
                    .code
                    .map_or_else(|| "without status".into(), |code| code.to_string()),
                if result.overflow.is_some() {
                    "response exceeds limit"
                } else {
                    diagnostic.trim()
                },
            ))
            .into());
        }
        parse_json_text(&String::from_utf8_lossy(&result.stdout)).map_err(|_| {
            DeliveryUnknown("Package carrier returned no verified JSON outcome.".into()).into()
        })
    }
}

impl Manager {
    pub fn new(data: &Path) -> Self {
        Self {
            catalog: Catalog::new(data),
        }
    }

    async fn status(
        &self,
        command: &Value,
        transport: Transport,
        lifetime: &Scope,
    ) -> Result<Value> {
        let carrier = Carrier::resolve(command, transport, lifetime).await?;
        let probe = checked(
            "cantripOsPackageProbeSchema",
            carrier.control(&["probe"], None).await?,
        )?;
        let scope = &command["scope"];
        let expected = &probe["expected"];
        ensure!(
            ["guestInstanceId", "ownerId", "workerId"]
                .into_iter()
                .all(|field| expected[field] == scope[field]),
            "The actual package target belongs to a different OS or attachment."
        );
        let target = &command["target"];
        let same = !target.is_null()
            && target["containerId"] == carrier.container_id
            && ["expected", "bootId", "initStart", "architecture"]
                .into_iter()
                .all(|field| target[field] == probe[field]);
        let generation = if same {
            target["generation"].clone()
        } else {
            json!(Uuid::new_v4().to_string())
        };
        let catalog = self.catalog.clone();
        let scope = lifetime.clone();
        let (available, unavailable) =
            tokio::task::spawn_blocking(move || catalog.list(&scope)).await??;
        let installed: Vec<_> = probe["packages"].as_array().context("Package status list")?.iter()
            .map(|item| json!({"name":item["name"],"exitCode":item["exitCode"],"status":item["status"]}))
            .collect();
        checked(
            "cantripOsPackageCatalogResultSchema",
            json!({"target":json!({"generation":generation,"expected":expected,"bootId":probe["bootId"],
                "initStart":probe["initStart"],"architecture":probe["architecture"],"containerId":carrier.container_id}),
                "available":available,"unavailable":unavailable,"installed":installed}),
        )
    }

    pub async fn execute(
        &self,
        operations: &Operations,
        command: &Value,
        encryption: &Service,
        lifetime: &Scope,
    ) -> Result<Value> {
        let command = checked("cantripOsPackageWorkerCommandSchema", command.clone())?;
        let scope = &command["scope"];
        account(scope, encryption)?;
        let expected = &command["target"]["expected"];
        ensure!(
            expected.is_null()
                || ["guestInstanceId", "ownerId", "workerId"]
                    .into_iter()
                    .all(|field| expected[field] == scope[field]),
            "The package target does not match its owning admission."
        );
        let transport = Transport::from_value(&command["transport"])?;
        let lock = match &transport {
            Transport::Docker(name) => name.clone(),
            Transport::Ssh {
                host, port, user, ..
            } => format!("ssh:{host}:{port}:{user}"),
        };
        let _locked = InstanceLock::acquire(&lock, lifetime).await?;
        if command["type"] == STATUS {
            return self.status(&command, transport, lifetime).await;
        }
        let request = guest_request(&command)?;
        let mut original = command.clone();
        original["mode"] = json!("execute");
        let id = text(&command, "operationId")?;
        let record = operations.reconcile_record(
            Admission {
                scope, id, command: OPERATION, body: original.clone(),
                checkpoint: Some(json!({"version":1,"command":original,"phase":"admitted","guest":Value::Null})),
            },
            async |journal, fresh| {
                self.observe_or_dispatch(&command, &original, &request, transport, journal, fresh, lifetime).await
            },
        ).await?;
        checkpoint(&record["checkpoint"], &original)?;
        protection::result(operations, encryption, &command, &request, &record)
    }

    async fn observe_or_dispatch(
        &self,
        command: &Value,
        original: &Value,
        request: &Value,
        transport: Transport,
        journal: &mut Journal<'_>,
        fresh: bool,
        lifetime: &Scope,
    ) -> Result<()> {
        let mut saved = checkpoint(journal.checkpoint(), original)?;
        let mut guest = saved["guest"].clone();
        if !matches!(guest["state"].as_str(), Some("ready" | "failed")) {
            let carrier = Carrier::resolve(command, transport, lifetime).await?;
            let id = text(command, "operationId")?;
            let execute = fresh && command["mode"] == "execute";
            let raw = if execute {
                saved["phase"] = json!("guest-admission-requested");
                journal.set_checkpoint(saved.clone())?;
                carrier
                    .control(&["admit", &request.stringify()], None)
                    .await?
            } else {
                carrier.control(&["inspect", id], None).await?
            };
            guest = verify_guest(command, request, raw)?;
            save_guest(journal, &mut saved, &guest)?;
            if command["mode"] == "abandon" && guest["state"] == "staged" {
                guest = verify_guest(
                    command,
                    request,
                    carrier.control(&["abandon", id], None).await?,
                )?;
            }
            if (execute || command["mode"] == "continue") && guest["state"] == "staged" {
                for artifact in command["packages"]
                    .as_array()
                    .context("Admitted packages")?
                {
                    let hash = text(artifact, "sha256")?;
                    if guest["received"]
                        .as_array()
                        .context("Guest received packages")?
                        .iter()
                        .any(|item| item == hash)
                    {
                        continue;
                    }
                    let catalog = self.catalog.clone();
                    let artifact = artifact.clone();
                    let scope = lifetime.clone();
                    let file = tokio::task::spawn_blocking(move || catalog.file(&artifact, &scope))
                        .await??;
                    saved["phase"] = json!("artifact-transfer-requested");
                    journal.set_checkpoint(saved.clone())?;
                    let raw = carrier.control(&["receive", id, hash], Some(file)).await?;
                    guest = verify_guest(command, request, raw)?;
                    save_guest(journal, &mut saved, &guest)?;
                }
                saved["phase"] = json!("start-requested");
                journal.set_checkpoint(saved.clone())?;
                guest = verify_guest(
                    command,
                    request,
                    carrier.control(&["start", id], None).await?,
                )?;
            }
        }
        let guest = verify_guest(command, request, guest)?;
        save_guest(journal, &mut saved, &guest)?;
        let state = text(&guest, "state")?;
        journal.outcome(
            if state == "staged" { "unknown" } else { state },
            Value::Null,
            guest["error"].clone(),
        );
        Ok(())
    }
}

fn checkpoint(saved: &Value, original: &Value) -> Result<Value> {
    ensure!(
        saved["version"] == 1
            && &saved["command"] == original
            && saved["phase"]
                .as_js_string()
                .is_some_and(|phase| (1..=200).contains(&phase.len())),
        "The saved package operation belongs to a different original admission."
    );
    Ok(saved.clone())
}

fn save_guest(journal: &mut Journal<'_>, checkpoint: &mut Value, guest: &Value) -> Result<()> {
    checkpoint["guest"] = guest.clone();
    checkpoint["phase"] = guest["phase"].clone();
    journal.set_checkpoint(checkpoint.clone())
}
