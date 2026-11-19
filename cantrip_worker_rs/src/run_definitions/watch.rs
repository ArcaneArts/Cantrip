use super::repository::Repository;
use crate::{connection::Outbound, encryption::Service};
use anyhow::Result;
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexMap;
use notify::{RecursiveMode, Watcher};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{Semaphore, mpsc},
    task::JoinHandle,
    time,
};

pub(super) struct Port {
    pub project: JsString,
    pub route: Value,
    pub authority: (JsString, Value),
    pub outbound: Arc<Outbound>,
    pub encryption: Arc<Service>,
}

pub(super) async fn start(
    root: PathBuf,
    port: Port,
    scans: Arc<Semaphore>,
) -> Result<JoinHandle<()>> {
    let initial = scan(root.clone(), scans.clone()).await?;
    let (changed, mut changes) = mpsc::channel(1);
    let mut watcher = notify::recommended_watcher(move |_: notify::Result<notify::Event>| {
        let _ = changed.try_send(());
    })
    .ok();
    Ok(tokio::spawn(async move {
        let mut previous = initial;
        let mut watched = None;
        let mut timer = time::interval(Duration::from_millis(500));
        timer.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
        loop {
            if !port
                .encryption
                .bound_identity()
                .is_ok_and(|identity| identity == port.authority)
            {
                break;
            }
            let candidate = watch_path(&root).await;
            if let Some(watcher) = &mut watcher
                && watched.as_ref() != Some(&candidate)
            {
                if let Some(old) = watched.take() {
                    let _ = watcher.unwatch(&old);
                }
                if watcher
                    .watch(&candidate, RecursiveMode::NonRecursive)
                    .is_ok()
                {
                    watched = Some(candidate);
                }
            }
            tokio::select! {
                _ = timer.tick() => {},
                Some(()) = changes.recv() => {
                    time::sleep(Duration::from_millis(40)).await;
                    while changes.try_recv().is_ok() {}
                }
            }
            if let Ok(next) = scan(root.clone(), scans.clone()).await {
                if port
                    .encryption
                    .bound_identity()
                    .is_ok_and(|identity| identity == port.authority)
                {
                    for change in previous.changes(&next) {
                        let _ = port.outbound.notification(json!({
                            "type":"project.run-configuration-definitions.changed","projectId":port.project,
                            "sourcePath":port.route,"change":change
                        }));
                    }
                }
                previous = next;
            }
        }
    }))
}

async fn watch_path(root: &Path) -> PathBuf {
    let mut current = root.to_owned();
    for component in [".cantrip", "run-configurations"] {
        let next = current.join(component);
        if !tokio::fs::symlink_metadata(&next)
            .await
            .is_ok_and(|metadata| metadata.is_dir())
        {
            break;
        }
        current = next;
    }
    current
}

async fn scan(root: PathBuf, scans: Arc<Semaphore>) -> Result<Snapshot> {
    let guard = scans.acquire_owned().await?;
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        Ok(Snapshot::new(Repository::new(root).scan()?))
    })
    .await?
}

struct Snapshot {
    entries: IndexMap<JsString, Entry>,
    diagnostics: Value,
}

#[derive(PartialEq)]
struct Entry {
    status: Value,
    id: Value,
    revision: Value,
    diagnostics: Vec<(Value, Value)>,
}

impl Snapshot {
    fn new(inventory: Value) -> Self {
        let entries = inventory["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                let diagnostics = entry["diagnostics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|diagnostic| (diagnostic["code"].clone(), diagnostic["message"].clone()))
                    .collect();
                let record = Entry {
                    status: entry["status"].clone(),
                    id: entry["id"].clone(),
                    revision: entry["revision"].clone(),
                    diagnostics,
                };
                (
                    entry["relativePath"].as_js_string().unwrap().clone(),
                    record,
                )
            })
            .collect();
        Self {
            entries,
            diagnostics: inventory["diagnostics"].clone(),
        }
    }

    fn changes(&self, next: &Self) -> Vec<Value> {
        let mut changes = Vec::new();
        for (path, entry) in &next.entries {
            let old = self.entries.get(path);
            let kind = match old {
                None => "created",
                Some(old) if old != entry => "updated",
                Some(_) => continue,
            };
            let id = if entry.id.is_null() {
                old.map(|old| &old.id)
            } else {
                Some(&entry.id)
            };
            changes
                .push(json!({"kind":kind,"id":id,"relativePath":path,"revision":entry.revision}));
        }
        for (path, entry) in &self.entries {
            if !next.entries.contains_key(path) {
                changes.push(json!({"kind":"deleted","id":entry.id,"relativePath":path,"revision":Value::Null}));
            }
        }
        if changes.is_empty() && self.diagnostics != next.diagnostics {
            changes.push(json!({"kind":"unknown","id":Value::Null,"relativePath":Value::Null,"revision":Value::Null}));
        }
        changes.truncate(128);
        changes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_external_definition_edits_without_including_the_document() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = crate::filesystem::paths::canonical_sync(temp.path())?;
        let repository = Repository::new(root.clone());
        let scan = || -> Result<Snapshot> { Ok(Snapshot::new(repository.scan()?)) };
        let empty = scan()?;
        let dir = root.join(".cantrip/run-configurations");
        std::fs::create_dir_all(&dir)?;
        let id = "88888888-8888-4888-8888-000000000191";
        let pending = dir.join(format!(".{id}.{id}.tmp"));
        std::fs::write(&pending, "unpublished")?;
        assert!(empty.changes(&scan()?).is_empty());

        let path = dir.join(format!("{id}.json"));
        let write = |command: &str| -> Result<()> {
            let document = json!({
                "schema":"cantrip.run-configuration","version":1,"id":id,
                "name":"Worker test","provider":"shell","target":json!({"kind":"command","command":command})
            });
            Ok(std::fs::write(&path, document.stringify())?)
        };
        write("initial command text")?;
        let created = scan()?;
        write("revised command text")?;
        let updated = scan()?;
        std::fs::remove_file(path)?;
        let deleted = scan()?;

        for (before, after, kind) in [
            (&empty, &created, "created"),
            (&created, &updated, "updated"),
            (&updated, &deleted, "deleted"),
        ] {
            let changes = before.changes(after);
            assert_eq!(changes.len(), 1);
            assert_eq!(changes[0]["kind"], kind);
            assert_eq!(changes[0]["id"], id);
            assert_eq!(changes[0]["revision"].is_null(), kind == "deleted");
            assert!(!changes[0].stringify().contains("command text"));
            cantrip_crypto::checked(
                "workerServerEnvelopeSchema",
                &json!({
                    "kind":"notification","notification":json!({
                        "type":"project.run-configuration-definitions.changed",
                        "projectId":"99999999-9999-4999-8999-000000000007","sourcePath":"route","change":changes[0],
                    })
                }),
            )?;
        }
        assert_ne!(
            empty.changes(&created)[0]["revision"],
            created.changes(&updated)[0]["revision"]
        );
        Ok(())
    }
}
