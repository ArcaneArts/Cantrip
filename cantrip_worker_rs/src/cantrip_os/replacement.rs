//! Recreate a local foundation container and keep its previous identity for recovery.
use super::{
    carrier::DeliveryUnknown,
    checked,
    docker::{DockerApiError, LocalDocker, segment},
    operations::{digest, save, sha256},
    text,
};
use crate::filesystem::Scope;
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_wire::{
    Value, parse_json_text,
    value::{Object, json},
};
use hyper::{Method, StatusCode};
use std::{
    future::Future,
    path::{Path, PathBuf},
    time::Duration,
};

const MOUNT_LABEL: &str = "io.cantrip.os.source-mounts";
const LIMIT: Duration = Duration::from_secs(60);

pub(super) fn bindings(record: &Value, instance: &Value) -> Result<Vec<Value>> {
    let Some(raw) = record["Config"]["Labels"][MOUNT_LABEL].as_str() else {
        return Ok(Vec::new());
    };
    let config = parse_json_text(raw).map_err(|_| anyhow!("Invalid OS source mount state."))?;
    ensure!(
        config["version"].as_u64() == Some(1),
        "Unsupported OS source mount state."
    );
    ensure!(
        &config["instanceId"] == instance,
        "The recorded source mounts belong to another OS instance."
    );
    Ok(config["bindings"]
        .as_array()
        .context("OS source mount bindings")?
        .clone())
}

fn load_mounts(instance: &Value, bindings: &[Value]) -> Result<Vec<Value>> {
    let mut mounts = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for binding in bindings {
        let id = text(binding, "id")?;
        let guest = text(binding, "guestPath")?;
        let worker = text(binding, "workerPath")?;
        ensure!(
            uuid::Uuid::parse_str(id).is_ok()
                && guest == format!("/workspace/{id}")
                && !worker.is_empty()
                && !worker.contains('\0')
                && seen.insert(id),
            "A linked binding requires a unique worker path and its stable guest root."
        );
        mounts.push(json!({"Type":"bind","Source":worker,"Target":guest,
            "BindOptions":json!({"Propagation":"rprivate"})}));
        let overlays = checked(
            "cantripOsDependencyOverlaysSchema",
            binding["dependencyOverlays"].clone(),
        )?;
        let cache = binding["cacheKey"].as_str().unwrap_or(id);
        for overlay in overlays.as_array().context("OS dependency overlays")? {
            let path = text(overlay, "path")?;
            let key = digest(Value::Array(vec![
                instance.clone(),
                json!(cache),
                json!(path),
            ]));
            mounts.push(
                json!({"Type":"volume","Source":format!("cantrip-os-deps-{}", &key[..40]),
                "Target":format!("{guest}/{path}"),"VolumeOptions":json!({"NoCopy":true})}),
            );
        }
    }
    Ok(mounts)
}

pub(super) async fn initialize_caches(
    engine: &LocalDocker,
    image: &Value,
    instance: &Value,
    mount: &Value,
    operation_id: &str,
    uid: u64,
    scope: &Scope,
) -> Result<()> {
    for volume in load_mounts(instance, std::slice::from_ref(mount))?
        .into_iter()
        .filter(|mount| mount["Type"] == "volume")
    {
        // Run chown on the one managed volume in a networkless helper.
        // The helper never mounts the original Host source.
        let helper = json!({"Image":image,"User":"0","Entrypoint":["/bin/chown"],
            "Cmd":[format!("{uid}:{uid}"),"/cache".into()],
            "Labels":json!({"io.cantrip.os.cache-init":operation_id}),
            "HostConfig":json!({"NetworkMode":"none","ReadonlyRootfs":true,"Mounts":[json!({
                "Type":"volume","Source":volume["Source"],"Target":"/cache",
                "VolumeOptions":json!({"NoCopy":true})})]})});
        let created = engine
            .request(
                Method::POST,
                "/containers/create",
                Some(&helper),
                LIMIT,
                scope,
            )
            .await?;
        let id = segment(text(&created, "Id")?);
        engine
            .request(
                Method::POST,
                &format!("/containers/{id}/start"),
                None,
                LIMIT,
                scope,
            )
            .await?;
        let result = engine
            .request(
                Method::POST,
                &format!("/containers/{id}/wait?condition=not-running"),
                None,
                LIMIT,
                scope,
            )
            .await?;
        ensure!(
            result["StatusCode"].as_u64() == Some(0),
            "Linux dependency volume ownership initialization failed."
        );
        engine
            .request(
                Method::DELETE,
                &format!("/containers/{id}?v=true"),
                None,
                LIMIT,
                scope,
            )
            .await?;
    }
    Ok(())
}

fn mounted_configuration(original: &Value, instance: &Value, mounts: &[Value]) -> Result<Value> {
    let mut config = original["Config"].clone();
    let prior = load_mounts(instance, &bindings(original, instance)?)?;
    let previous_target = |path: &Value| prior.iter().any(|mount| &mount["Target"] == path);
    let mut host = original["HostConfig"].clone();
    ensure!(
        host.is_object(),
        "Docker inspection has no Host configuration."
    );
    let mut current: Vec<_> = host["Mounts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|mount| !previous_target(&mount["Target"]))
        .cloned()
        .collect();
    current.extend(load_mounts(instance, mounts)?);
    // Preserve materialized anonymous image volumes as well as declared binds.
    for actual in original["Mounts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|mount| mount["Type"] == "volume")
    {
        let name = text(actual, "Name")?;
        let destination = &actual["Destination"];
        let bind_prefix = format!("{name}:");
        if previous_target(destination)
            || current.iter().any(|mount| &mount["Target"] == destination)
            || host["Binds"].as_array().into_iter().flatten().any(|bind| {
                bind.as_str()
                    .is_some_and(|bind| bind.starts_with(&bind_prefix))
            })
        {
            continue;
        }
        current.push(json!({"Type":"volume","Source":name,"Target":destination,
            "ReadOnly":actual["RW"].as_bool() == Some(false),"VolumeOptions":json!({"NoCopy":true})}));
    }
    host["Mounts"] = json!(current);
    let id = text(original, "Id")?;
    let short = id.get(..12).unwrap_or(id);
    let mut endpoints = Object::new();
    if let Some(networks) = original["NetworkSettings"]["Networks"].as_object() {
        for (name, network) in networks {
            let mut settings = Object::new();
            for field in ["IPAMConfig", "Links"] {
                if !network[field].is_null() {
                    settings.insert(field.into(), network[field].clone());
                }
            }
            if let Some(aliases) = network["Aliases"].as_array() {
                let aliases: Vec<_> = aliases
                    .iter()
                    .filter(|alias| *alias != id && *alias != short)
                    .cloned()
                    .collect();
                settings.insert("Aliases".into(), json!(aliases));
            }
            endpoints.insert(name.clone(), Value::Object(settings));
        }
    }
    config["Image"] = original["Image"].clone();
    config["Labels"][MOUNT_LABEL] =
        json!(json!({"version":1,"instanceId":instance,"bindings":mounts}).stringify());
    config["HostConfig"] = host;
    config["NetworkingConfig"] = json!({"EndpointsConfig":Value::Object(endpoints)});
    Ok(config)
}

pub(super) struct Replacement {
    path: PathBuf,
    state: Value,
}

pub(super) fn check_original(original: &Value, name: &str) -> Result<()> {
    ensure!(
        original["Config"]["Labels"]["io.cantrip.os"] == "foundation",
        "Source mounts require a CantripOS foundation container."
    );
    ensure!(
        original["Name"] == format!("/{name}") && original["HostConfig"]["AutoRemove"] != true,
        "Replacing CantripOS requires its configured name and a container retained after stopping."
    );
    Ok(())
}

impl Replacement {
    pub async fn start(
        engine: &LocalDocker,
        container: &str,
        original: &Value,
        bindings: &[Value],
        instance: &Value,
        operation: &str,
        journal: &Path,
        scope: &Scope,
    ) -> Result<Self> {
        let actual = engine.record(container, scope).await?;
        let id = text(original, "Id")?;
        ensure!(
            actual["Id"] == id && actual["State"]["StartedAt"] == original["State"]["StartedAt"],
            "The CantripOS container changed before recreation."
        );
        check_original(&actual, container)?;
        let mut configuration = mounted_configuration(&actual, instance, bindings)?;
        let key = sha256(operation.as_bytes());
        let candidate = format!("{container}-next-{}", &key[..16]);
        let previous = format!("{container}-previous-{}", &key[..16]);
        let state = json!({"version":1,"operationId":operation,"container":container,
            "instanceId":instance,"original":actual,"candidate":candidate,"previous":previous,
            "bindings":bindings,"phase":"planned"});
        save(journal, &state, true)?;
        let mut replacement = Self {
            path: journal.to_owned(),
            state,
        };
        // The snapshot preserves changes to the root layer. Docker excludes
        // mounted worktree, workspace, and cache volumes from the snapshot.
        let snapshot = replacement
            .step(
                "snapshot-system",
                Some("snapshotImage"),
                engine.request(
                    Method::POST,
                    &format!("/commit?container={}&pause=true", segment(id)),
                    None,
                    Duration::from_secs(300),
                    scope,
                ),
            )
            .await?;
        configuration["Image"] = snapshot["Id"].clone();
        let created = replacement
            .step(
                "create",
                Some("candidateId"),
                engine.request(
                    Method::POST,
                    &format!("/containers/create?name={}", segment(&candidate)),
                    Some(&configuration),
                    LIMIT,
                    scope,
                ),
            )
            .await?;
        let next = segment(text(&created, "Id")?);
        let original = segment(id);
        for (phase, path) in [
            ("stop-original", format!("/containers/{original}/stop?t=20")),
            (
                "rename-original",
                format!("/containers/{original}/rename?name={}", segment(&previous)),
            ),
            (
                "rename-candidate",
                format!("/containers/{next}/rename?name={}", segment(container)),
            ),
            ("start", format!("/containers/{next}/start")),
        ] {
            replacement
                .step(
                    phase,
                    None,
                    engine.request(Method::POST, &path, None, LIMIT, scope),
                )
                .await?;
        }
        Ok(replacement)
    }

    pub fn candidate_id(&self) -> Result<&str> {
        text(&self.state, "candidateId")
    }

    async fn step(
        &mut self,
        phase: &str,
        id: Option<&str>,
        request: impl Future<Output = Result<Value>>,
    ) -> Result<Value> {
        self.phase(&format!("{phase}-requested"))?;
        let receipt = request.await?;
        if let Some(field) = id {
            let identity = text(&receipt, "Id")
                .map_err(|_| DeliveryUnknown("Docker omitted the created identity.".into()))?;
            self.state[field] = json!(identity);
        }
        self.phase(&format!("{phase}-completed"))?;
        Ok(receipt)
    }

    fn phase(&mut self, phase: &str) -> Result<()> {
        self.state["phase"] = json!(phase);
        save(&self.path, &self.state, false).map_err(|_| {
            DeliveryUnknown("The Docker replacement outcome could not be recorded.".into()).into()
        })
    }

    pub async fn finish(mut self, engine: &LocalDocker, scope: &Scope) -> Result<()> {
        let current = engine
            .record(text(&self.state, "container")?, scope)
            .await?;
        ensure!(
            current["Id"] == self.state["candidateId"],
            "The replacement changed before cleanup."
        );
        self.phase("remove-original-requested")?;
        let old = text(&self.state["original"], "Id")?;
        let result = engine
            .request(
                Method::DELETE,
                &format!("/containers/{}?v=false", segment(old)),
                None,
                LIMIT,
                scope,
            )
            .await;
        match result {
            Err(error)
                if !error
                    .downcast_ref::<DockerApiError>()
                    .is_some_and(|error| error.status == StatusCode::NOT_FOUND) =>
            {
                return Err(error);
            }
            _ => {}
        }
        self.phase("complete")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lost_start_receipt_leaves_exact_recovery_identity() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("admitted.json.docker");
        let mut replacement = Replacement {
            path: path.clone(),
            state: json!({"version":1,"phase":"rename-candidate-completed",
                "container":"fixture","original":json!({"Id":"previous-container"}),
                "candidateId":"candidate-container"}),
        };
        save(&path, &replacement.state, true)?;
        let read = || {
            parse_json_text(&std::fs::read_to_string(&path)?)
                .map_err(|_| anyhow!("Invalid replacement journal."))
        };
        let result = replacement
            .step("start", None, async {
                // The actual start must only be attempted after its phase and both
                // exact container identities are recoverable on disk.
                assert_eq!(read()?["phase"], "start-requested");
                Err(DeliveryUnknown("fixture lost the start response".into()).into())
            })
            .await
            .unwrap_err();
        assert!(result.is::<DeliveryUnknown>());
        let unsettled = read()?;
        assert_eq!(unsettled["phase"], "start-requested");
        assert_eq!(unsettled["candidateId"], "candidate-container");
        assert_eq!(unsettled["original"]["Id"], "previous-container");
        Ok(())
    }
}
