use crate::cantrip_os::{
    replacement::{bindings, mounted_configuration},
    text,
};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{
    Value,
    value::{Object, json},
};
use indexmap::{IndexMap, IndexSet};

pub(super) const LABEL: &str = "io.cantrip.os.replacement.";
const MOUNTS: &str = "io.cantrip.os.source-mounts";

fn environments(config: &Value) -> Result<IndexMap<&str, Option<&str>>> {
    let entries = config["Env"].as_array().into_iter().flatten();
    entries
        .map(|entry| {
            let entry = entry.as_str().context("Invalid Docker environment entry")?;
            Ok(match entry.split_once('=') {
                Some((name, value)) => (name, Some(value)),
                None => (entry, None),
            })
        })
        .collect()
}

fn image_defaults(original: &Value, previous: &Value, next: &Value) -> Result<Value> {
    let current = original["Config"]
        .as_object()
        .context("Missing original Docker config")?;
    let old = previous["Config"]
        .as_object()
        .context("Missing original image config")?;
    let new = next["Config"]
        .as_object()
        .context("Missing target image config")?;
    let mut config = current.clone();
    for field in old.keys().chain(new.keys()).collect::<IndexSet<_>>() {
        if current.get(field) == old.get(field) {
            match new.get(field) {
                Some(value) => {
                    config.insert(field.clone(), value.clone());
                }
                None => {
                    config.shift_remove(field);
                }
            }
        }
    }
    let defaults = environments(&previous["Config"])?;
    let mut environment = environments(&next["Config"])?;
    for (key, value) in environments(&original["Config"])? {
        if defaults.get(key) != Some(&value) {
            environment.insert(key, value);
        }
    }
    let env: Vec<_> = environment
        .into_iter()
        .map(|(key, value)| match value {
            Some(value) => format!("{key}={value}"),
            None => key.to_owned(),
        })
        .collect();
    config.insert("Env".into(), json!(env));
    let old_labels = previous["Config"]["Labels"].as_object();
    let current_labels = original["Config"]["Labels"].as_object();
    let mut labels = next["Config"]["Labels"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    for (key, value) in current_labels.into_iter().flatten() {
        if old_labels.and_then(|old| old.get(key)) != Some(value) {
            labels.insert(key.clone(), value.clone());
        }
    }
    labels.insert("io.cantrip.os".into(), json!("foundation"));
    match original["Config"]["Labels"].get(MOUNTS) {
        Some(value) => {
            labels.insert(MOUNTS.into(), value.clone());
        }
        None => {
            labels.shift_remove(MOUNTS);
        }
    }
    config.insert("Labels".into(), Value::Object(labels));
    // Only the original mount layout defines data mounted by the replacement.
    config.insert(
        "Volumes".into(),
        Value::Object(
            original["Config"]["Volumes"]
                .as_object()
                .cloned()
                .unwrap_or_default(),
        ),
    );
    let mut result = original.clone();
    result["Config"] = Value::Object(config);
    Ok(result)
}

pub(super) fn no_restart() -> Value {
    json!({"Name":"no","MaximumRetryCount":0})
}

pub(super) fn build(
    original: &Value,
    previous: &Value,
    next: &Value,
    request: &Value,
) -> Result<Value> {
    let current = image_defaults(original, previous, next)?;
    let instance = &request["instanceId"];
    let mut config = mounted_configuration(&current, instance, &bindings(original, instance)?)?;
    config["Image"] = request["source"]["imageId"].clone();
    let volumes: Vec<_> = original["Mounts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|mount| mount["Type"] == "volume")
        .collect();
    let prefixes = volumes
        .iter()
        .map(|mount| Ok(format!("{}:", text(mount, "Name")?)))
        .collect::<Result<Vec<_>>>()?;
    let host = &mut config["HostConfig"];
    let binds: Vec<_> = host["Binds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|bind| {
            !bind
                .as_str()
                .is_some_and(|bind| prefixes.iter().any(|prefix| bind.starts_with(prefix)))
        })
        .cloned()
        .collect();
    let mut mounts: Vec<_> = host["Mounts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|mount| {
            !volumes
                .iter()
                .any(|volume| volume["Destination"] == mount["Target"])
        })
        .cloned()
        .collect();
    for volume in volumes {
        let mut previous = original["HostConfig"]["Mounts"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|mount| mount["Target"] == volume["Destination"])
            .cloned()
            .unwrap_or_else(|| Value::Object(Object::new()));
        ensure!(previous.is_object(), "Invalid original volume mount.");
        previous["Type"] = json!("volume");
        previous["Source"] = volume["Name"].clone();
        previous["Target"] = volume["Destination"].clone();
        previous["ReadOnly"] = json!(volume["RW"] != true);
        previous["VolumeOptions"]["NoCopy"] = json!(true);
        mounts.push(previous);
    }
    host["Binds"] = Value::Array(binds);
    host["Mounts"] = Value::Array(mounts);
    host["RestartPolicy"] = no_restart();
    let mut labels = config["Labels"]
        .as_object()
        .context("Missing replacement labels")?
        .clone();
    labels.retain(|key, _| !key.lossy().starts_with(LABEL));
    config["Labels"] = Value::Object(labels);
    Ok(config)
}
