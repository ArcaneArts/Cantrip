//! Standalone Chat skill selection uses Core's audience keys and the worker's
//! global source directories. The selected links live only with the runtime.
use crate::{
    codex::catalog::account_home, codex::managed::Runtime, filesystem::paths, metadata::Signal,
};
use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use cantrip_wire::{JsString, Value, value::json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};
use tempfile::TempDir;
use tokio::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

const RPC_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_DIRECTORIES: usize = 2_000;
const MAX_SKILLS: usize = 1_000;
const MAX_DEPTH: usize = 6;
const MAX_SKILL_BYTES: u64 = 1_000_000;

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
    let account = if matches!(provider["kind"].as_str(), Some("chatgpt" | "grok")) {
        account_home(
            data,
            provider["id"]
                .as_js_string()
                .context("Missing skill provider ID.")?,
        )
    } else {
        data.join("codex-home")
    };
    let roots = [
        ("account", Some(account.join("skills"))),
        (
            "user",
            std::env::home_dir().map(|home| home.join(".agents").join("skills")),
        ),
        ("codexUser", global.map(Path::to_owned)),
    ];
    tokio::task::spawn_blocking(move || {
        let mut selected = Sources::default();
        for (location, root) in roots {
            if let Some(root) = root {
                scan(location, &paths::resolve(&root)?, &keys, &mut selected)?;
            }
        }
        Ok(selected)
    })
    .await?
}

fn scan(
    location: &str,
    root: &Path,
    keys: &HashSet<JsString>,
    selected: &mut Sources,
) -> Result<()> {
    let mut pending = VecDeque::from([(root.to_owned(), 0)]);
    let mut visited = HashSet::new();
    let mut skills = 0;
    while let Some((path, depth)) = pending.pop_front() {
        if visited.len() >= MAX_DIRECTORIES || skills >= MAX_SKILLS {
            break;
        }
        let canonical = match paths::canonical_sync(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if !visited.insert(canonical.clone()) || !fs::metadata(&canonical)?.is_dir() {
            continue;
        }
        let mut document = None;
        let mut children = Vec::new();
        for entry in fs::read_dir(&path)? {
            let entry = entry?;
            let name = entry.file_name();
            let kind = entry.file_type()?;
            if name == "SKILL.md" && kind.is_file() {
                document = Some(entry.path());
                break;
            }
            if depth < MAX_DEPTH
                && (kind.is_dir() || kind.is_symlink())
                && !(depth == 0 && location != "user" && name == ".system")
            {
                children.push((entry.path(), depth + 1));
            }
        }
        if let Some(document) = document {
            if depth != 0 && fs::metadata(document)?.len() <= MAX_SKILL_BYTES {
                skills += 1;
                let relative = path.strip_prefix(root)?;
                let key = audience_key(location, root, relative);
                if keys.contains(&JsString::from(key.as_str())) {
                    selected.0.insert(key, canonical);
                }
            }
            continue;
        }
        pending.extend(children);
    }
    Ok(())
}

fn audience_key(location: &str, root: &Path, relative: &Path) -> String {
    let relative = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    let root = paths::text(root);
    URL_SAFE_NO_PAD.encode(Sha256::digest(format!(
        "cantrip-skill-audience:v1\0{location}\0{}\0{relative}",
        root.lossy()
    )))
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
