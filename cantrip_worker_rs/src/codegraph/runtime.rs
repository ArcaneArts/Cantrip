//! Open and atomically replace the managed upstream CodeGraph distribution.
use super::{
    release::{self, Release, Source, Target},
    storage::{Current, Storage},
};
use crate::filesystem::{Scope, command::Captured, paths};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use std::{
    cmp::Ordering,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command as ProcessCommand,
    sync::{Arc, LazyLock, Mutex, Weak},
    time::Duration,
};
use tokio::{process::Command, sync::watch};

pub(super) const INDEX_DIRECTORY: &str = ".codegraph-cantrip";
const PROBE_LIMIT: Duration = Duration::from_secs(30);
const MCP_LIMIT: Duration = Duration::from_secs(10);
const OUTPUT_LIMIT: usize = 256_000;
const EXPANDED_LIMIT: u64 = 1_500_000_000;
const ENTRY_LIMIT: u64 = 512_000_000;
const STAGING_PREFIX: &str = ".codegraph-install-";
static VERSION: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"^v?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$")
        .expect("CodeGraph version")
});

pub(super) struct Runtime {
    storage: Storage,
    snapshot: Mutex<Snapshot>,
}

struct Snapshot {
    state: &'static str,
    active: Option<Arc<Installation>>,
    previous: Option<String>,
    latest: Option<String>,
    last_checked: Option<String>,
    error: Option<JsString>,
    leases: Vec<Weak<Installation>>,
}

pub(super) struct Installation {
    program: PathBuf,
    arguments: Vec<OsString>,
    version: String,
    package: PathBuf,
}

pub(super) fn version(raw: &str) -> Option<&str> {
    VERSION
        .captures(raw.trim())
        .and_then(|capture| capture.get(1))
        .map(|version| version.as_str())
        .filter(|version| version.len() <= 100)
}

pub(super) fn is_digest(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn compare(left: &str, right: &str) -> Ordering {
    let (left, left_suffix) = left.split_once('-').unwrap_or((left, ""));
    let (right, right_suffix) = right.split_once('-').unwrap_or((right, ""));
    for (left, right) in left.split('.').zip(right.split('.')) {
        let left = left.trim_start_matches('0');
        let right = right.trim_start_matches('0');
        let order = left.len().cmp(&right.len()).then_with(|| left.cmp(right));
        if order != Ordering::Equal {
            return order;
        }
    }
    left_suffix
        .is_empty()
        .cmp(&right_suffix.is_empty())
        .then_with(|| left_suffix.cmp(right_suffix))
}

fn child(root: &Path, path: &Path) -> Result<PathBuf> {
    let path = paths::canonical_sync(path)?;
    ensure!(
        path != root && path.starts_with(root) && path.is_file(),
        "CodeGraph executable escapes the version directory."
    );
    Ok(path)
}

fn message(value: &Captured) -> String {
    let bytes = if value.stderr.is_empty() {
        &value.stdout
    } else {
        &value.stderr
    };
    String::from_utf8_lossy(bytes)
        .trim()
        .chars()
        .take(1000)
        .collect()
}

impl Installation {
    pub(super) fn current(storage: &Storage) -> Result<Option<Self>> {
        let Some(current) = storage.current()? else {
            return Ok(None);
        };
        let root = paths::canonical_sync(&storage.root)?;
        let package = root.join("versions").join(&current.package);
        let resolved = paths::canonical_sync(&package)?;
        ensure!(
            resolved == package,
            "CodeGraph package is outside its managed version directory."
        );
        Ok(Some(Self::open(
            &resolved,
            &root.join(&current.executable),
            &current.version,
            current.package,
        )?))
    }

    fn open(
        package_root: &Path,
        executable: &Path,
        version: &str,
        package: PathBuf,
    ) -> Result<Self> {
        let package_root = paths::canonical_sync(package_root)?;
        let executable = child(&package_root, executable)?;
        #[cfg(not(windows))]
        let (program, arguments) = (executable, Vec::new());
        #[cfg(windows)]
        let (program, arguments) = {
            let distribution = executable
                .parent()
                .and_then(Path::parent)
                .context("Invalid CodeGraph distribution directory.")?;
            let program = child(&package_root, &distribution.join("node.exe"))?;
            let script = child(
                &package_root,
                &distribution.join("lib/dist/bin/codegraph.js"),
            )?;
            (
                program,
                vec![
                    "--liftoff-only".into(),
                    "--disable-warning=ExperimentalWarning".into(),
                    script.into_os_string(),
                ],
            )
        };
        Ok(Self {
            program,
            arguments,
            version: version.into(),
            package,
        })
    }

    fn command(&self, directory: &Path) -> ProcessCommand {
        let mut command = ProcessCommand::new(&self.program);
        command
            .current_dir(directory)
            .args(&self.arguments)
            .env("CODEGRAPH_DIR", INDEX_DIRECTORY)
            .env("CODEGRAPH_NO_UPDATE_CHECK", "1")
            .env("CODEGRAPH_TELEMETRY", "0")
            .env("DO_NOT_TRACK", "1")
            .env("NO_COLOR", "1");
        command
    }

    pub(super) fn mcp_command(&self, root: &Path) -> ProcessCommand {
        let mut command = self.command(root);
        command
            .args(["serve", "--mcp", "--path"])
            .arg(root)
            .envs(super::agent::ENVIRONMENT);
        command
    }

    pub(super) async fn run(
        &self,
        scope: &Scope,
        directory: &Path,
        args: &[OsString],
        timeout: Duration,
    ) -> Result<Captured> {
        let mut command = self.command(directory);
        command.args(args);
        let capture = scope
            .capture_configured(Command::from(command), OUTPUT_LIMIT, timeout, None)
            .await?;
        ensure!(
            capture.overflow.is_none(),
            "CodeGraph output exceeded its limit."
        );
        ensure!(!capture.timed_out, "CodeGraph process timed out.");
        Ok(capture)
    }

    pub(super) fn succeeded(command: &str, capture: &Captured) -> Result<()> {
        if capture.code != Some(0) {
            let details = message(capture);
            anyhow::bail!(
                "CodeGraph {command} failed: {}",
                if details.is_empty() {
                    format!("exit {:?}", capture.code)
                } else {
                    details
                }
            );
        }
        Ok(())
    }

    async fn verify_cli(&self, scope: &Scope, directory: &Path) -> Result<()> {
        let reported = self
            .run(scope, directory, &["--version".into()], PROBE_LIMIT)
            .await?;
        Self::succeeded("version", &reported)?;
        let report = format!(
            "{}\n{}",
            String::from_utf8_lossy(&reported.stdout),
            String::from_utf8_lossy(&reported.stderr)
        );
        ensure!(
            version(&report) == Some(&self.version),
            "CodeGraph executable did not report the installed version."
        );
        let privacy = self
            .run(
                scope,
                directory,
                &["telemetry".into(), "off".into()],
                PROBE_LIMIT,
            )
            .await?;
        Self::succeeded("telemetry off", &privacy)
    }

    async fn verify_mcp(&self, scope: &Scope, directory: &Path) -> Result<()> {
        let root = paths::canonical(directory).await?;
        let uri = url::Url::from_directory_path(&root)
            .ok()
            .context("Invalid CodeGraph health directory.")?;
        let command = Command::from(self.mcp_command(&root));
        let initialize = json!({"jsonrpc":"2.0","id":0,"method":"initialize",
            "params":json!({"protocolVersion":"2025-11-25","capabilities":json!({}),
                "clientInfo":json!({"name":"cantrip-runtime-check","version":"1.0.0"}),"rootUri":uri.as_str()})});
        let input = format!("{}\n", initialize.stringify());
        let capture = scope
            .capture_configured(command, OUTPUT_LIMIT, MCP_LIMIT, Some(input.as_bytes()))
            .await?;
        scope.check()?;
        let output = String::from_utf8_lossy(&capture.stdout);
        ensure!(
            capture.overflow.is_none()
                && output
                    .lines()
                    .filter_map(|line| parse_json_text(line).ok())
                    .any(|response| response["id"] == 0
                        && response["result"]["serverInfo"]["name"] == "codegraph"
                        && response["result"]["capabilities"].get("tools").is_some()),
            "CodeGraph MCP initialize failed: {}",
            message(&capture)
        );
        Ok(())
    }
}

impl Runtime {
    pub(super) fn new(data: &Path) -> Self {
        Self {
            storage: Storage::new(data),
            snapshot: Mutex::new(Snapshot {
                state: "unavailable",
                active: None,
                previous: None,
                latest: None,
                last_checked: None,
                error: None,
                leases: Vec::new(),
            }),
        }
    }

    pub(super) fn supported() -> bool {
        Target::host().is_some()
    }

    pub(super) fn active(&self) -> Option<Arc<Installation>> {
        self.snapshot.lock().unwrap().active.clone()
    }

    pub(super) async fn project_lock(&self, root: &Path, scope: &Scope) -> Result<fs::File> {
        self.storage.project_lock(root, scope).await
    }

    pub(super) fn status(&self) -> Value {
        let state = self.snapshot.lock().unwrap();
        let available = state.active.is_some();
        json!({"supported":Self::supported(),"available":available,"runtimeState":state.state,
            "installedVersion":state.active.as_ref().map(|active| active.version.as_str()),
            "latestVersion":state.latest,"previousVersion":state.previous,"lastCheckedAt":state.last_checked,
            "telemetryDisabled":available,"healthy":available && state.error.is_none(),"statusMessage":state.error,
            "cliAvailable":available,"mcpInjectionAvailable":available})
    }

    pub(super) fn failed(&self, error: &anyhow::Error) {
        let mut state = self.snapshot.lock().unwrap();
        state.state = if state.active.is_some() {
            "degraded"
        } else {
            "unavailable"
        };
        state.error = Some(JsString::new(
            error.to_string().encode_utf16().take(1000).collect(),
        ));
    }

    pub(super) async fn reopen(&self, scope: &Scope) -> Result<bool> {
        self.storage.prepare()?;
        let Some(installed) = Installation::current(&self.storage)? else {
            return Ok(false);
        };
        installed.verify_cli(scope, &self.storage.root).await?;
        self.activate(installed);
        Ok(true)
    }

    fn activate(&self, installation: Installation) -> Vec<PathBuf> {
        let mut state = self.snapshot.lock().unwrap();
        let mut keep = vec![installation.package.clone()];
        if let Some(previous) = state.active.replace(Arc::new(installation)) {
            state.previous = Some(previous.version.clone());
            keep.push(previous.package.clone());
            state.leases.push(Arc::downgrade(&previous));
        }
        state.leases.retain(|lease| {
            if let Some(leased) = lease.upgrade() {
                keep.push(leased.package.clone());
                true
            } else {
                false
            }
        });
        state.state = "ready";
        state.error = None;
        keep
    }

    pub(super) async fn update(
        &self,
        source: &Source,
        scope: &Scope,
        stop: watch::Receiver<bool>,
    ) -> Result<(bool, Option<anyhow::Error>)> {
        let target =
            Target::host().context("CodeGraph does not publish a runtime for this platform.")?;
        self.storage.prepare()?;
        let _lock = self.storage.lock(scope).await?;
        let cleanup = self.storage.clear_staging(STAGING_PREFIX).err();
        {
            let mut state = self.snapshot.lock().unwrap();
            state.state = if state.active.is_some() {
                "checking"
            } else {
                "installing"
            };
            state.error = None;
        }
        let (release, checked) = source.latest(&self.storage.root, &target, scope).await?;
        {
            let mut state = self.snapshot.lock().unwrap();
            state.latest = Some(release.version.clone());
            state.last_checked = Some(checked);
            if state
                .active
                .as_ref()
                .is_some_and(|active| compare(&active.version, &release.version) != Ordering::Less)
            {
                state.state = "ready";
                return Ok((false, cleanup));
            }
            state.state = "installing";
        }
        let keep = self.install(source, &release, &target, scope, stop).await?;
        let prune = self.storage.prune(&keep).err();
        Ok((true, prune.or(cleanup)))
    }

    async fn install(
        &self,
        source: &Source,
        release: &Release,
        target: &Target,
        scope: &Scope,
        stop: watch::Receiver<bool>,
    ) -> Result<Vec<PathBuf>> {
        let staging = tempfile::Builder::new()
            .prefix(STAGING_PREFIX)
            .tempdir_in(self.storage.root.join("staging"))?;
        let archive = staging.path().join("archive");
        let sums = staging.path().join("SHA256SUMS");
        let (download, checksums) = tokio::join!(
            source.download(&release.archive, &archive, scope),
            source.download(&release.checksums, &sums, scope)
        );
        download?;
        checksums?;
        release::checksum(&fs::read_to_string(sums)?, &release.archive)?;
        let extracted = staging.path().join("payload");
        let relative = tokio::task::spawn_blocking({
            let extracted = extracted.clone();
            let format = target.format;
            let executable = target.executable;
            move || {
                crate::runtime_archive::unpack(
                    &archive,
                    format,
                    &extracted,
                    EXPANDED_LIMIT,
                    ENTRY_LIMIT,
                    stop,
                )?;
                locate(&extracted, executable)
            }
        })
        .await??;
        let health = tempfile::tempdir_in(staging.path())?;
        let staged = Installation::open(
            &extracted,
            &extracted.join(&relative),
            &release.version,
            PathBuf::new(),
        )?;
        staged.verify_cli(scope, health.path()).await?;
        staged.verify_mcp(scope, health.path()).await?;

        let versions = self.storage.root.join("versions");
        let prefix = format!("{}-{}-", release.version, &release.archive.digest[..12]);
        let candidate = tempfile::Builder::new()
            .prefix(&prefix)
            .tempdir_in(&versions)?;
        let package = PathBuf::from(candidate.path().file_name().unwrap());
        fs::rename(&extracted, candidate.path().join("payload"))?;
        let current = Current {
            archive: release.archive.digest.clone(),
            executable: Path::new("versions")
                .join(&package)
                .join("payload")
                .join(relative),
            package: package.clone(),
            version: release.version.clone(),
        };
        let promoted = Installation::open(
            candidate.path(),
            &self.storage.root.join(&current.executable),
            &current.version,
            package,
        )?;
        promoted.verify_cli(scope, health.path()).await?;
        promoted.verify_mcp(scope, health.path()).await?;
        scope.check()?;
        self.storage.publish(&current)?;
        let _ = candidate.keep();
        Ok(self.activate(promoted))
    }
}

fn locate(root: &Path, executable: &str) -> Result<PathBuf> {
    let mut directories = vec![root.to_owned()];
    let mut found = None;
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                directories.push(entry.path());
            } else if kind.is_file()
                && entry.file_name() == executable
                && entry
                    .path()
                    .parent()
                    .and_then(Path::file_name)
                    .is_some_and(|name| name == "bin")
            {
                ensure!(
                    found.is_none(),
                    "CodeGraph archive has multiple CLI executables."
                );
                let path = entry.path();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
                }
                found = Some(path.strip_prefix(root)?.to_owned());
            }
        }
    }
    found.context("CodeGraph archive does not contain a CLI executable.")
}
