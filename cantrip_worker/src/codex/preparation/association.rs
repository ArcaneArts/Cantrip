use anyhow::{Result, anyhow};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use std::{
    collections::HashMap,
    io::{ErrorKind, Write},
    path::PathBuf,
    sync::Mutex,
};

#[derive(Clone)]
pub(super) struct Association {
    pub version: u64,
    pub identity: String,
    pub thread_id: JsString,
    pub prepared: bool,
    pub unbound_reuse_key: Option<JsString>,
    pub replacement_of: Option<JsString>,
    pub handoff_committed: bool,
    pub replaced_threads: Vec<JsString>,
}

impl Association {
    fn parse(raw: &Value) -> Result<Self> {
        let invalid = || anyhow!("Invalid managed chat association journal.");
        let fields = raw.as_object().ok_or_else(invalid)?;
        if fields.keys().any(|key| {
            !matches!(
                key.as_str(),
                Some(
                    "version"
                        | "identity"
                        | "threadId"
                        | "prepared"
                        | "unboundReuseKey"
                        | "replacementOf"
                        | "handoffCommitted"
                        | "replacedThreads"
                )
            )
        }) {
            return Err(invalid());
        }
        let version = raw["version"]
            .as_u64()
            .filter(|v| matches!(v, 1 | 2))
            .ok_or_else(invalid)?;
        let identity = raw["identity"]
            .as_str()
            .filter(|text| {
                text.len() == 64 && text.bytes().all(|c| matches!(c,b'0'..=b'9'|b'a'..=b'f'))
            })
            .ok_or_else(invalid)?
            .to_owned();
        let id = |value: &Value| {
            value
                .as_js_string()
                .filter(|text| !text.is_empty())
                .cloned()
                .ok_or_else(invalid)
        };
        let flag = |field| {
            raw.get(field)
                .map(|v| v.as_bool().ok_or_else(invalid))
                .transpose()
                .map(|b| b.unwrap_or(false))
        };
        let unbound_reuse_key = raw.get("unboundReuseKey").map(id).transpose()?;
        if unbound_reuse_key
            .as_ref()
            .is_some_and(|key| key.units().len() > 200)
        {
            return Err(invalid());
        }
        let replaced_threads = raw
            .get("replacedThreads")
            .map(|value| {
                value
                    .as_array()
                    .ok_or_else(invalid)?
                    .iter()
                    .map(id)
                    .collect::<Result<Vec<_>>>()
            })
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            version,
            identity,
            thread_id: id(&raw["threadId"])?,
            prepared: flag("prepared")?,
            unbound_reuse_key,
            replacement_of: raw.get("replacementOf").map(id).transpose()?,
            handoff_committed: flag("handoffCommitted")?,
            replaced_threads,
        })
    }

    fn value(&self) -> Value {
        let mut value = json!({
            "version":self.version,"identity":self.identity,"threadId":self.thread_id,"prepared":self.prepared
        });
        if let Some(key) = &self.unbound_reuse_key {
            value["unboundReuseKey"] = json!(key);
        }
        if let Some(thread) = &self.replacement_of {
            value["replacementOf"] = json!(thread);
        }
        if self.handoff_committed {
            value["handoffCommitted"] = json!(true);
        }
        if !self.replaced_threads.is_empty() {
            value["replacedThreads"] = json!(self.replaced_threads);
        }
        value
    }
}

pub(super) struct Store {
    directory: PathBuf,
    identified: Mutex<HashMap<String, Association>>,
}

impl Store {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            identified: Mutex::new(HashMap::new()),
        }
    }

    pub async fn read(&self, key: &str) -> Result<Option<Association>> {
        if let Some(known) = self.identified.lock().unwrap().get(key).cloned() {
            return Ok(Some(known));
        }
        let path = self.directory.join(format!("{key}.json"));
        let raw = match tokio::fs::read(path).await {
            Ok(raw) => raw,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let parsed = parse_json_text(&String::from_utf8_lossy(&raw))
            .map_err(|_| anyhow!("Invalid managed chat association journal JSON."))?;
        Ok(Some(Association::parse(&parsed)?))
    }

    pub async fn write(&self, key: &str, record: Association) -> Result<()> {
        let raw = record.value();
        // Preserve the returned identity in this process even if persistence
        // fails, as a retry must reuse the native thread already created.
        self.identified.lock().unwrap().insert(key.into(), record);
        let directory = self.directory.clone();
        let destination = directory.join(format!("{key}.json"));
        tokio::task::spawn_blocking(move || {
            cantrip_host::files::private_directory(&directory)?;
            let mut stage = tempfile::Builder::new()
                .prefix(".association-")
                .suffix(".tmp")
                .tempfile_in(&directory)?;
            stage.write_all(raw.stringify().as_bytes())?;
            stage.as_file().sync_all()?;
            stage
                .persist(destination)
                .map_err(|failure| failure.error)?;
            #[cfg(unix)]
            std::fs::File::open(directory)?.sync_all()?;
            Ok(())
        })
        .await?
    }
}
