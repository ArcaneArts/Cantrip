//! Standalone Chat skill selection uses Core's audience keys and the worker's
//! global source directories. The selected links live only with the runtime.
use super::library;
use crate::{codex::managed::Runtime, filesystem::paths, metadata::Signal};
use anyhow::{Context, Result};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
    time::Duration,
};
use tempfile::TempDir;
use tokio::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

const RPC_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Default, PartialEq, Eq)]
pub(in crate::codex) struct Sources(BTreeMap<String, PathBuf>);

pub(in crate::codex) async fn sources(
    data: &Path,
    global: Option<&Path>,
    provider: &Value,
    keys: &Value,
) -> Result<Sources> {
    let keys = keys
        .as_array()
        .context("Missing Standalone Chat skill audiences.")?;
    if keys.is_empty() {
        return Ok(Sources::default());
    }
    let keys: HashSet<JsString> = keys
        .iter()
        .filter_map(Value::as_js_string)
        .cloned()
        .collect();
    let roots = library::roots(
        data,
        global,
        provider["id"]
            .as_js_string()
            .context("Missing skill provider ID.")?,
        provider["kind"]
            .as_str()
            .context("Missing skill provider kind.")?,
    );
    tokio::task::spawn_blocking(move || {
        let mut selected = Sources::default();
        for root in roots.into_iter().filter(|root| root.location.chat()) {
            for skill in root.scan()? {
                let key = root.audience_key(&skill)?;
                if keys.contains(&JsString::from(key.as_str())) {
                    selected.0.insert(key, skill.canonical);
                }
            }
        }
        Ok(selected)
    })
    .await?
}

#[derive(Default)]
struct Snapshot {
    sources: Sources,
    root: Option<TempDir>,
}

impl Snapshot {
    fn mount(home: &Path, sources: Sources) -> Result<Self> {
        let root = if sources.0.is_empty() {
            None
        } else {
            let root = tempfile::Builder::new()
                .prefix("chat-skills-")
                .tempdir_in(home)?;
            for (key, source) in &sources.0 {
                let link = root.path().join(key);
                #[cfg(unix)]
                std::os::unix::fs::symlink(source, link)?;
                #[cfg(windows)]
                junction::create(source, link)?;
            }
            Some(root)
        };
        Ok(Self { sources, root })
    }

    fn extra_roots(&self) -> Vec<JsString> {
        self.root
            .iter()
            .map(|root| paths::text(root.path()))
            .collect()
    }
}

pub(in crate::codex) struct RuntimeSkills(RwLock<Option<Snapshot>>);

impl Default for RuntimeSkills {
    fn default() -> Self {
        Self(RwLock::new(Some(Snapshot::default())))
    }
}

pub(in crate::codex) struct Lease<'a> {
    _selection: RwLockReadGuard<'a, Option<Snapshot>>,
}

impl RuntimeSkills {
    pub(in crate::codex) async fn prepare<'a>(
        &'a self,
        runtime: &Runtime,
        sources: Sources,
        cwd: &JsString,
        signal: &Signal,
    ) -> Result<Lease<'a>> {
        let selection = tokio::select! {
            reason = signal.cancelled() => return Err(reason.into()),
            selection = self.0.read() => selection,
        };
        let matches = |snapshot: &Option<Snapshot>| {
            snapshot
                .as_ref()
                .is_some_and(|selected| selected.sources == sources)
        };
        let selection = if matches(&selection) {
            selection
        } else {
            drop(selection);
            let mut selection = tokio::select! {
                reason = signal.cancelled() => return Err(reason.into()),
                selection = self.0.write() => selection,
            };
            signal.check()?;
            if !matches(&selection) {
                let home = runtime.codex_home().to_owned();
                let snapshot =
                    tokio::task::spawn_blocking(move || Snapshot::mount(&home, sources)).await??;
                let roots = snapshot.extra_roots();
                // A failed or interrupted RPC leaves the applied selection unknown.
                // The next turn explicitly sets its roots before using the runtime.
                *selection = None;
                runtime
                    .request(
                        "skills/extraRoots/set".into(),
                        Some(json!({"extraRoots":roots})),
                        Some(RPC_TIMEOUT),
                        None,
                    )
                    .await?;
                *selection = Some(snapshot);
            }
            RwLockWriteGuard::downgrade(selection)
        };
        if selection
            .as_ref()
            .is_some_and(|snapshot| snapshot.root.is_some())
        {
            runtime
                .request(
                    "skills/list".into(),
                    Some(json!({"cwds":[cwd],"forceReload":true})),
                    Some(RPC_TIMEOUT),
                    None,
                )
                .await?;
        }
        signal.check()?;
        // Turns with the same selection can run together. A changed audience
        // waits for those turns before replacing the runtime-wide skill roots.
        Ok(Lease {
            _selection: selection,
        })
    }
}
