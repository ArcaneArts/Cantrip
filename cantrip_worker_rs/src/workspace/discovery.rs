use super::{ProcessError, Scope, classify_origin, error, paths, string};
use anyhow::{Result, anyhow};
use cantrip_wire::{JsString, Value, value::json};
use icu_collator::{Collator, options::CollatorOptions};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Instant,
};

#[derive(Clone)]
pub struct Limits {
    pub duration_ms: f64,
    pub max_candidates: f64,
    pub max_depth: f64,
    pub max_directories: f64,
    pub max_entries: f64,
    pub max_git_output_bytes: usize,
    pub per_git_command_timeout_ms: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            duration_ms: f64::INFINITY,
            max_candidates: f64::INFINITY,
            max_depth: f64::INFINITY,
            max_directories: f64::INFINITY,
            max_entries: f64::INFINITY,
            max_git_output_bytes: 1024 * 1024,
            per_git_command_timeout_ms: 5000,
        }
    }
}
fn bounded(value: f64, minimum: f64) -> f64 {
    if value == f64::INFINITY {
        value
    } else if !value.is_finite() {
        minimum
    } else {
        value.floor().max(minimum)
    }
}
impl Limits {
    fn normalized(&self) -> Self {
        Self {
            duration_ms: bounded(self.duration_ms, 1.),
            max_candidates: bounded(self.max_candidates, 1.),
            max_depth: bounded(self.max_depth, 0.),
            max_directories: bounded(self.max_directories, 1.),
            max_entries: bounded(self.max_entries, 1.),
            max_git_output_bytes: self.max_git_output_bytes.max(1024),
            per_git_command_timeout_ms: self.per_git_command_timeout_ms.max(1),
        }
    }
}
struct Inspection<'a> {
    limits: &'a Limits,
    scope: &'a Scope,
    started: Instant,
}
impl Inspection<'_> {
    fn remaining(&self) -> f64 {
        (self.limits.duration_ms - self.started.elapsed().as_secs_f64() * 1000.).max(0.)
    }
    fn timeout(&self) -> u64 {
        self.remaining()
            .min(self.limits.per_git_command_timeout_ms as f64)
            .max(1.) as u64
    }
    async fn git(&self, directory: &Path, args: &[&str]) -> Result<JsString> {
        self.scope.check()?;
        if self.remaining() <= 0. {
            return Err(anyhow!("Workspace repository discovery expired."));
        }
        let mut arguments = vec!["-C".into(), directory.as_os_str().to_owned()];
        arguments.extend(args.iter().map(std::ffi::OsString::from));
        let stdout = self
            .scope
            .run(
                "git".as_ref(),
                &arguments,
                self.limits.max_git_output_bytes,
                self.timeout(),
            )
            .await?;
        Ok(JsString::from(stdout).trim())
    }
    async fn git_path(&self, directory: &Path, args: &[&str]) -> Result<PathBuf> {
        let raw = paths::native(&self.git(directory, args).await?);
        Ok(paths::canonical(&if raw.is_absolute() {
            raw
        } else {
            directory.join(raw)
        })
        .await?)
    }
    async fn inspect(&self, directory: &Path, root: &Path) -> Result<Option<Value>> {
        let bare = self
            .git(directory, &["rev-parse", "--is-bare-repository"])
            .await?;
        if bare == "true".into() {
            let common = self
                .git_path(directory, &["rev-parse", "--git-common-dir"])
                .await?;
            return Ok(Some(candidate(
                directory,
                root,
                &common,
                &json!({"classification":"unsupported","diagnosticCode":"bare-repository","github":Value::Null,"originUrl":Value::Null}),
            )));
        }
        if bare != "false".into() {
            return Ok(None);
        }
        let top = self
            .git_path(directory, &["rev-parse", "--show-toplevel"])
            .await?;
        if !paths::equal(&top, directory) || !paths::within(root, &top) {
            return Ok(None);
        }
        let git = self
            .git_path(directory, &["rev-parse", "--git-dir"])
            .await?;
        let common = self
            .git_path(directory, &["rev-parse", "--git-common-dir"])
            .await?;
        if !paths::equal(&git, &common) {
            return Ok(Some(candidate(
                &top,
                root,
                &common,
                &json!({"classification":"unsupported","diagnosticCode":"linked-worktree","github":Value::Null,"originUrl":Value::Null}),
            )));
        }
        let classification = match self
            .git(directory, &["config", "--get", "remote.origin.url"])
            .await
        {
            Ok(origin) => {
                classify_origin(
                    &Value::String(origin),
                    self.limits.max_git_output_bytes,
                    self.timeout(),
                    self.scope,
                )
                .await?
            }
            Err(error) => {
                self.scope.check()?;
                if error
                    .downcast_ref::<ProcessError>()
                    .is_some_and(|e| e.exit == Some(1))
                {
                    classify_origin(
                        &Value::Null,
                        self.limits.max_git_output_bytes,
                        self.timeout(),
                        self.scope,
                    )
                    .await?
                } else {
                    json!({"classification":"local-git","diagnosticCode":"origin-unavailable","github":Value::Null,"originUrl":Value::Null})
                }
            }
        };
        Ok(Some(candidate(&top, root, &common, &classification)))
    }
}
fn candidate(path: &Path, root: &Path, common: &Path, classification: &Value) -> Value {
    let fingerprint = Sha256::digest(paths::text(common).lossy().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    json!({"canonicalPath":paths::text(path),"classification":classification["classification"],"diagnosticCode":classification["diagnosticCode"],"gitCommonDirectory":paths::text(common),"github":classification["github"],"originUrl":classification["originUrl"],"relativePath":paths::relative(root,path),"repositoryFingerprint":fingerprint})
}
#[derive(Default)]
struct Counts {
    collapsed: u64,
    rejected: u64,
    directories: u64,
    entries: u64,
    symlinks: u64,
    unreadable: u64,
    truncated: bool,
}
impl Counts {
    fn progress(&self, candidates: usize) -> Value {
        json!({"counts":json!({"candidates":candidates,"collapsedRepositories":self.collapsed,"rejectedRepositories":self.rejected,"scannedDirectories":self.directories,"scannedEntries":self.entries,"skippedSymlinks":self.symlinks,"unreadableDirectories":self.unreadable}),"diagnosticCode":if self.truncated{json!("scan-truncated")}else{Value::Null},"truncated":self.truncated})
    }
}
struct Entry {
    name: JsString,
    directory: bool,
    file: bool,
    symlink: bool,
}
async fn entries(path: &Path) -> std::io::Result<Vec<Entry>> {
    let mut reader = tokio::fs::read_dir(path).await?;
    let mut result = Vec::new();
    while let Some(entry) = reader.next_entry().await? {
        let kind = entry.file_type().await?;
        result.push(Entry {
            name: paths::text(Path::new(&entry.file_name())),
            directory: kind.is_dir(),
            file: kind.is_file(),
            symlink: kind.is_symlink(),
        });
    }
    // libuv scandir establishes name order before Node's stable locale sort.
    result.sort_by_cached_key(|entry| entry.name.lossy().into_owned());
    Ok(result)
}
pub async fn discover(
    requested: &JsString,
    limits: &Limits,
    scope: &Scope,
    mut on_progress: impl FnMut(Value),
) -> Result<Value> {
    scope.check()?;
    let requested = paths::native(requested);
    if !requested.is_absolute() {
        return Err(error(
            "root-unavailable",
            "Workspace repository discovery requires an absolute root.",
        ));
    }
    let metadata = tokio::fs::symlink_metadata(&requested).await.ok();
    if !metadata.is_some_and(|m| m.is_dir() && !m.file_type().is_symlink()) {
        return Err(error(
            "root-unavailable",
            "Workspace repository discovery root is not an accessible directory.",
        ));
    }
    let root = paths::canonical(&requested).await.map_err(|_| {
        error(
            "root-unavailable",
            "Workspace repository discovery root could not be resolved.",
        )
    })?;
    let limits = limits.normalized();
    let inspection = Inspection {
        limits: &limits,
        scope,
        started: Instant::now(),
    };
    let locale: icu_locale_core::Locale = cantrip_wire::environment::locale()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| "en-US".parse().unwrap());
    let collator = Collator::try_new(locale.into(), CollatorOptions::default())
        .map_err(|e| anyhow!("Workspace sorting locale: {e}"))?;
    let mut queue = vec![(root.clone(), 0u64)];
    let mut queue_index = 0usize;
    let mut candidates = Vec::<Value>::new();
    let mut fingerprint_index = HashMap::<String, usize>::new();
    let mut counts = Counts::default();
    let mut last_progress = Instant::now();
    on_progress(counts.progress(0));
    macro_rules! progress {
        () => {
            if last_progress.elapsed().as_millis() >= 250 {
                on_progress(counts.progress(candidates.len()));
                last_progress = Instant::now();
            }
        };
    }
    'scan: while queue_index < queue.len() {
        scope.check()?;
        if inspection.remaining() <= 0. {
            counts.truncated = true;
            break;
        }
        let (directory, depth) = queue[queue_index].clone();
        queue_index += 1;
        counts.directories += 1;
        progress!();
        let mut entries = match entries(&directory).await {
            Ok(entries) => entries,
            Err(_) => {
                counts.unreadable += 1;
                continue;
            }
        };
        entries.sort_by(|a, b| collator.compare_utf16_icu4c(a.name.units(), b.name.units()));
        let marker = entries.iter().find(|entry| entry.name == ".git".into());
        let bare = ["HEAD", "objects", "refs"]
            .map(|name| entries.iter().find(|entry| entry.name == name.into()));
        let possible_bare = bare[0].is_some_and(|e| e.file)
            && bare[1].is_some_and(|e| e.directory)
            && bare[2].is_some_and(|e| e.directory);
        if marker.is_some() || possible_bare {
            counts.entries += if marker.is_some() { 1 } else { 3 };
            if counts.entries as f64 > limits.max_entries {
                counts.truncated = true;
                break;
            }
            if marker.is_some_and(|e| e.symlink) {
                counts.symlinks += 1;
                counts.rejected += 1;
            } else if marker.is_some_and(|e| e.directory || e.file) || possible_bare {
                match inspection.inspect(&directory, &root).await {
                    Ok(None) => counts.rejected += 1,
                    Ok(Some(candidate)) => {
                        if candidate["classification"] == "unsupported" {
                            counts.rejected += 1;
                        }
                        let fingerprint = candidate["repositoryFingerprint"]
                            .as_str()
                            .unwrap()
                            .to_owned();
                        if let Some(&index) = fingerprint_index.get(&fingerprint) {
                            counts.collapsed += 1;
                            if candidates[index]["classification"] == "unsupported"
                                && candidate["classification"] != "unsupported"
                            {
                                candidates[index] = candidate;
                            }
                        } else if candidates.len() as f64 >= limits.max_candidates {
                            counts.truncated = true;
                            break 'scan;
                        } else {
                            fingerprint_index.insert(fingerprint, candidates.len());
                            candidates.push(candidate);
                        }
                        if inspection.remaining() <= 0. {
                            counts.truncated = true;
                            break 'scan;
                        }
                    }
                    Err(_) => {
                        scope.check()?;
                        counts.rejected += 1;
                        if inspection.remaining() <= 0. {
                            counts.truncated = true;
                            break 'scan;
                        }
                    }
                }
            } else {
                counts.rejected += 1;
            }
            progress!();
            continue;
        }
        for entry in entries {
            scope.check()?;
            counts.entries += 1;
            if counts.entries as f64 > limits.max_entries {
                counts.truncated = true;
                break 'scan;
            }
            if entry.symlink {
                counts.symlinks += 1;
                continue;
            }
            if !entry.directory {
                continue;
            }
            if depth as f64 >= limits.max_depth {
                counts.truncated = true;
                continue;
            }
            let path = directory.join(paths::native(&entry.name));
            let Ok(metadata) = tokio::fs::symlink_metadata(&path).await else {
                continue;
            };
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                if metadata.file_type().is_symlink() {
                    counts.symlinks += 1;
                }
                continue;
            }
            let Ok(canonical) = paths::canonical(&path).await else {
                continue;
            };
            if !paths::within(&root, &canonical) || !paths::equal(&path, &canonical) {
                counts.symlinks += 1;
                continue;
            }
            if queue.len() as f64 >= limits.max_directories {
                counts.truncated = true;
                continue;
            }
            queue.push((canonical, depth + 1));
        }
        progress!();
    }
    candidates.sort_by(|a, b| {
        collator.compare_utf16_icu4c(
            a["relativePath"].as_js_string().unwrap().units(),
            b["relativePath"].as_js_string().unwrap().units(),
        )
    });
    on_progress(counts.progress(candidates.len()));
    Ok(
        json!({"candidates":candidates,"canonicalRoot":paths::text(&root),"collapsedRepositories":counts.collapsed,"unreadableDirectories":counts.unreadable,"rejectedRepositories":counts.rejected,"scannedDirectories":counts.directories,"scannedEntries":counts.entries,"skippedSymlinks":counts.symlinks,"truncated":counts.truncated}),
    )
}
pub async fn validate_import(input: &Value, scope: &Scope) -> Result<Value> {
    scope.check()?;
    let requested_root = paths::native(&string(input, "rootPath"));
    if !requested_root.is_absolute() {
        return Err(error(
            "repository-unavailable",
            "The attached workspace root is not absolute.",
        ));
    }
    if !tokio::fs::symlink_metadata(&requested_root)
        .await
        .is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
    {
        return Err(error(
            "repository-unavailable",
            "The attached workspace root is no longer accessible.",
        ));
    }
    let root = paths::canonical(&requested_root).await.map_err(|_| {
        error(
            "repository-unavailable",
            "The attached workspace root could not be resolved.",
        )
    })?;
    let requested = paths::native(&string(input, "path"));
    if !requested.is_absolute() {
        return Err(error(
            "repository-unavailable",
            "The repository import path is not absolute.",
        ));
    }
    if !tokio::fs::symlink_metadata(&requested)
        .await
        .is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
    {
        return Err(error(
            "repository-unavailable",
            "The repository import path is no longer an accessible directory.",
        ));
    }
    let canonical = paths::canonical(&requested)
        .await
        .ok()
        .filter(|p| paths::within(&root, p))
        .ok_or_else(|| {
            error(
                "repository-unavailable",
                "The repository import path is outside the attached workspace root.",
            )
        })?;
    let limits = Limits::default();
    let inspection = Inspection {
        limits: &limits,
        scope,
        started: Instant::now(),
    };
    let candidate = match inspection.inspect(&canonical, &root).await {
        Ok(candidate) => candidate,
        Err(_) => {
            scope.check()?;
            return Err(error(
                "repository-unavailable",
                "The repository import path is no longer an attachable Git checkout.",
            ));
        }
    }
    .ok_or_else(|| {
        error(
            "repository-unavailable",
            "The repository import path is no longer a primary Git checkout.",
        )
    })?;
    if candidate["classification"] == "unsupported" {
        return Err(error(
            "repository-unavailable",
            "The repository import path is not an importable primary Git checkout.",
        ));
    }
    if candidate["repositoryFingerprint"] != input["expectedRepositoryFingerprint"] {
        return Err(error(
            "repository-changed",
            "The repository checkout changed after discovery.",
        ));
    }
    let branch = inspection
        .git(&canonical, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await
        .ok()
        .filter(|v| !v.is_empty());
    scope.check()?;
    let head = inspection
        .git(&canonical, &["rev-parse", "--verify", "HEAD"])
        .await
        .ok()
        .filter(|v| !v.is_empty());
    scope.check()?;
    Ok(
        json!({"candidateId":input["candidateId"],"attempt":input["attempt"],"path":candidate["canonicalPath"],"displayPath":candidate["canonicalPath"],"originUrl":candidate["originUrl"],"github":candidate["github"],"repositoryFingerprint":candidate["repositoryFingerprint"],"classification":candidate["classification"],"diagnosticCode":candidate["diagnosticCode"],"branch":branch,"head":head}),
    )
}
