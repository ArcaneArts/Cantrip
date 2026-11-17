//! File activity classifications shared by watcher and HEAD observations.
use super::super::raw;
use crate::filesystem::{Scope, paths};
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexSet;
use std::{path::PathBuf, sync::Mutex};
use tokio::sync::Mutex as Queue;
const MAX_CHANGES: usize = 2_000;
const MAX_BYTES: usize = 256 * 1_024;

pub fn activity_path(filename: &JsString) -> Option<JsString> {
    let mut units: Vec<_> = filename
        .units()
        .iter()
        .map(|&u| if u == 92 { 47 } else { u })
        .collect();
    if units.is_empty()
        || units.len() > 8_192
        || units[0] == 47
        || units.len() >= 2
            && units[0] < 128
            && (units[0] as u8).is_ascii_alphabetic()
            && units[1] == 58
        || units
            .split(|&u| u == 47)
            .any(|part| part == [46, 46] || part == [46, 103, 105, 116])
    {
        return None;
    }
    if units.starts_with(&[46, 47]) {
        units.drain(..2);
    }
    if units.last() == Some(&47) {
        units.pop();
    }
    Some(JsString::new(units))
}
pub fn bounded_changes(changes: impl IntoIterator<Item = Value>) -> Vec<Value> {
    let mut result = Vec::new();
    let mut seen = IndexSet::new();
    let mut bytes = 2;
    for change in changes {
        let Some(path) = change["path"].as_js_string() else {
            continue;
        };
        if activity_path(path).is_none_or(|p| p.is_empty()) || seen.contains(path) {
            continue;
        }
        let size = change.stringify().len() + 1;
        if result.len() >= MAX_CHANGES || bytes + size > MAX_BYTES {
            break;
        }
        seen.insert(path.clone());
        result.push(change);
        bytes += size;
    }
    result
}
pub fn commit_changes(output: &str) -> Vec<Value> {
    let tokens: Vec<_> = output.split('\0').collect();
    bounded_changes(tokens.chunks_exact(2).filter_map(|pair| {
        if pair[0].is_empty() || activity_path(&pair[1].into()).is_none_or(|p|p.is_empty()) {return None;}
        Some(json!({"path":pair[1],"kind":match pair[0] {"A"=>"added","D"=>"deleted",_=>"modified"}}))
    }))
}
pub struct Activity {
    root: PathBuf,
    known: Queue<IndexSet<JsString>>,
    pending: Mutex<IndexSet<JsString>>,
    head: Mutex<Option<Value>>,
}
impl Activity {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            known: Queue::default(),
            pending: Mutex::default(),
            head: Mutex::default(),
        }
    }
    pub async fn initialize(&self, scope: &Scope) {
        let files = raw(
            &self.root,
            &[
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ],
            scope,
        )
        .await
        .unwrap_or_default();
        let mut known = self.known.lock().await;
        for file in files.split('\0') {
            if activity_path(&file.into()).is_none_or(|p| p.is_empty()) {
                continue;
            }
            known.insert(file.into());
            let mut parent = file;
            while let Some((prefix, _)) = parent.rsplit_once('/') {
                if prefix.is_empty() {
                    break;
                }
                known.insert(prefix.into());
                parent = prefix;
            }
        }
    }
    pub fn record(&self, filename: &JsString) {
        let mut pending = self.pending.lock().unwrap();
        if pending.len() < MAX_CHANGES
            && let Some(path) = activity_path(filename)
            && !path.is_empty()
        {
            pending.insert(path);
        }
    }
    pub async fn flush(&self) -> Vec<Value> {
        // Snapshot before waiting for previous filesystem work, matching the
        // source queue's batch ownership during concurrent saves.
        let pending = std::mem::take(&mut *self.pending.lock().unwrap());
        let mut known = self.known.lock().await;
        let mut changes = Vec::new();
        let mut directories = IndexSet::new();
        for file in pending {
            // Node path.join concatenates a leading slash in a later segment;
            // PathBuf::join would replace the root for inputs such as .//file.
            let mut filename = self.root.as_os_str().to_os_string();
            filename.push(std::path::MAIN_SEPARATOR_STR);
            filename.push(paths::native(&file));
            match tokio::fs::symlink_metadata(PathBuf::from(filename)).await {
                Ok(metadata) => {
                    if metadata.is_dir() {
                        directories.insert(file.clone());
                    }
                    changes.push(json!({"path":file,"kind":if known.contains(&file){"modified"}else{"added"}}));
                    known.insert(file);
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) =>
                {
                    if known.shift_remove(&file) {
                        changes.push(json!({"path":file,"kind":"deleted"}));
                    }
                    let prefix = [file.units(), &[47]].concat();
                    known.retain(|path| !path.units().starts_with(&prefix));
                }
                Err(_) => {}
            }
        }
        bounded_changes(
            changes
                .iter()
                .filter(|change| {
                    let path = change["path"].as_js_string().unwrap();
                    let prefix = [path.units(), &[47]].concat();
                    !directories.contains(path)
                        || !changes.iter().any(|child| {
                            child["path"]
                                .as_js_string()
                                .unwrap()
                                .units()
                                .starts_with(&prefix)
                        })
                })
                .cloned(),
        )
    }
    pub async fn observe_head(&self, head: &Value, scope: &Scope) -> Vec<Value> {
        let previous = self.head.lock().unwrap().replace(head.clone());
        let Some(previous) = previous.filter(|previous| previous != head && !head.is_null()) else {
            return Vec::new();
        };
        let head = head.as_str().unwrap();
        let args = if let Some(previous) = previous.as_str() {
            vec![
                "diff",
                "--name-status",
                "--no-renames",
                "-z",
                previous,
                head,
                "--",
            ]
        } else {
            vec![
                "diff-tree",
                "--root",
                "-r",
                "--no-commit-id",
                "--name-status",
                "--no-renames",
                "-z",
                head,
                "--",
            ]
        };
        commit_changes(&raw(&self.root, &args, scope).await.unwrap_or_default())
    }
}
