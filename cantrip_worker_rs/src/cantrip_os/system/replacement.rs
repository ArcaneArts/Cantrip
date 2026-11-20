//! Durable replacement and rollback of the exact retained system containers.
mod config;
mod image;

use super::{account, load_record};
use crate::{
    cantrip_os::{
        docker::{DockerApiError, LocalDocker, segment},
        lock::InstanceLock,
        operations::{digest, now, save},
        replacement::check_original,
        text,
    },
    encryption::Service,
    filesystem::Scope,
};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_wire::{
    Value,
    value::{Object, json},
};
use hyper::Method;
use std::{path::Path, time::Duration};

const FORMAT: &str = "cantrip-os-retained-system-replacement";
const LIMIT: Duration = Duration::from_secs(300);

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Mode {
    Observe,
    Execute,
    Continue,
}

#[derive(Debug)]
struct Refused(String);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Refused {}

pub(super) struct Replacement<'a> {
    pub journal: &'a Path,
    pub prior: Option<&'a Path>,
    pub request: &'a Value,
    pub owner: &'a Value,
    pub engine: &'a LocalDocker,
    pub encryption: &'a Service,
    pub lifetime: &'a Scope,
}

enum Transition<'a> {
    Policy(&'a str, &'a Value),
    Stop(&'a str),
    Create,
    Rename(&'a str, &'a str),
    Start(&'a str),
}

impl Replacement<'_> {
    fn active(&self) -> Result<()> {
        self.lifetime.check()?;
        account(self.owner, self.encryption)
    }

    fn save(&self, record: &mut Value, exclusive: bool) -> Result<()> {
        self.active()?;
        record["updatedAt"] = json!(now());
        save(self.journal, record, exclusive)
    }

    fn validated(record: &Value, request: &Value) -> Result<()> {
        ensure!(
            record["format"] == FORMAT
                && record["version"].as_u64() == Some(1)
                && &record["request"] == request
                && record["requestSha256"] == digest(request.clone())
                && matches!(
                    record["state"].as_str(),
                    Some("running" | "ready" | "failed" | "unknown")
                )
                && record["steps"].is_object()
                && (record["retireId"].is_null() || container_id(&record["retireId"]))
                && (record["targetId"].is_null() || container_id(&record["targetId"]))
                && (record["state"] != "ready"
                    || (record["phase"] == "complete"
                        && record["prepared"] == true
                        && container_id(&record["targetId"]))),
            "The system replacement journal changed; retained state was preserved."
        );
        Ok(())
    }

    async fn call(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Value> {
        self.active()?;
        self.engine
            .request(method, path, body, LIMIT, self.lifetime)
            .await
    }

    async fn inspect(&self, id: &str) -> Result<Value> {
        let actual = self.engine.record(id, self.lifetime).await?;
        ensure!(
            actual["Id"] == id
                && actual["Config"]["Labels"]["io.cantrip.os"] == "foundation"
                && actual["State"]["Running"].is_boolean()
                && actual["Name"].is_string(),
            "The exact CantripOS container could not be verified; no replacement was selected."
        );
        Ok(actual)
    }

    async fn inspect_record_id(&self, record: &Value, field: &str) -> Result<Value> {
        self.inspect(text(record, field)?).await
    }

    async fn candidate(&self, record: &mut Value, activation: bool) -> Result<Option<Value>> {
        let expected = labels(record);
        let id = if let Some(id) = record["targetId"].as_str() {
            id.to_owned()
        } else {
            let filters = expected
                .as_object()
                .context("Candidate labels")?
                .iter()
                .map(|(key, value)| {
                    Ok(format!(
                        "{}={}",
                        key.lossy(),
                        value.as_str().context("Candidate label value")?
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            let filter = json!({"label":filters}).stringify();
            let found = self
                .call(
                    Method::GET,
                    &format!("/containers/json?all=1&filters={}", segment(&filter)),
                    None,
                )
                .await?;
            let candidates = found
                .as_array()
                .context("Docker returned no candidate inventory.")?;
            ensure!(
                candidates.len() <= 1,
                "Candidate creation has no unique original proof."
            );
            let Some(candidate) = candidates.first() else {
                return Ok(None);
            };
            text(candidate, "Id")?.to_owned()
        };
        let actual = self.inspect(&id).await?;
        let original = &record["original"];
        let actual_labels = &actual["Config"]["Labels"];
        ensure!(
            container_id(&actual["Id"])
                && (!record["targetId"].is_null()
                    || actual["Name"] == docker_name(record, "candidateName")?)
                && actual["Image"] == record["request"]["source"]["imageId"]
                && expected
                    .as_object()
                    .context("Candidate labels")?
                    .iter()
                    .all(
                        |(key, value)| key.as_str().and_then(|key| actual_labels.get(key))
                            == Some(value)
                    )
                && (!activation || mount_identity(&actual) == mount_identity(original)),
            "The candidate image, admission or retained mounts changed; it was not activated."
        );
        if record["targetId"].is_null() {
            record["targetId"] = actual["Id"].clone();
            self.save(record, false)?;
        }
        Ok(Some(actual))
    }

    async fn prepare(&self, record: &mut Value, mutate: bool) -> Result<bool> {
        if record["prepared"] == true {
            return Ok(true);
        }
        let request = self.request;
        let name = text(request, "container")?;
        if request["action"] == "replace" {
            if record["original"].is_null() {
                let original = self.inspect(text(request, "expectedContainerId")?).await?;
                let selected = self.engine.record(name, self.lifetime).await?;
                check_original(&original, name)?;
                ensure!(
                    selected["Id"] == original["Id"],
                    "The original Docker name selected another container."
                );
                record["retireId"] = original["Id"].clone();
                record["desiredPolicy"] = policy(&original);
                record["original"] = original;
                self.save(record, false)?;
            }
            let Some(image) = self.ensure_image(record, mutate).await? else {
                return Ok(false);
            };
            let previous = self
                .inspect_image(text(&record["original"], "Image")?)
                .await?;
            let configuration = config::build(&record["original"], &previous, &image, request)?;
            record["configurationSha256"] = json!(digest(configuration.clone()));
            record["configuration"] = configuration;
            for (label, value) in labels(record).as_object().context("Candidate labels")? {
                record["configuration"]["Labels"][label.as_str().context("Candidate label")?] =
                    value.clone();
            }
        } else {
            let journal = self
                .prior
                .context("The retained replacement journal is required for rollback.")?;
            let mut source = load_record(journal)?
                .context("The original replacement journal is unavailable.")?;
            let source_request = source["request"].clone();
            Self::validated(&source, &source_request)?;
            ensure!(
                source_request["action"] == "replace"
                    && source_request["operationId"] == request["replacementOperationId"]
                    && source["requestSha256"] == request["replacementRequestSha256"]
                    && source_request["instanceId"] == request["instanceId"]
                    && source_request["container"] == request["container"]
                    && source["original"]["Id"] == request["expectedOriginalId"],
                "Rollback belongs to another original replacement admission."
            );
            let original = self.inspect(text(request, "expectedOriginalId")?).await?;
            // Mount drift can forbid activation while still permitting fencing
            // the same proven replacement during rollback.
            let replacement = if source["configuration"].is_object() {
                let prior = Replacement {
                    journal,
                    request: &source_request,
                    ..*self
                };
                prior
                    .candidate(&mut source, false)
                    .await?
                    .unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            let start = &source["steps"]["start"];
            ensure!(
                !(start["claimed"] == true
                    && start["acknowledged"] != true
                    && start["observed"] != true
                    && start["refused"] != true
                    && !started(&replacement)),
                "The original start is still uncertain; rollback did not admit both identities."
            );
            ensure!(
                original["Name"] == docker_name(request, "container")?
                    || original["Name"] == docker_name(&source, "retainedName")?,
                "The retained original name changed outside its replacement."
            );
            record["original"] = source["original"].clone();
            record["targetId"] = original["Id"].clone();
            record["retireId"] = replacement["Id"].clone();
            record["desiredPolicy"] = policy(&source["original"]);
            record["sourceRequestSha256"] = source["requestSha256"].clone();
        }
        record["prepared"] = json!(true);
        record["phase"] = json!("prepared");
        self.save(record, false)?;
        Ok(true)
    }

    async fn proof(&self, record: &mut Value, transition: &Transition<'_>) -> Result<bool> {
        match *transition {
            Transition::Policy(id, expected) => {
                Ok(policy_equal(&self.inspect(id).await?, expected))
            }
            Transition::Stop(id) => Ok(!running(&self.inspect(id).await?)),
            Transition::Create => Ok(self.candidate(record, true).await?.is_some()),
            Transition::Rename(id, name) => {
                Ok(self.inspect(id).await?["Name"] == format!("/{name}"))
            }
            Transition::Start(id) => {
                let actual = self.inspect(id).await?;
                if !running(&actual)
                    && record["steps"]["start"]["acknowledged"] == true
                    && started(&actual)
                {
                    return Err(Refused("The target exited after start; its retained original remains available for rollback.".into()).into());
                }
                Ok(actual["State"]["Running"] == true)
            }
        }
    }

    async fn apply(&self, record: &mut Value, transition: &Transition<'_>) -> Result<()> {
        match *transition {
            Transition::Policy(id, policy) => {
                self.mutate(id, "update", Some(&json!({"RestartPolicy":policy})))
                    .await
            }
            Transition::Stop(id) => self.mutate(id, "stop?t=20", None).await,
            Transition::Create => {
                let name = text(record, "candidateName")?;
                let created = self
                    .call(
                        Method::POST,
                        &format!("/containers/create?name={}", segment(name)),
                        Some(&record["configuration"]),
                    )
                    .await?;
                ensure!(
                    container_id(&created["Id"]),
                    "Docker did not return the exact candidate identity."
                );
                record["targetId"] = created["Id"].clone();
                Ok(())
            }
            Transition::Rename(id, name) => {
                self.mutate(id, &format!("rename?name={}", segment(name)), None)
                    .await
            }
            Transition::Start(id) => self.mutate(id, "start", None).await,
        }
    }

    async fn step(
        &self,
        record: &mut Value,
        key: &str,
        transition: Transition<'_>,
        mutate: bool,
    ) -> Result<bool> {
        self.active()?;
        if !self.proof(record, &transition).await? {
            if !mutate || record["steps"][key]["claimed"] == true {
                return Ok(false);
            }
            record["steps"][key] = json!({"claimed":true, "acknowledged":false});
            record["phase"] = json!(format!("{key}-requested"));
            self.save(record, false)?;
            if let Err(error) = self.apply(record, &transition).await {
                if error.is::<DockerApiError>() {
                    record["steps"][key]["acknowledged"] = json!(true);
                    record["steps"][key]["refused"] = json!(true);
                    return Err(Refused(error.to_string()).into());
                }
                return Err(error);
            }
            record["steps"][key]["acknowledged"] = json!(true);
            self.save(record, false)?;
            if !self.proof(record, &transition).await? {
                return Ok(false);
            }
        }
        record["steps"][key]["observed"] = json!(true);
        record["phase"] = json!(format!("{key}-verified"));
        self.save(record, false)?;
        Ok(true)
    }

    async fn mutate(&self, id: &str, action: &str, body: Option<&Value>) -> Result<()> {
        self.call(
            Method::POST,
            &format!("/containers/{}/{action}", segment(id)),
            body,
        )
        .await?;
        Ok(())
    }

    async fn advance(&self, record: &mut Value, mutate: bool) -> Result<()> {
        let retire = record["retireId"].as_str().map(str::to_owned);
        let no_restart = config::no_restart();
        if let Some(id) = &retire {
            if !self
                .step(record, "fence", Transition::Policy(id, &no_restart), mutate)
                .await?
                || !self
                    .step(record, "stop", Transition::Stop(id), mutate)
                    .await?
            {
                return Ok(());
            }
        }
        if self.request["action"] == "replace" {
            if !self
                .step(record, "create", Transition::Create, mutate)
                .await?
            {
                return Ok(());
            }
            self.candidate(record, true).await?;
        }
        if let Some(id) = &retire {
            let state = self.inspect(id).await?;
            ensure!(
                !running(&state) && policy_equal(&state, &no_restart),
                "The retired identity is no longer fenced; the replacement was not started."
            );
            let name = text(record, "retainedName")?.to_owned();
            if !self
                .step(
                    record,
                    "rename-retained",
                    Transition::Rename(id, &name),
                    mutate,
                )
                .await?
            {
                return Ok(());
            }
        }
        let name = text(self.request, "container")?;
        let target = text(record, "targetId")?.to_owned();
        if !self
            .step(
                record,
                "rename-target",
                Transition::Rename(&target, name),
                mutate,
            )
            .await?
        {
            return Ok(());
        }
        if self.request["startTarget"] == true
            && !self
                .step(record, "start", Transition::Start(&target), mutate)
                .await?
        {
            return Ok(());
        }
        let desired_policy = record["desiredPolicy"].clone();
        if !self
            .step(
                record,
                "policy",
                Transition::Policy(&target, &desired_policy),
                mutate,
            )
            .await?
        {
            return Ok(());
        }
        if let Some(id) = &retire {
            let actual = self.inspect(id).await?;
            ensure!(
                !running(&actual) && policy_equal(&actual, &no_restart),
                "Both identities could run; no fresh execution authority was issued."
            );
        }
        ensure!(
            self.inspect(&target).await?["Name"] == format!("/{name}"),
            "The active canonical Docker name changed."
        );
        record["state"] = json!("ready");
        record["phase"] = json!("complete");
        record["error"] = Value::Null;
        self.save(record, false)
    }

    pub async fn run(&self, mode: Mode) -> Result<Option<Value>> {
        let request = self.request;
        let name = text(request, "container")?;
        let id = text(
            request,
            if request["action"] == "replace" {
                "expectedContainerId"
            } else {
                "expectedOriginalId"
            },
        )?;
        let _name = InstanceLock::acquire(name, self.lifetime).await?;
        let _physical = if name == id {
            None
        } else {
            Some(InstanceLock::acquire(id, self.lifetime).await?)
        };
        self.active()?;
        let existing = load_record(self.journal)?;
        let fresh = existing.is_none();
        let mut record = match existing {
            Some(record) => {
                Self::validated(&record, request)?;
                record
            }
            None if mode == Mode::Observe => return Ok(None),
            None if mode == Mode::Continue => {
                return Err(anyhow!(
                    "There is no original system replacement admission to continue."
                ));
            }
            None => {
                let at = now();
                let prefix = name.get(..80).unwrap_or(name);
                let suffix = digest(request["operationId"].clone());
                let mut initial = json!({"format":FORMAT,"version":1,"request":request,
                    "requestSha256":digest(request.clone()),"state":"running","phase":"reserved","startedAt":at,
                    "updatedAt":at,"original":Value::Null,"retireId":Value::Null,"targetId":Value::Null,
                    "configuration":Value::Null,"configurationSha256":Value::Null,"desiredPolicy":Value::Null,
                    "prepared":false,"steps":Value::Object(Object::new()),"error":Value::Null,"lastError":Value::Null,
                    "candidateName":format!("{prefix}-next-{}", &suffix[..24]),
                    "retainedName":format!("{prefix}-previous-{}", &suffix[..24])});
                self.save(&mut initial, true)?;
                initial
            }
        };
        if terminal(&record) {
            return Ok(Some(self.result(&record).await));
        }
        let mutate = fresh || mode == Mode::Continue;
        let result = async {
            if self.prepare(&mut record, mutate).await? {
                let retire = record["retireId"]
                    .as_str()
                    .filter(|retire| *retire != id && *retire != name);
                let _retire = if let Some(retire) = retire {
                    Some(InstanceLock::acquire(retire, self.lifetime).await?)
                } else {
                    None
                };
                self.advance(&mut record, mutate).await?;
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = result {
            record["state"] = if error.is::<Refused>() {
                json!("failed")
            } else {
                json!("unknown")
            };
            record["error"] = json!(error.to_string());
            record["lastError"] = record["error"].clone();
            self.save(&mut record, false)?;
        } else if record["state"] != "ready" {
            record["state"] = json!("unknown");
            record["error"] = json!(
                "The original transition is incomplete or uncertain; observe it or explicitly continue unrequested steps."
            );
            self.save(&mut record, false)?;
        }
        Ok(Some(self.result(&record).await))
    }

    async fn result(&self, record: &Value) -> Value {
        let observation = async {
            let retained = if record["retireId"].is_null() {
                Value::Null
            } else {
                brief(&self.inspect_record_id(record, "retireId").await?)
            };
            let target = if record["targetId"].is_null() {
                Value::Null
            } else {
                brief(&self.inspect_record_id(record, "targetId").await?)
            };
            Ok::<_, anyhow::Error>(json!({"retained":retained,"target":target}))
        }
        .await;
        let (observation, error) = match observation {
            Ok(value) => (value, Value::Null),
            Err(error) => (Value::Null, json!(error.to_string())),
        };
        let operation = json!({"format":FORMAT,"version":1,"request":record["request"],
            "requestSha256":record["requestSha256"],"state":record["state"],"phase":record["phase"],
            "startedAt":record["startedAt"],"updatedAt":record["updatedAt"],"originalContainerId":record["original"]["Id"],
            "retainedContainerId":record["retireId"],"targetContainerId":record["targetId"],"retainedName":record["retainedName"],
            "desiredRestartPolicy":record["desiredPolicy"],"runtimeHandlesRestored":false,"error":record["error"],"lastError":record["lastError"]});
        json!({"operation":operation,"observation":observation,"observationError":error})
    }
}

fn terminal(record: &Value) -> bool {
    matches!(record["state"].as_str(), Some("ready" | "failed"))
}

fn container_id(value: &Value) -> bool {
    value.as_str().is_some_and(|id| {
        id.len() == 64
            && id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn docker_name(value: &Value, field: &str) -> Result<String> {
    Ok(format!("/{}", text(value, field)?))
}

fn policy(actual: &Value) -> Value {
    let policy = &actual["HostConfig"]["RestartPolicy"];
    if policy.is_null() {
        config::no_restart()
    } else {
        policy.clone()
    }
}

fn policy_equal(actual: &Value, expected: &Value) -> bool {
    let current = policy(actual);
    current["Name"] == expected["Name"]
        && current["MaximumRetryCount"].as_u64().unwrap_or(0)
            == expected["MaximumRetryCount"].as_u64().unwrap_or(0)
}

fn running(actual: &Value) -> bool {
    actual["State"]["Running"] == true || actual["State"]["Restarting"] == true
}

fn started(actual: &Value) -> bool {
    actual["State"]["StartedAt"]
        .as_str()
        .is_some_and(|at| !at.is_empty() && !at.starts_with("0001-"))
}

fn brief(actual: &Value) -> Value {
    json!({"containerId":actual["Id"],"name":actual["Name"],"running":actual["State"]["Running"],
        "status":actual["State"]["Status"],"startedAt":actual["State"]["StartedAt"],"restartPolicy":policy(actual)})
}

fn labels(record: &Value) -> Value {
    json!({"io.cantrip.os.replacement.operation":record["request"]["operationId"],
        "io.cantrip.os.replacement.request":record["requestSha256"],"io.cantrip.os.replacement.original":record["original"]["Id"],
        "io.cantrip.os.replacement.instance":record["request"]["instanceId"],
        "io.cantrip.os.replacement.configuration":record["configurationSha256"]})
}

fn mount_identity(record: &Value) -> Vec<String> {
    let mut mounts: Vec<_> = record["Mounts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|mount| {
            let source = match mount["Type"].as_str() {
                Some("bind") => &mount["Source"],
                Some("volume") => &mount["Name"],
                _ => return None,
            };
            Some(
                Value::Array(vec![
                    mount["Type"].clone(),
                    source.clone(),
                    mount["Destination"].clone(),
                    json!(mount["RW"] != true),
                ])
                .stringify(),
            )
        })
        .collect();
    mounts.sort_unstable();
    mounts
}
