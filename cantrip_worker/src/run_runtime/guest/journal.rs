//! Version-one Run generation records shared with the previous worker.
use crate::{
    cantrip_os::operations::{digest, save},
    run_definitions::repository::read_bounded,
};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_crypto::checked;
use cantrip_wire::{Value, parse_json_text, value::json};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub(super) struct Journal {
    file: PathBuf,
    pub(super) record: Value,
}

pub(super) fn launch(input: &Value) -> Result<Value> {
    checked(
        "cantripOsRunLaunchSchema",
        &json!({
            "definitions":input["definitions"],"target":input["target"],
            "identity":input["identity"],"protectedSecrets":input["protectedSecrets"],
        }),
    )
}

pub(super) fn placement(input: &Value) -> Value {
    json!({"definitions":input["definitions"],"target":input["target"]})
}

fn directory(root: &Path, identity: &Value) -> Result<PathBuf> {
    let id = identity["runtimeId"].as_str().context("Linux Run ID")?;
    Uuid::parse_str(id).context("Invalid Linux Run ID")?;
    Ok(root.join(id))
}

impl Journal {
    pub fn open(root: &Path, identity: &Value) -> Result<Option<Self>> {
        let generation = identity["generation"]
            .as_u64()
            .context("Linux Run generation")?;
        let file = directory(root, identity)?.join(format!("{generation}.json"));
        let bytes = match read_bounded(&file, 16 * 1024 * 1024) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let record = parse_json_text(std::str::from_utf8(&bytes)?)
            .map_err(|_| anyhow!("Invalid Linux Run journal."))?;
        ensure!(
            record["version"] == 1
                && record["identity"]["runtimeId"] == identity["runtimeId"]
                && record["identity"]["generation"].as_u64() == Some(generation),
            "Invalid Linux Run journal identity."
        );
        let journal = Self { file, record };
        let _ = journal.input()?;
        ensure!(
            journal.record["native"].is_null()
                || (uuid(&journal.record["native"]["sessionId"])
                    && journal.record["native"]["executorGeneration"]
                        .as_str()
                        .is_some()),
            "Invalid saved Linux executor session."
        );
        let mut processes = std::collections::HashSet::new();
        for process in journal.record["processes"]
            .as_array()
            .context("Linux Run process list")?
        {
            ensure!(
                uuid(&process["id"])
                    && processes.insert(process["id"].as_str().unwrap())
                    && matches!(
                        process["phase"].as_str(),
                        Some("prepare" | "before-launch" | "runtime")
                    )
                    && process["tty"].as_bool() == Some(process["phase"] != "prepare")
                    && process["exited"].as_bool().is_some(),
                "Invalid saved Linux Run process."
            );
        }
        Ok(Some(journal))
    }

    pub fn reserve(root: &Path, input: &Value) -> Result<Self> {
        let identity = &input["identity"];
        let generation = identity["generation"].as_u64().unwrap();
        let file = directory(root, identity)?.join(format!("{generation}.json"));
        let record = json!({
            "version":1,"identity":identity,"definitions":input["definitions"],"target":input["target"],
            "fingerprint":digest(input.clone()),"protectedSecrets":input["protectedSecrets"],
            "native":Value::Null,"processes":Vec::<Value>::new(),"result":Value::Null,
        });
        save(&file, &record, true)?;
        Ok(Self { file, record })
    }

    pub fn input(&self) -> Result<Value> {
        let mut input = self.record.clone();
        if input.get("protectedSecrets").is_none() {
            input["protectedSecrets"] = Value::Array(Vec::new());
        }
        let input = launch(&input)?;
        ensure!(
            self.record["fingerprint"] == digest(input.clone()),
            "The sealed Linux Run admission could not be verified."
        );
        Ok(input)
    }

    pub fn matches(&self, input: &Value, stop: bool) -> Result<()> {
        let saved = &self.record["identity"];
        let mut expected = input["identity"].clone();
        if stop {
            expected["operationId"] = saved["operationId"].clone();
        }
        ensure!(
            expected == *saved && placement(input) == placement(&self.record),
            "The Linux Run differs from its captured admission."
        );
        Ok(())
    }

    pub fn save(&self) -> Result<()> {
        save(&self.file, &self.record, false)
    }

    pub fn processes(&self) -> &[Value] {
        self.record["processes"].as_array().unwrap()
    }

    pub fn processes_mut(&mut self) -> &mut Vec<Value> {
        let Value::Array(processes) = &mut self.record["processes"] else {
            unreachable!()
        };
        processes
    }
}

fn uuid(value: &Value) -> bool {
    value.as_str().is_some_and(|id| Uuid::parse_str(id).is_ok())
}

pub(super) fn older(root: &Path, input: &Value) -> Result<Vec<Journal>> {
    let identity = &input["identity"];
    let current = identity["generation"].as_u64().unwrap();
    let entries = match fs::read_dir(directory(root, identity)?) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut prior = Vec::new();
    for entry in entries {
        let name = entry?.file_name();
        let Some(generation) = name
            .to_str()
            .and_then(|name| name.strip_suffix(".json"))
            .and_then(|name| name.parse::<u64>().ok())
            .filter(|&generation| generation < current)
        else {
            continue;
        };
        let mut candidate = identity.clone();
        candidate["generation"] = json!(generation);
        if let Some(saved) = Journal::open(root, &candidate)? {
            ensure!(
                placement(input) == placement(&saved.record)
                    && [
                        "projectId",
                        "configurationId",
                        "worktreeId",
                        "workerId",
                        "terminalId"
                    ]
                    .iter()
                    .all(|key| identity[*key] == saved.record["identity"][*key]),
                "The durable Run belongs to a different Linux placement."
            );
            if saved
                .processes()
                .iter()
                .any(|process| process["exited"] == false)
            {
                prior.push(saved);
            }
        }
    }
    Ok(prior)
}
