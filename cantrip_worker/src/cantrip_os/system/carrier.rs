//! Durable Docker capture, with the existing worker and CLI journal format.
use super::{account, checked, image};
use crate::{
    cantrip_os::{
        docker::{ImageExport, LocalDocker, segment},
        lock::InstanceLock,
        operations::{digest, now, save},
        text,
    },
    encryption::Service,
    filesystem::Scope,
};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_wire::{Value, value::json};
use hyper::Method;
use std::{collections::BTreeSet, path::Path, time::Duration};

const FORMAT: &str = "cantrip-os-system-checkpoint";
const CAPTURE_LIMIT: Duration = Duration::from_secs(300);
const OBSERVED: &str = "Original effect observed. Explicit continuation can perform only the remaining unrequested steps.";

pub(super) struct Capture<'a> {
    pub path: &'a Path,
    pub context: &'a Value,
    pub admission: &'a Value,
    pub encryption: &'a Service,
    pub lifetime: &'a Scope,
}

impl Capture<'_> {
    fn active(&self) -> Result<()> {
        self.lifetime.check()?;
        account(self.context, self.encryption)
    }

    fn request(&self) -> Value {
        json!({"operationId":self.context["operationId"],"container":self.admission["container"],
            "expectedContainerId":self.context["containerId"],"instanceId":self.context["instanceId"],
            "scopeKey":digest(self.context.clone()),"resumeOriginal":self.admission["resumeOriginal"]})
    }

    fn save(&self, record: &mut Value, exclusive: bool) -> Result<()> {
        self.active()?;
        record["updatedAt"] = json!(now());
        save(self.path, record, exclusive)
    }

    fn load(&self, request: &Value) -> Result<Option<Value>> {
        let Some(record) = super::load_record(self.path)? else {
            return Ok(None);
        };
        let phase = text(&record, "phase")?;
        let before = &record["before"];
        let snapshot = &record["snapshot"];
        let resume = request["resumeOriginal"] == true && before["State"]["Running"] == true;
        let resume_evidence_ok = if resume {
            matches!(
                record["resumeEvidence"].as_str(),
                Some("acknowledged-and-observed" | "observed-state")
            )
        } else {
            record["resumeEvidence"] == "not-requested"
        };
        ensure!(
            record["format"] == FORMAT
                && record["version"].as_i64() == Some(1)
                && &record["request"] == request
                && record["requestSha256"] == digest(request.clone())
                && matches!(
                    phase,
                    "reserved"
                        | "stop-requested"
                        | "stopped"
                        | "commit-requested"
                        | "captured"
                        | "resume-requested"
                        | "complete"
                )
                && matches!(
                    record["state"].as_str(),
                    Some("running" | "ready" | "failed" | "unknown")
                )
                && (phase == "reserved" || before.is_object())
                && (record["state"] != "ready"
                    || (phase == "complete" && snapshot.is_object() && resume_evidence_ok)),
            "The system checkpoint journal changed or belongs to another admission; state was preserved."
        );
        if before.is_object() {
            check_container(before, request)?;
        }
        if !snapshot.is_null() {
            checked("cantripOsSystemSnapshotSchema", snapshot.clone())?;
            ensure!(
                snapshot["requestSha256"] == record["requestSha256"]
                    && snapshot["instanceId"] == request["instanceId"]
                    && snapshot["sourceContainerId"] == request["expectedContainerId"],
                "The checkpoint snapshot belongs to a different admission."
            );
        }
        Ok(Some(record))
    }

    pub async fn run(&self, allow_effects: bool) -> Result<Option<Value>> {
        let request = self.request();
        let container = text(&request, "container")?;
        let id = text(&request, "expectedContainerId")?;
        let _name_lock = InstanceLock::acquire(container, self.lifetime).await?;
        // A name may itself equal its full Docker ID.
        let _id_lock = if container == id {
            None
        } else {
            Some(InstanceLock::acquire(id, self.lifetime).await?)
        };
        self.active()?;
        let saved = self.load(&request)?;
        if saved.is_none() && !allow_effects {
            return Ok(None);
        }
        let engine = LocalDocker::current(self.lifetime).await?;
        let mut record = if let Some(saved) = saved {
            saved
        } else {
            let at = now();
            let mut reserved = json!({"format":FORMAT,"version":1,"request":request,
                "requestSha256":digest(request.clone()),"state":"running","phase":"reserved","createdAt":at,
                "updatedAt":at,"before":Value::Null,"snapshot":Value::Null,"resumeEvidence":Value::Null,
                "error":Value::Null,"lastError":Value::Null});
            self.save(&mut reserved, true)?;
            reserved
        };
        let mut observation_error = self.observe(&engine, &mut record).await?;
        if allow_effects
            && !terminal(&record)
            && matches!(
                record["phase"].as_str(),
                Some("reserved" | "stopped" | "captured")
            )
        {
            if let Err(error) = self.advance(&engine, &mut record).await {
                record["state"] = if record["phase"] == "reserved" {
                    json!("failed")
                } else {
                    json!("unknown")
                };
                record["error"] = json!(error.to_string());
                record["lastError"] = record["error"].clone();
                self.save(&mut record, false)?;
            }
            observation_error = self.observe(&engine, &mut record).await?;
        }
        if record["error"].is_null() {
            record["error"] = observation_error;
        }
        Ok(Some(record))
    }

    async fn observe(&self, engine: &LocalDocker, record: &mut Value) -> Result<Value> {
        if terminal(record) {
            return Ok(Value::Null);
        }
        let request = &record["request"];
        let id = text(request, "expectedContainerId")?;
        let mut observation_error = Value::Null;
        let observed = match engine.record(id, self.lifetime).await.and_then(|actual| {
            check_container(&actual, request)?;
            Ok(actual)
        }) {
            Ok(actual) => actual,
            Err(error) => {
                observation_error = json!(error.to_string());
                Value::Null
            }
        };
        let mut updated = record.clone();
        match record["phase"].as_str() {
            Some("stop-requested") if observed["State"]["Running"] == false => {
                updated["phase"] = json!("stopped");
            }
            Some("commit-requested") => match self.recover_image(engine, record).await {
                Ok(Some(actual)) => {
                    updated["snapshot"] = snapshot(record, &actual, "observed-labeled-image")?;
                    updated["phase"] = json!("captured");
                }
                Ok(None) => {}
                Err(error) => observation_error = json!(error.to_string()),
            },
            Some("resume-requested")
                if observed["State"]["Running"] == true && record["snapshot"].is_object() =>
            {
                complete(&mut updated, "observed-state");
            }
            _ => {}
        }
        if updated["phase"] == "captured" && !should_resume(&updated) {
            complete(&mut updated, "not-requested");
        }
        if updated != *record {
            if updated["state"] != "ready" {
                updated["state"] = json!("unknown");
                updated["error"] = json!(OBSERVED);
            }
            self.save(&mut updated, false)?;
            *record = updated;
        }
        Ok(observation_error)
    }

    async fn recover_image(&self, engine: &LocalDocker, record: &Value) -> Result<Option<Value>> {
        let selected = labels(record);
        let filters = selected
            .as_object()
            .context("System image labels")?
            .iter()
            .map(|(key, value)| {
                Ok(json!(format!(
                    "{}={}",
                    key.lossy(),
                    value.as_str().context("Image label")?
                )))
            })
            .collect::<Result<Vec<_>>>()?;
        let filter = json!({"label":filters}).stringify();
        let reply = engine
            .request(
                Method::GET,
                &format!("/images/json?all=1&filters={}", segment(&filter)),
                None,
                CAPTURE_LIMIT,
                self.lifetime,
            )
            .await?;
        let ids = reply
            .as_array()
            .context("Docker returned no image catalogue.")?
            .iter()
            .map(|candidate| text(candidate, "Id"))
            .collect::<Result<BTreeSet<_>>>()?;
        ensure!(
            ids.len() <= 1,
            "More than one image claims the original checkpoint; no image was selected."
        );
        let Some(id) = ids.first() else {
            return Ok(None);
        };
        Ok(Some(self.inspect_image(engine, id, record).await?))
    }

    async fn inspect_image(&self, engine: &LocalDocker, id: &str, record: &Value) -> Result<Value> {
        let actual = image(engine, id, self.lifetime).await?;
        let wanted = labels(record);
        let config = &actual["Config"]["Labels"];
        ensure!(
            actual["Id"] == id
                && actual["Os"] == "linux"
                && actual["RootFS"]["Layers"].is_array()
                && wanted.as_object().context("System image labels")?.iter().all(|(key, value)|
                    key.as_str().and_then(|key| config.get(key)) == Some(value)),
            "The system image does not match the original checkpoint admission."
        );
        Ok(actual)
    }

    async fn advance(&self, engine: &LocalDocker, record: &mut Value) -> Result<()> {
        let request = record["request"].clone();
        let id = text(&request, "expectedContainerId")?;
        if record["phase"] == "reserved" {
            let before = engine
                .record(text(&request, "container")?, self.lifetime)
                .await?;
            check_container(&before, &request)?;
            record["before"] = before;
            self.save(record, false)?;
            if record["before"]["State"]["Running"] == true {
                record["phase"] = json!("stop-requested");
                self.save(record, false)?;
                engine
                    .request(
                        Method::POST,
                        &format!("/containers/{id}/stop?t=20"),
                        None,
                        CAPTURE_LIMIT,
                        self.lifetime,
                    )
                    .await?;
            }
            self.assert_stopped(engine, &request, id).await?;
            record["phase"] = json!("stopped");
            self.save(record, false)?;
        }
        if record["phase"] == "stopped" {
            self.assert_stopped(engine, &request, id).await?;
            let mut config = record["before"]["Config"].clone();
            for (label, value) in labels(record).as_object().context("System image labels")? {
                config["Labels"][label.as_str().context("System image label")?] = value.clone();
            }
            record["phase"] = json!("commit-requested");
            self.save(record, false)?;
            let tag = text(&request, "operationId")?;
            let reply = engine
                .request(
                    Method::POST,
                    &format!(
                        "/commit?container={id}&pause=true&repo=cantrip-os-private-system&tag={}",
                        segment(tag)
                    ),
                    Some(&config),
                    CAPTURE_LIMIT,
                    self.lifetime,
                )
                .await?;
            let actual = self
                .inspect_image(engine, text(&reply, "Id")?, record)
                .await?;
            record["snapshot"] = snapshot(record, &actual, "acknowledged-and-verified")?;
            record["phase"] = json!("captured");
            self.save(record, false)?;
        }
        if record["phase"] == "captured" {
            self.inspect_image(engine, text(&record["snapshot"], "imageId")?, record)
                .await?;
            if should_resume(record) {
                record["phase"] = json!("resume-requested");
                self.save(record, false)?;
                engine
                    .request(
                        Method::POST,
                        &format!("/containers/{id}/start"),
                        None,
                        CAPTURE_LIMIT,
                        self.lifetime,
                    )
                    .await?;
                let actual = engine.record(id, self.lifetime).await?;
                check_container(&actual, &request)?;
                ensure!(
                    actual["State"]["Running"] == true,
                    "The captured original has not resumed."
                );
                complete(record, "acknowledged-and-observed");
            } else {
                complete(record, "not-requested");
            }
            self.save(record, false)?;
        }
        Ok(())
    }

    async fn assert_stopped(&self, engine: &LocalDocker, request: &Value, id: &str) -> Result<()> {
        let actual = engine.record(id, self.lifetime).await?;
        check_container(&actual, request)?;
        ensure!(
            actual["State"]["Running"] == false,
            "The original container is still running; its system image was not captured."
        );
        Ok(())
    }

    pub async fn export(&self) -> Result<ImageExport> {
        self.active()?;
        let record = self
            .load(&self.request())?
            .context("No verified system image is recorded for this original operation.")?;
        let id = text(&record["snapshot"], "imageId")?;
        let engine = LocalDocker::current(self.lifetime).await?;
        self.inspect_image(&engine, id, &record).await?;
        engine.export_image(id, self.lifetime).await
    }
}

fn terminal(record: &Value) -> bool {
    matches!(record["state"].as_str(), Some("ready" | "failed"))
}

fn should_resume(record: &Value) -> bool {
    record["request"]["resumeOriginal"] == true && record["before"]["State"]["Running"] == true
}

fn complete(record: &mut Value, evidence: &str) {
    record["phase"] = json!("complete");
    record["state"] = json!("ready");
    record["resumeEvidence"] = json!(evidence);
    record["error"] = Value::Null;
}

fn check_container(actual: &Value, request: &Value) -> Result<()> {
    ensure!(
        actual["Id"] == request["expectedContainerId"]
            && actual["Config"]["Labels"]["io.cantrip.os"] == "foundation"
            && actual["State"]["Running"].is_boolean(),
        "The exact CantripOS foundation container could not be verified; no replacement was selected."
    );
    Ok(())
}

fn labels(record: &Value) -> Value {
    json!({"io.cantrip.os.system.operation": record["request"]["operationId"],
        "io.cantrip.os.system.request": record["requestSha256"],
        "io.cantrip.os.system.container": record["request"]["expectedContainerId"],
        "io.cantrip.os.system.instance": record["request"]["instanceId"]})
}

fn snapshot(record: &Value, image: &Value, evidence: &str) -> Result<Value> {
    let before = &record["before"];
    let mounts = match &before["Mounts"] {
        Value::Array(mounts) => mounts
            .iter()
            .map(|mount| {
                let source = mount
                    .get("Name")
                    .filter(|name| !name.is_null())
                    .unwrap_or(&mount["Source"]);
                json!({"type":mount["Type"],"source":source,"destination":mount["Destination"],
                "readOnly":mount["RW"] != true,"included":false})
            })
            .collect(),
        Value::Null => Vec::new(),
        _ => return Err(anyhow!("Docker reported invalid mount metadata.")),
    };
    checked(
        "cantripOsSystemSnapshotSchema",
        json!({
            "format":"cantrip-os-private-system-image","version":1,"imageId":image["Id"],
            "requestSha256":record["requestSha256"],"instanceId":record["request"]["instanceId"],
            "sourceContainerId":before["Id"],"sourceBaseImageId":before["Image"],
            "architecture":image["Architecture"],"os":image["Os"],"createdAt":image["Created"],"size":image["Size"],
            "evidence":evidence,"consistency":"stopped-container-filesystem","containsPrivateIdentity":true,
            "identityPolicy":"same-instance-only","runtimeHandlesRestored":false,"mounts":Value::Array(mounts),
            "regeneratedPaths":["/etc/hosts","/etc/hostname","/etc/resolv.conf"]
        }),
    )
}
