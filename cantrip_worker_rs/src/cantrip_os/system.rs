//! Owned Cantrip OS system discovery and operations.
mod archive;
mod carrier;
mod checkpoints;
mod identity;
mod jobs;

use super::{
    checked,
    docker::{LocalDocker, segment},
    operations::scope_key,
    text,
};
use crate::{
    encryption::{ComponentKey, Service},
    filesystem::Scope,
};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_wire::{Value, parse_json_text, value::json};
use hyper::Method;
use std::{
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

pub(super) const STATUS: &str = "cantrip-os.system.status";
pub(super) const CAPTURE: &str = "cantrip-os.system.capture";
const STATUS_SCHEMA: &str = "cantripOsSystemStatusResultSchema";
const TARGET_SCHEMA: &str = "cantripOsSystemTargetSchema";
const MAX_JOB: u64 = 48 * 1024 * 1024;

pub(super) struct Manager {
    data: PathBuf,
}

fn account(scope: &Value, encryption: &Service) -> Result<()> {
    let (owner, server) = encryption.bound_identity()?;
    check_account(scope, encryption, &owner, &server)
}

fn check_account(
    scope: &Value,
    encryption: &Service,
    owner: &cantrip_wire::JsString,
    server: &Value,
) -> Result<()> {
    ensure!(
        scope["ownerId"].as_js_string() == Some(owner)
            && &scope["serverId"] == server
            && scope["workerId"].as_js_string() == Some(encryption.worker_id()),
        "The system operation belongs to another Worker, account or Server"
    );
    Ok(())
}

fn key(scope: &Value, encryption: &Service, revision: Option<u64>) -> Result<ComponentKey> {
    let bound = encryption.bound_component("repository-content", revision)?;
    check_account(scope, encryption, &bound.owner_id, &bound.server_id)?;
    Ok(bound.component)
}

fn same_placement(first: &Value, second: &Value) -> bool {
    ["ownerId", "workerId", "guestInstanceId"]
        .into_iter()
        .all(|field| first[field] == second[field])
}

fn private_labels(labels: &Value) -> bool {
    labels.as_object().is_some_and(|object| {
        object.keys().any(|key| {
            let key = key.lossy();
            key == "io.cantrip.os.source-mounts"
                || key.starts_with("io.cantrip.os.system.")
                || key.starts_with("io.cantrip.os.replacement.")
        })
    })
}

async fn image(engine: &LocalDocker, id: &str, lifetime: &Scope) -> Result<Value> {
    engine
        .request(
            Method::GET,
            &format!("/images/{}/json", segment(id)),
            None,
            Duration::from_secs(60),
            lifetime,
        )
        .await
}

async fn base_images(engine: &LocalDocker, lifetime: &Scope) -> Result<(Vec<Value>, bool)> {
    let filter = r#"{"label":["io.cantrip.os=foundation"]}"#;
    let images = engine
        .request(
            Method::GET,
            &format!("/images/json?filters={}", segment(filter)),
            None,
            Duration::from_secs(60),
            lifetime,
        )
        .await?;
    let mut incomplete = false;
    let mut bases = Vec::new();
    for listed in images
        .as_array()
        .context("Invalid Docker image list")?
        .iter()
        .take(256)
    {
        if private_labels(&listed["Labels"]) {
            continue;
        }
        let inspected = async {
            let actual = image(engine, text(listed, "Id")?, lifetime).await?;
            let labels = &actual["Config"]["Labels"];
            if actual["Os"] != "linux" || labels["io.cantrip.os"] != "foundation" || private_labels(labels) {
                return Ok::<_, anyhow::Error>(None);
            }
            let tags = listed["RepoTags"]
                .as_array()
                .map(|tags| tags.iter().take(100).cloned().collect())
                .unwrap_or_default();
            Ok(Some(json!({"imageId":actual["Id"],"architecture":actual["Architecture"],"tags":Value::Array(tags)})))
        }.await;
        match inspected {
            Ok(Some(base)) => bases.push(base),
            Ok(None) => {}
            Err(_) => incomplete = true,
        }
    }
    Ok((bases, incomplete))
}

fn replacement(data: &Path, scope: &Value, recovery: &Value, id: &Value) -> Result<Value> {
    let original_scope = &recovery["scope"];
    ensure!(
        ["ownerId", "serverId", "workerId", "instanceId"]
            .into_iter()
            .all(|field| scope[field] == original_scope[field]),
        "The system source belongs to another owning instance"
    );
    let operation = text(recovery, "operationId")?;
    let path = data
        .join("cantrip-os-system-jobs")
        .join(scope_key(original_scope))
        .join(format!("{operation}.json"));
    let unavailable =
        || anyhow!("No completed original system operation authorizes replacement discovery");
    let record = load_record(&path)?.ok_or_else(unavailable)?;
    let command = checked(
        "cantripOsSystemOperationCommandSchema",
        record["command"].clone(),
    )?;
    ensure!(
        &command["scope"] == original_scope
            && command["operationId"] == recovery["operationId"]
            && command["target"]["generation"] == recovery["targetGeneration"],
        "The system journal belongs to another original admission"
    );
    let root = checked("cantripOsSystemRootReceiptSchema", record["root"].clone())
        .map_err(|_| unavailable())?;
    ensure!(
        record["version"].as_i64() == Some(1)
            && record["state"] == "ready"
            && command["action"] != "capture"
            && &root["targetContainerId"] == id,
        "{unavailable_msg}",
        unavailable_msg = unavailable()
    );
    Ok(command)
}

fn load_record(path: &Path) -> Result<Option<Value>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut body = String::new();
    file.take(MAX_JOB + 1).read_to_string(&mut body)?;
    ensure!(
        body.len() as u64 <= MAX_JOB,
        "The system journal exceeds its size limit"
    );
    let record = parse_json_text(&body).map_err(|_| anyhow!("The system journal is invalid"))?;
    Ok(Some(record))
}

async fn target(
    engine: &LocalDocker,
    actual: &Value,
    scope: &Value,
    previous: &Value,
    allow_changed_guest: bool,
    lifetime: &Scope,
) -> Result<Value> {
    let id = text(actual, "Id")?;
    let name = text(actual, "Name")?
        .strip_prefix('/')
        .context("Invalid Docker container name")?;
    ensure!(
        checked("cantripOsPackageShaSchema", actual["Id"].clone()).is_ok()
            && actual["Config"]["Labels"]["io.cantrip.os"] == "foundation",
        "The exact CantripOS Docker target is unavailable"
    );
    let prior = (previous["containerId"] == actual["Id"]
        && previous["containerName"] == name
        && previous["expected"]["ownerId"] == scope["ownerId"]
        && previous["expected"]["workerId"] == scope["workerId"]
        && (allow_changed_guest || same_placement(&previous["expected"], scope)))
    .then_some(&previous["expected"]);
    let current = identity::current(
        engine,
        id,
        prior.and_then(|value| value["identityPath"].as_str()),
        lifetime,
    )
    .await;
    let (expected, evidence) = match current {
        Ok(current) => {
            ensure!(
                current.attachment["owner_id"] == scope["ownerId"]
                    && current.attachment["worker_id"] == scope["workerId"]
                    && (allow_changed_guest || current.id == scope["guestInstanceId"]),
                "The system target's persistent owner/Worker/guest identity changed"
            );
            (
                json!({"guestInstanceId":current.id,"ownerId":scope["ownerId"],"workerId":scope["workerId"],"identityPath":current.path}),
                "guest-identity",
            )
        }
        Err(error) => (prior.ok_or(error)?.clone(), "retained-container"),
    };
    lifetime.check()?;
    let architecture = image(engine, text(actual, "Image")?, lifetime)
        .await
        .map(|actual| actual["Architecture"].clone())
        .unwrap_or(Value::Null);
    lifetime.check()?;
    let generation = if previous["containerId"] == actual["Id"]
        && previous["containerName"] == name
        && previous["imageId"] == actual["Image"]
        && same_placement(&previous["expected"], &expected)
    {
        previous["generation"].clone()
    } else {
        json!(Uuid::new_v4().to_string())
    };
    checked(
        TARGET_SCHEMA,
        json!({"generation":generation,"expected":expected,
        "containerId":id,"containerName":name,"imageId":actual["Image"],"architecture":architecture,
        "identityEvidence":evidence}),
    )
}

impl Manager {
    pub fn new(data: &Path) -> Self {
        Self {
            data: data.to_owned(),
        }
    }

    pub async fn status(
        &self,
        raw: &Value,
        encryption: &Service,
        lifetime: &Scope,
    ) -> Result<Value> {
        let command = checked("cantripOsSystemWorkerCommandSchema", raw.clone())?;
        let scope = &command["scope"];
        account(scope, encryption)?;
        if command["transport"]["kind"] != "docker" {
            return checked(
                STATUS_SCHEMA,
                json!({"supported":false,"target":Value::Null,"bases":Vec::<Value>::new(),"running":Value::Null,
                "error":"System image management requires an authorized Docker management path. SSH alone does not supply it."}),
            );
        }
        let engine = LocalDocker::current(lifetime).await?;
        let actual = engine
            .record(text(&command["transport"], "container")?, lifetime)
            .await?;
        let running = &actual["State"]["Running"];
        let recovery = &command["recovery"];
        if !recovery.is_null() {
            let original = replacement(&self.data, scope, recovery, &actual["Id"])?;
            if let Ok(current) = identity::current(
                &engine,
                text(&actual, "Id")?,
                original["target"]["expected"]["identityPath"].as_str(),
                lifetime,
            )
            .await
                && current.attachment.is_null()
            {
                account(scope, encryption)?;
                return checked(
                    STATUS_SCHEMA,
                    json!({"supported":true,"target":Value::Null,"bases":Vec::<Value>::new(),"running":running,
                    "enrollment":json!({"containerId":actual["Id"],"guestInstanceId":current.id}),
                    "error":"The resulting system is unattached. Explicit recovery can assign it to the owning Worker."}),
                );
            }
        }
        let target = target(
            &engine,
            &actual,
            scope,
            &command["target"],
            !recovery.is_null(),
            lifetime,
        )
        .await?;
        let (bases, error) = match base_images(&engine, lifetime).await {
            Ok((bases, false)) => (bases, Value::Null),
            Ok((bases, true)) => (
                bases,
                json!(
                    "Some base image metadata is unavailable; the current management target was still verified."
                ),
            ),
            Err(_) => (
                Vec::new(),
                json!(
                    "Base images could not be listed; the current management target was still verified."
                ),
            ),
        };
        lifetime.check()?;
        account(scope, encryption)?;
        checked(
            STATUS_SCHEMA,
            json!({"supported":true,"target":target,"running":running,"bases":bases,"error":error}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cantrip_os::operations::save;

    #[test]
    fn authorizes_only_the_completed_legacy_replacement_on_its_exact_target() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let uuid = || Uuid::new_v4().to_string();
        let scope = json!({"ownerId":"owner","workerId":"worker","serverId":"server",
            "instanceId":uuid(),"guestInstanceId":uuid(),"attachmentGeneration":uuid()});
        let recovery = json!({"scope":scope,"operationId":uuid(),"targetGeneration":uuid()});
        let old_id = "a".repeat(64);
        let target_id = json!("b".repeat(64));
        let image_id = format!("sha256:{}", "c".repeat(64));
        let expected = json!({"guestInstanceId":scope["guestInstanceId"],"ownerId":scope["ownerId"],
            "workerId":scope["workerId"],"identityPath":"/var/lib/cantrip-os-executor/instance.json"});
        let target = json!({"generation":recovery["targetGeneration"], "containerId":old_id,
            "containerName":"existing-guest","imageId":image_id,"architecture":"arm64",
            "expected":expected,"identityEvidence":"guest-identity"});
        let command = json!({"scope":scope,"type":"cantrip-os.system.replace","action":"replace",
            "mode":"execute","operationId":recovery["operationId"],"target":target,
            "transport":json!({"kind":"docker","container":"existing-guest"}),
            "source":json!({"kind":"base","imageId":image_id}),"startTarget":true});
        let root = json!({"requestSha256":"d".repeat(64),"originalContainerId":old_id,
            "targetContainerId":target_id,"retainedContainerId":old_id,"runtimeHandlesRestored":false,
            "guestInstanceId":uuid(),"guestAttachment":"unattached"});
        let mut record = json!({"version":1,"state":"ready","phase":"complete","command":command,
            "startedAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:01.000Z",
            "validated":true,"captureRequested":false,"hostRequested":true,"capture":Value::Null,
            "stage":Value::Null,"host":Value::Null,"root":root,"protectedResult":Value::Null,
            "diagnostic":Value::Null});
        let file = dir
            .path()
            .join("cantrip-os-system-jobs")
            .join(scope_key(&scope))
            .join(format!("{}.json", text(&recovery, "operationId")?));
        save(&file, &record, true)?;
        assert_eq!(
            replacement(dir.path(), &scope, &recovery, &target_id)?,
            command
        );
        assert!(replacement(dir.path(), &scope, &recovery, &json!(old_id)).is_err());
        let mut wrong_scope = scope.clone();
        wrong_scope["ownerId"] = json!("foreign");
        assert!(replacement(dir.path(), &wrong_scope, &recovery, &target_id).is_err());
        record["state"] = json!("unknown");
        save(&file, &record, false)?;
        assert!(replacement(dir.path(), &scope, &recovery, &target_id).is_err());
        Ok(())
    }
}
