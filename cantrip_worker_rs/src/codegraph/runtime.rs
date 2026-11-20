//! Open a previously installed third-party CodeGraph distribution directly.
use crate::filesystem::{Scope, command::Captured};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use std::{
    ffi::OsString,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::LazyLock,
    time::Duration,
};
use tokio::{process::Command, sync::OnceCell};

pub(super) const INDEX_DIRECTORY: &str = ".codegraph-cantrip";
const PROBE_LIMIT: Duration = Duration::from_secs(30);
const OUTPUT_LIMIT: usize = 256_000;
static VERSION: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$").expect("CodeGraph version")
});

pub(super) struct Runtime {
    root: PathBuf,
    installation: OnceCell<Result<Installation, String>>,
}

pub(super) struct Installation {
    program: PathBuf,
    arguments: Vec<OsString>,
    version: String,
}

fn version(raw: &str) -> Option<&str> {
    VERSION
        .captures(raw.trim())
        .and_then(|value| value.get(1))
        .map(|value| value.as_str())
}

fn relative(raw: &Value) -> Result<&Path> {
    let path = Path::new(
        raw.as_str()
            .context("Missing CodeGraph installation path")?,
    );
    ensure!(
        !path.as_os_str().is_empty()
            && path
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
        "CodeGraph installation path escapes the version directory."
    );
    Ok(path)
}

fn child(root: &Path, path: &Path) -> Result<PathBuf> {
    let path = path.canonicalize()?;
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
    pub(super) async fn run(
        &self,
        scope: &Scope,
        directory: &Path,
        args: &[OsString],
        timeout: Duration,
    ) -> Result<Captured> {
        let mut command = Command::new(&self.program);
        command
            .current_dir(directory)
            .args(&self.arguments)
            .args(args)
            .env("CODEGRAPH_DIR", INDEX_DIRECTORY)
            .env("CODEGRAPH_NO_UPDATE_CHECK", "1")
            .env("CODEGRAPH_TELEMETRY", "0")
            .env("DO_NOT_TRACK", "1")
            .env("NO_COLOR", "1");
        let capture = scope
            .capture_configured(command, OUTPUT_LIMIT, timeout)
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
}

impl Runtime {
    pub(super) fn new(data: &Path) -> Self {
        Self {
            root: data.join("tools").join("codegraph"),
            installation: OnceCell::new(),
        }
    }

    pub(super) fn supported() -> bool {
        cfg!(all(
            any(
                target_os = "macos",
                target_os = "linux",
                target_os = "windows"
            ),
            any(target_arch = "aarch64", target_arch = "x86_64")
        ))
    }

    pub(super) async fn ready(&self, scope: &Scope) -> Result<&Installation> {
        self.installation
            .get_or_init(|| async { self.open(scope).await.map_err(|error| error.to_string()) })
            .await
            .as_ref()
            .map_err(|message| anyhow::anyhow!("{message}"))
    }

    pub(super) fn status(&self) -> Value {
        let installed = self.installation.get();
        let application = installed.and_then(|value| value.as_ref().ok());
        let available = application.is_some();
        let error = installed.and_then(|value| value.as_ref().err());
        let state = if available {
            "ready"
        } else if installed.is_none() && Self::supported() {
            "checking"
        } else {
            "unavailable"
        };
        json!({"supported":Self::supported(),"available":available,"runtimeState":state,
            "installedVersion":application.map(|installed| installed.version.as_str()),"latestVersion":Value::Null,
            "previousVersion":Value::Null,"lastCheckedAt":Value::Null,"telemetryDisabled":available,
            "healthy":available,
            "statusMessage":error.map(|message| JsString::new(message.encode_utf16().take(1000).collect())),
            "cliAvailable":available,"mcpInjectionAvailable":false})
    }

    async fn open(&self, scope: &Scope) -> Result<Installation> {
        ensure!(
            Self::supported(),
            "CodeGraph does not publish a runtime for this platform."
        );
        let bytes = std::fs::File::open(self.root.join("bin/current.json"))
            .context("CodeGraph has no installed runtime.")?;
        let mut manifest = String::new();
        bytes.take(65_537).read_to_string(&mut manifest)?;
        ensure!(
            manifest.len() <= 65_536,
            "CodeGraph installation pointer exceeded its limit."
        );
        let manifest = parse_json_text(&manifest)
            .map_err(|_| anyhow::anyhow!("CodeGraph installation pointer is invalid."))?;
        let hash = manifest["archiveSha256"].as_str().unwrap_or_default();
        let expected = manifest["version"]
            .as_str()
            .and_then(version)
            .filter(|value| value.len() <= 100)
            .context("Invalid CodeGraph version.")?;
        ensure!(
            manifest["schemaVersion"].as_u64() == Some(1)
                && hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "CodeGraph installation pointer is invalid."
        );
        let root = self.root.canonicalize()?;
        let versions = root.join("versions").canonicalize()?;
        ensure!(
            versions == root.join("versions"),
            "CodeGraph version directory is outside its managed location."
        );
        let package = versions
            .join(relative(&manifest["packageDirectory"])?)
            .canonicalize()?;
        ensure!(
            package != versions && package.starts_with(&versions),
            "CodeGraph package escapes the version directory."
        );
        let executable = child(&package, &root.join(relative(&manifest["executable"])?))?;
        #[cfg(not(windows))]
        let (program, arguments) = (executable, Vec::new());
        #[cfg(windows)]
        let (program, arguments) = {
            let distribution = executable
                .parent()
                .and_then(Path::parent)
                .context("Invalid CodeGraph distribution directory.")?;
            let program = child(&package, &distribution.join("node.exe"))?;
            let script = child(&package, &distribution.join("lib/dist/bin/codegraph.js"))?;
            (
                program,
                vec![
                    "--liftoff-only".into(),
                    "--disable-warning=ExperimentalWarning".into(),
                    script.into_os_string(),
                ],
            )
        };
        let installation = Installation {
            program,
            arguments,
            version: expected.to_owned(),
        };
        let reported = installation
            .run(scope, &root, &["--version".into()], PROBE_LIMIT)
            .await?;
        Installation::succeeded("version", &reported)?;
        let report = format!(
            "{}\n{}",
            String::from_utf8_lossy(&reported.stdout),
            String::from_utf8_lossy(&reported.stderr)
        );
        ensure!(
            version(&report) == Some(expected),
            "CodeGraph executable did not report the installed version."
        );
        let privacy = installation
            .run(
                scope,
                &root,
                &["telemetry".into(), "off".into()],
                PROBE_LIMIT,
            )
            .await?;
        Installation::succeeded("telemetry off", &privacy)?;
        Ok(installation)
    }
}
