//! Compatible v1 worker routing metadata. No paths or private Git metadata
//! are exposed by the public workspace command adapter.
use cantrip_protocol::repository_operations::METADATA_FIELDS as FIELDS;
const PROTECTED_RESULTS: &[&str] = &[
    "cantrip-os.inspect",
    "cantrip-os.attach",
    "cantrip-os.workspaces.list",
    "cantrip-os.workspaces.create",
    "cantrip-os.source.provision",
    "cantrip-os.source.inspect",
    "cantrip-os.operation.inspect",
    "project.clone",
    "project.folder.materialize",
    "workspace.repositories.discover",
    "workspace.repository-import.validate",
    "chat.scratch.provision",
    "chat.scratch.resolve",
    "chat.scratch.archive",
    "chat.scratch.restore",
    "chat.scratch.delete",
    "chat.scratch.reconcile",
    "project.folder-conversion.preflight",
    "project.folder-conversion.execute",
    "project.replica.provision",
    "project.replica.synchronize",
    "project.replica.remove",
    "project.replica.link.repair",
    "project.share.open",
    "project.share.close",
    "worktree.list",
    "worktree.reconcile",
    "worktree.create",
    "worktree.remove",
    "worktree.lock",
    "worktree.unlock",
    "worktree.prune",
    "worktree.status",
    "worktree.observation.configure",
];

use anyhow::{Result, anyhow, bail};
use cantrip_wire::{
    JsString, Value, parse_json_text,
    value::{Object, json},
};
use indexmap::IndexMap;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use tokio::sync::Mutex;
struct Record {
    field: JsString,
    value: JsString,
}
#[derive(Default)]
struct State {
    loaded: Option<bool>,
    records: IndexMap<JsString, Record>,
    tokens: HashMap<JsString, JsString>,
}
pub struct Registry {
    path: PathBuf,
    state: Mutex<State>,
}
#[derive(Debug)]
pub struct ProtectedError {
    pub code: Option<&'static str>,
}
impl std::fmt::Display for ProtectedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Protected repository operation failed on the worker.")
    }
}
impl std::error::Error for ProtectedError {}
pub fn protect_error(kind: &str, error: anyhow::Error) -> anyhow::Error {
    if !PROTECTED_RESULTS.contains(&kind) {
        return error;
    }
    let code = error
        .downcast_ref::<crate::workspace::WorkspaceError>()
        .map(|error| error.code)
        .or_else(|| {
            error
                .downcast_ref::<crate::filesystem::folders::AttachmentError>()
                .map(|error| error.code)
        })
        .or_else(|| {
            error
                .downcast_ref::<crate::project_shares::SourceUnavailable>()
                .map(|_| "project-source-unavailable")
        });
    ProtectedError { code }.into()
}
fn field(value: &JsString) -> bool {
    value.as_str().is_some_and(|value| FIELDS.contains(&value))
}
fn is_token(value: &JsString) -> bool {
    let units = value.units();
    units.len() == 48
        && units.starts_with(&[99, 116, 114, 114, 95])
        && units[5..].iter().all(|&unit| {
            unit < 128 && ((unit as u8).is_ascii_alphanumeric() || unit == 95 || unit == 45)
        })
}
fn reverse(field: &JsString, value: &JsString) -> JsString {
    JsString::new([field.units(), &[0], value.units()].concat())
}

impl Registry {
    /// Command resolution loads the registry before observation configuration.
    /// Contention rejects publication, leaving fingerprints available for retry.
    pub fn protect_notification(&self, value: &Value) -> Result<Option<Value>> {
        let Ok(mut state) = self.state.try_lock() else {
            return Ok(None);
        };
        if state.loaded != Some(true) {
            return Ok(None);
        }
        let value = crate::git::worktrees::observations::notification::for_server(value);
        let result = state.protect_observed(&value, None)?;
        state.persist(&self.path)?;
        Ok(Some(result))
    }
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join("repository-routing.json"),
            state: Mutex::new(State::default()),
        }
    }
    pub async fn resolve(&self, value: &Value) -> Result<Value> {
        let mut state = self.state.lock().await;
        state.load(&self.path).await?;
        state.resolve(value)
    }
    pub async fn protect_result(&self, kind: &str, value: &Value) -> Result<Value> {
        if !PROTECTED_RESULTS.contains(&kind) {
            return Ok(value.clone());
        }
        let mut state = self.state.lock().await;
        state.load(&self.path).await?;
        let result = if kind == "worktree.observation.configure" {
            state.protect_observation(value)?
        } else {
            state.protect(value, None, kind.starts_with("cantrip-os."))?
        };
        state.persist(&self.path)?;
        Ok(result)
    }
    pub async fn protect_metadata(&self, values: &Value) -> Result<Value> {
        let fields = values
            .as_object()
            .ok_or_else(|| anyhow!("Unsupported repository metadata field."))?;
        if fields.keys().any(|name| !field(name)) {
            bail!("Unsupported repository metadata field.");
        }
        let mut state = self.state.lock().await;
        state.load(&self.path).await?;
        let result = state.protect(values, None, false)?;
        state.persist(&self.path)?;
        Ok(result)
    }
    pub async fn resolve_metadata(&self, values: &Value) -> Result<Value> {
        let fields = values
            .as_object()
            .ok_or_else(|| anyhow!("Unsupported repository metadata field."))?;
        if fields.keys().any(|name| !field(name)) {
            bail!("Unsupported repository metadata field.");
        }
        self.resolve(values).await
    }
}
impl State {
    fn protect_observed(&mut self, value: &Value, name: Option<&JsString>) -> Result<Value> {
        match value {
            Value::String(value) if name.is_some_and(field) => {
                // Configuration reconciles source/worktree bindings through
                // the existing path token namespace. Notifications must address
                // those same stored bindings, including nested inventory paths.
                let name = name.unwrap();
                let path = JsString::from("path");
                let name = if matches!(name.as_str(), Some("sourcePath" | "worktreePath")) {
                    &path
                } else {
                    name
                };
                Ok(Value::String(self.token(name, value)?))
            }
            Value::Array(items) => items
                .iter()
                .map(|value| self.protect_observed(value, name))
                .collect::<Result<Vec<_>>>()
                .map(Value::Array),
            Value::Object(fields) => fields
                .iter()
                .map(|(name, value)| Ok((name.clone(), self.protect_observed(value, Some(name))?)))
                .collect::<Result<Object>>()
                .map(Value::Object),
            _ => Ok(value.clone()),
        }
    }
    async fn load(&mut self, path: &Path) -> Result<()> {
        match self.loaded {
            Some(true) => return Ok(()),
            Some(false) => bail!("The worker repository routing registry is invalid."),
            None => {}
        }
        self.loaded = Some(false);
        let bytes = match tokio::fs::read(path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.loaded = Some(true);
                return Ok(());
            }
            Err(_) => bail!("The worker repository routing registry is invalid."),
        };
        let read = || -> Result<Vec<(JsString, JsString, JsString)>> {
            let stored = parse_json_text(&String::from_utf8_lossy(&bytes))
                .map_err(|_| anyhow!("Invalid repository routing registry."))?;
            let object = stored
                .as_object()
                .ok_or_else(|| anyhow!("Invalid repository routing registry."))?;
            if stored["version"] != 1
                || object
                    .keys()
                    .any(|key| !matches!(key.as_str(), Some("version" | "records")))
            {
                bail!("Invalid repository routing registry.");
            }
            let records = stored["records"]
                .as_array()
                .ok_or_else(|| anyhow!("Invalid repository routing registry."))?;
            records
                .iter()
                .map(|record| {
                    let object = record
                        .as_object()
                        .ok_or_else(|| anyhow!("Invalid repository routing record."))?;
                    let name = record["field"]
                        .as_js_string()
                        .filter(|name| field(name))
                        .ok_or_else(|| anyhow!("Invalid repository routing record."))?;
                    let token = record["token"]
                        .as_js_string()
                        .filter(|token| is_token(token))
                        .ok_or_else(|| anyhow!("Invalid repository routing record."))?;
                    let value = record["value"]
                        .as_js_string()
                        .filter(|value| (1..=32768).contains(&value.units().len()))
                        .ok_or_else(|| anyhow!("Invalid repository routing record."))?;
                    if object
                        .keys()
                        .any(|key| !matches!(key.as_str(), Some("field" | "token" | "value")))
                    {
                        bail!("Invalid repository routing record.");
                    }
                    Ok((name.clone(), token.clone(), value.clone()))
                })
                .collect()
        };
        let records =
            read().map_err(|_| anyhow!("The worker repository routing registry is invalid."))?;
        for (field, token, value) in records {
            let reverse = reverse(&field, &value);
            if self.records.contains_key(&token) || self.tokens.contains_key(&reverse) {
                bail!("The worker repository routing registry is invalid.");
            }
            self.records.insert(token.clone(), Record { field, value });
            self.tokens.insert(reverse, token);
        }
        self.loaded = Some(true);
        Ok(())
    }
    fn resolve_string(&self, value: &JsString) -> Result<JsString> {
        if let Some(record) = self.records.get(value) {
            return Ok(record.value.clone());
        }
        let head: Vec<u16> = "refs/heads/".encode_utf16().collect();
        let suffix = value
            .units()
            .strip_prefix(head.as_slice())
            .map(|units| JsString::new(units.to_vec()));
        if let Some(record) = suffix.as_ref().and_then(|suffix| self.records.get(suffix)) {
            return Ok(JsString::new(
                [head.as_slice(), record.value.units()].concat(),
            ));
        }
        if is_token(value) || suffix.as_ref().is_some_and(is_token) {
            bail!("Repository routing metadata is unavailable on this worker.");
        }
        Ok(value.clone())
    }
    fn resolve(&self, value: &Value) -> Result<Value> {
        match value {
            Value::String(value) => Ok(Value::String(self.resolve_string(value)?)),
            Value::Array(items) => items
                .iter()
                .map(|item| self.resolve(item))
                .collect::<Result<Vec<_>>>()
                .map(Value::Array),
            Value::Object(fields) => fields
                .iter()
                .map(|(name, value)| Ok((name.clone(), self.resolve(value)?)))
                .collect::<Result<Object>>()
                .map(Value::Object),
            _ => Ok(value.clone()),
        }
    }
    fn token(&mut self, name: &JsString, value: &JsString) -> Result<JsString> {
        let reverse = reverse(name, value);
        if let Some(token) = self.tokens.get(&reverse) {
            return Ok(token.clone());
        }
        let token = loop {
            let value: JsString = format!(
                "ctrr_{}",
                cantrip_crypto::encode(&cantrip_crypto::random_bytes(32)?)
            )
            .into();
            if !self.records.contains_key(&value) {
                break value;
            }
        };
        self.records.insert(
            token.clone(),
            Record {
                field: name.clone(),
                value: value.clone(),
            },
        );
        self.tokens.insert(reverse, token.clone());
        Ok(token)
    }
    fn protect(&mut self, value: &Value, name: Option<&JsString>, os: bool) -> Result<Value> {
        if os && name.and_then(JsString::as_str) == Some("dependencyOverlays") {
            return crate::http::checked("cantripOsDependencyOverlaysSchema", value);
        }
        match value {
            Value::String(value) if name.is_some_and(field) => {
                Ok(Value::String(self.token(name.unwrap(), value)?))
            }
            Value::Array(items) => items
                .iter()
                .map(|item| self.protect(item, name, os))
                .collect::<Result<Vec<_>>>()
                .map(Value::Array),
            Value::Object(fields) => fields
                .iter()
                .map(|(name, value)| Ok((name.clone(), self.protect(value, Some(name), os)?)))
                .collect::<Result<Object>>()
                .map(Value::Object),
            _ => Ok(value.clone()),
        }
    }
    fn protect_observation(&mut self, value: &Value) -> Result<Value> {
        if !value.is_object() || !value["paths"].is_array() {
            return self.protect(value, None, false);
        }
        let mut result = value.clone();
        let Value::Array(paths) = &mut result["paths"] else {
            unreachable!()
        };
        for entry in paths {
            if let Value::Object(fields) = entry {
                for name in ["sourcePath", "worktreePath"] {
                    if let Some(Value::String(value)) = fields.get(name) {
                        let token = self.token(&"path".into(), value)?;
                        fields.insert(name.into(), Value::String(token));
                    }
                }
            }
        }
        Ok(result)
    }
    fn persist(&self, path: &Path) -> Result<()> {
        let records = self
            .records
            .iter()
            .map(|(token, record)| json!({"field":record.field,"token":token,"value":record.value}))
            .collect::<Vec<_>>();
        let bytes = format!("{}\n", json!({"version":1,"records":records}).stringify());
        // Keep publication within the same locked poll as token allocation.
        // Cancellation cannot detach a writer or let an older snapshot rename
        // over a newer one. Runtime command jobs themselves are owned/joined.
        cantrip_host::files::private_directory(path.parent().unwrap())?;
        let temporary = path.with_file_name(format!(
            "repository-routing.json.{}.tmp",
            uuid::Uuid::new_v4()
        ));
        let result = (|| {
            cantrip_host::files::write_private(&temporary, bytes.as_bytes())?;
            std::fs::rename(&temporary, path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }
}

#[cfg(test)]
mod observation_tests {
    use super::*;
    #[tokio::test]
    async fn notifications_reuse_canonical_bindings_and_reopen_without_plaintext_activity() {
        let directory = tempfile::tempdir().unwrap();
        let registry = Registry::new(directory.path());
        let notification = json!({"type":"worktree.filesystem.changed","sourcePath":"/source","worktreePath":"/checkout","changes":vec![json!({"path":"private-file","kind":"added"})]});
        assert!(
            registry
                .protect_notification(&notification)
                .unwrap()
                .is_none()
        );
        registry.resolve(&Value::Null).await.unwrap();
        let configured=registry.protect_result("worktree.observation.configure",&json!({"accepted":true,"paths":vec![json!({"sourcePath":"/source","worktreePath":"/checkout"})]})).await.unwrap();
        let protected = registry
            .protect_notification(&notification)
            .unwrap()
            .unwrap();
        assert_eq!(
            protected["sourcePath"],
            configured["paths"].as_array().unwrap()[0]["sourcePath"]
        );
        assert_eq!(
            protected["worktreePath"],
            configured["paths"].as_array().unwrap()[0]["worktreePath"]
        );
        assert!(protected.get("changes").is_none());
        let registry_file =
            std::fs::read_to_string(directory.path().join("repository-routing.json")).unwrap();
        assert!(!registry_file.contains("private-file"));
        let reopened = Registry::new(directory.path());
        assert_eq!(
            reopened.resolve(&protected).await.unwrap(),
            crate::git::worktrees::observations::notification::for_server(&notification)
        );
        let _busy = registry.state.lock().await;
        assert!(
            registry
                .protect_notification(&notification)
                .unwrap()
                .is_none()
        );
    }
}
