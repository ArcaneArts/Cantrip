use super::{carrier::DeliveryUnknown, checked};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_wire::{Value, parse_json_text, value::json};
use chrono::{SecondsFormat, Utc};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

pub(super) struct Operations {
    root: PathBuf,
    active: Mutex<HashSet<PathBuf>>,
}

struct Active<'a> {
    file: PathBuf,
    set: &'a Mutex<HashSet<PathBuf>>,
}
impl Drop for Active<'_> {
    fn drop(&mut self) {
        self.set.lock().unwrap().remove(&self.file);
    }
}

pub(super) fn digest(value: Value) -> String {
    sha256(value.stringify().as_bytes())
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(super) fn save(file: &Path, record: &Value, exclusive: bool) -> Result<()> {
    let directory = file.parent().context("OS operation directory")?;
    cantrip_host::files::private_directory(directory)?;
    cantrip_host::files::secure_directory(directory)?;
    let mut pending = tempfile::NamedTempFile::new_in(directory)?;
    writeln!(pending, "{}", record.stringify())?;
    pending.as_file().sync_all()?;
    if exclusive {
        pending
            .persist_noclobber(file)
            .map_err(|error| error.error)?;
    } else {
        pending.persist(file).map_err(|error| error.error)?;
    }
    #[cfg(unix)]
    for parent in directory.ancestors().take(3) {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

pub(super) struct Journal<'a> {
    file: &'a Path,
    record: Value,
}

impl Journal<'_> {
    pub fn path(&self) -> &Path {
        self.file
    }

    fn save(&mut self) -> Result<()> {
        self.record["updatedAt"] = json!(now());
        save(self.file, &self.record, false).map_err(|_| DeliveryUnknown(
            "The OS operation outcome could not be recorded; inspect the existing operation before retrying.".into()
        ).into())
    }

    pub fn bind(&mut self, binding: &Value, session_id: &str) -> Result<()> {
        self.record["native"] = json!({"binding":binding,"sessionId":session_id});
        self.save()
    }

    pub fn prepare_process(&mut self, process_id: &str, argv: &[&str]) -> Result<()> {
        let Value::Array(processes) = &mut self.record["processes"] else {
            anyhow::bail!("Invalid OS process journal.");
        };
        processes.push(json!({"processId":process_id,"argv":argv}));
        self.save()
    }
}

impl Operations {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            root: data_directory.join("cantrip-os-operations"),
            active: Mutex::default(),
        }
    }

    fn file(&self, scope: &Value, id: &str) -> Result<PathBuf> {
        // Retain the Node controller's path and admission fingerprint encoding.
        ensure!(
            id.len() == 36
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() || byte == b'-'),
            "Invalid OS operation ID."
        );
        let key = digest(Value::Array(
            [
                "serverId",
                "ownerId",
                "workerId",
                "instanceId",
                "guestInstanceId",
            ]
            .into_iter()
            .map(|field| scope[field].clone())
            .collect(),
        ));
        Ok(self.root.join(key).join(format!("{id}.json")))
    }

    fn read(&self, file: &Path, id: &str, active: bool) -> Result<Option<Value>> {
        let text = match fs::read_to_string(file) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let mut record =
            parse_json_text(&text).map_err(|_| anyhow!("Stored OS operation is invalid."))?;
        ensure!(
            record["version"].as_u64() == Some(1)
                && record["operationId"] == id
                && self.file(&record["scope"], id)? == file,
            "Stored OS operation has the wrong identity."
        );
        if record["state"] == "running" && !active {
            record["state"] = json!("unknown");
            record["error"] = json!(
                "The controlling worker session ended; inspect the recorded native sessions before retrying."
            );
        }
        Ok(Some(record))
    }

    pub fn inspect(&self, scope: &Value, id: &str) -> Result<Value> {
        let file = self.file(scope, id)?;
        let active = self.active.lock().unwrap();
        let Some(record) = self.read(&file, id, active.contains(&file))? else {
            return Ok(Value::Null);
        };
        let fields = scope.as_object().context("OS operation scope")?;
        let saved = record["scope"]
            .as_object()
            .context("Stored OS operation scope")?;
        ensure!(
            fields
                .iter()
                .all(|(name, value)| saved.get(name) == Some(value)),
            "The recorded OS operation scope changed."
        );
        result(&record)
    }

    pub async fn execute(
        &self,
        scope: &Value,
        id: &str,
        command: &str,
        admission: Value,
        run: impl AsyncFnOnce(&mut Journal<'_>) -> Result<Value>,
    ) -> Result<Value> {
        let file = self.file(scope, id)?;
        let fingerprint = digest(Value::Array(vec![json!(command), admission]));
        let time = now();
        let record = json!({"version":1,"operationId":id,"command":command,"admissionFingerprint":fingerprint,
            "scope":scope,"state":"running","startedAt":time,"updatedAt":time,"receipt":Value::Null,
            "error":Value::Null,"native":Value::Null,"processes":Vec::<Value>::new()});
        let active = {
            let mut active = self.active.lock().unwrap();
            if let Err(error) = save(&file, &record, true) {
                if error
                    .downcast_ref::<io::Error>()
                    .is_none_or(|error| error.kind() != io::ErrorKind::AlreadyExists)
                {
                    return Err(error);
                }
                let prior = self
                    .read(&file, id, active.contains(&file))?
                    .context("Stored OS operation disappeared.")?;
                ensure!(
                    prior["command"] == command
                        && prior["admissionFingerprint"] == fingerprint
                        && &prior["scope"] == scope,
                    "The OS operation ID already belongs to a different admission."
                );
                return result(&prior);
            }
            active.insert(file.clone());
            Active {
                file,
                set: &self.active,
            }
        };

        let mut journal = Journal {
            file: &active.file,
            record,
        };
        match run(&mut journal).await {
            Ok(receipt) => {
                journal.record["state"] = json!("ready");
                journal.record["receipt"] = receipt;
            }
            Err(error) => {
                journal.record["state"] = json!(if error.is::<DeliveryUnknown>() {
                    "unknown"
                } else {
                    "failed"
                });
                journal.record["error"] = json!(error.to_string());
            }
        }
        journal.save()?;
        result(&journal.record)
    }
}

fn result(record: &Value) -> Result<Value> {
    let error = if record["error"].is_null() {
        Value::Null
    } else if record["state"] == "unknown" {
        json!("OS delivery is unknown; inspect this operation before retrying.")
    } else {
        json!("The OS operation failed; inspect its worker diagnostics.")
    };
    checked(
        "cantripOsOperationResultSchema",
        json!({
            "operationId":record["operationId"], "state":record["state"], "startedAt":record["startedAt"],
            "updatedAt":record["updatedAt"], "receipt":record["receipt"], "error":error,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reopens_an_unsettled_admission_without_replaying_it() -> Result<()> {
        let data = tempfile::tempdir()?;
        let store = Operations::new(data.path());
        let scope = json!({"serverId":"server","ownerId":"owner","workerId":"worker",
            "instanceId":"dab2f979-8309-492c-899d-b0c2b952cac7","guestInstanceId":"cabdf338-521c-4397-8f83-826ab1ed5691",
            "attachmentGeneration":"f27b12c9-85cc-4d79-9e1c-20405ab4ed84","runtimeGeneration":"1a964bc4-8926-4258-8d70-fa3d8967f992"});
        let id = "52a79ea4-580c-4de9-928f-5df6e2177337";
        let command = "cantrip-os.workspaces.create";
        let admission = json!({"guestWorkspaceId":"test","transport":json!({"kind":"docker","container":"instance"})});
        let (started, running) = tokio::sync::oneshot::channel();
        let operation = store.execute(&scope, id, command, admission.clone(), async |journal| {
            journal.bind(&json!({"workspace_id":"test"}), "native-session")?;
            journal.prepare_process("native-process", &["git", "clone"])?;
            started.send(()).unwrap();
            std::future::pending().await
        });
        {
            tokio::pin!(operation);
            tokio::select! {
                _ = running => {},
                _ = &mut operation => panic!("admission settled without a receipt"),
            }
            let duplicate = store
                .execute(&scope, id, command, admission.clone(), async |_| {
                    panic!("active admission replayed")
                })
                .await?;
            assert_eq!(duplicate["state"], "running");
        }

        let reopened = Operations::new(data.path());
        let saved = reopened
            .read(&reopened.file(&scope, id)?, id, false)?
            .unwrap();
        assert_eq!(saved["native"]["sessionId"], "native-session");
        assert_eq!(
            saved["processes"],
            json!([json!({"processId":"native-process","argv":["git", "clone"]})])
        );
        let observed = reopened.inspect(&scope, id)?;
        assert_eq!(observed["state"], "unknown");
        assert_eq!(
            reopened
                .execute(&scope, id, command, admission, async |_| {
                    panic!("uncertain admission replayed")
                })
                .await?,
            observed
        );
        let mut stale = scope.clone();
        stale["runtimeGeneration"] = json!("54c646d8-ed14-49c7-b6bf-68943c26f5b3");
        assert!(reopened.inspect(&stale, id).is_err());
        Ok(())
    }
}
