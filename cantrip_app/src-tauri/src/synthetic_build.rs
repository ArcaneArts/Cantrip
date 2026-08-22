#![cfg_attr(debug_assertions, allow(dead_code))]

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{Arc, Mutex},
    time::Duration,
};

use reqwest::{Client, Response};
use serde::{Deserialize, Serialize};
use tauri::{App, Manager, State};

use crate::process_environment::configure_desktop_child;

pub(crate) mod artifact;
pub(crate) mod job;

const COMMITS_URL: &str = "https://api.github.com/repos/ArcaneArts/Cantrip/commits";
const REPOSITORY_URL: &str = "https://github.com/ArcaneArts/Cantrip.git";
const COMMIT_PAGE_SIZE: usize = 50;
const COMMIT_MAX_PAGE: usize = 2_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub struct SyntheticBuildCoordinator {
    root: PathBuf,
    source_lock: Arc<Mutex<()>>,
    jobs: job::JobRuntime,
}

impl SyntheticBuildCoordinator {
    pub fn build(app: &App) -> Result<Self, String> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Could not resolve application data: {error}"))?
            .join("synthetic-builds");
        for directory in [
            root.join("mirror"),
            root.join("worktrees"),
            root.join("toolchains"),
            root.join("stores"),
            root.join("jobs"),
            root.join("artifacts"),
            root.join("installs"),
            root.join("rollback"),
        ] {
            fs::create_dir_all(&directory).map_err(|error| {
                format!(
                    "Could not create synthetic build cache {}: {error}",
                    directory.display()
                )
            })?;
        }
        let jobs = job::JobRuntime::load(&root)?;
        artifact::reconcile_identity(&root, &app.package_info().version.to_string())?;
        Ok(Self {
            root,
            source_lock: Arc::new(Mutex::new(())),
            jobs,
        })
    }

    pub(super) fn root(&self) -> &Path {
        &self.root
    }

    pub(super) fn jobs(&self) -> &job::JobRuntime {
        &self.jobs
    }

    pub(crate) fn cancel_active(&self) {
        self.jobs.cancel_active();
    }

    pub(crate) fn build_active(&self) -> bool {
        self.jobs.active()
    }

    pub(super) async fn resolve_source(
        &self,
        sha: String,
    ) -> Result<SourceMetadata, SyntheticBuildError> {
        let root = self.root.clone();
        let source_lock = Arc::clone(&self.source_lock);
        tokio::task::spawn_blocking(move || {
            let _guard = source_lock.lock().map_err(|_| {
                SyntheticBuildError::new(
                    "synthetic_source_busy",
                    "The synthetic source cache is busy.",
                    true,
                )
            })?;
            resolve_source_from_mirror(&root, &sha)
        })
        .await
        .map_err(|error| {
            SyntheticBuildError::new(
                "synthetic_source_failed",
                format!("The synthetic source task could not be completed: {error}"),
                true,
            )
        })?
    }

    pub(super) async fn prepare_worktree(
        &self,
        sha: String,
    ) -> Result<PathBuf, SyntheticBuildError> {
        let root = self.root.clone();
        let source_lock = Arc::clone(&self.source_lock);
        tokio::task::spawn_blocking(move || {
            let _guard = source_lock.lock().map_err(|_| {
                SyntheticBuildError::new(
                    "synthetic_source_busy",
                    "The synthetic source cache is busy.",
                    true,
                )
            })?;
            prepare_source_worktree(&root, &sha)
        })
        .await
        .map_err(|error| {
            SyntheticBuildError::new(
                "synthetic_source_failed",
                format!("The synthetic worktree task could not be completed: {error}"),
                true,
            )
        })?
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticBuildCapability {
    available: bool,
    platform: Option<&'static str>,
    reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticCommit {
    sha: String,
    short_sha: String,
    subject: String,
    author_name: String,
    authored_at: String,
    commit_count: Option<u64>,
    synthetic_version: Option<String>,
    buildable: Option<bool>,
    reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticCommitPage {
    commits: Vec<SyntheticCommit>,
    next_cursor: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum SyntheticPrerequisiteStatus {
    Ready,
    Missing,
    NeedsAttention,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticPrerequisite {
    id: &'static str,
    label: &'static str,
    status: SyntheticPrerequisiteStatus,
    detected_version: Option<String>,
    required_version: String,
    installation: &'static str,
    install_url: Option<&'static str>,
    message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticPrerequisiteScan {
    target_sha: String,
    ready: bool,
    package_manager: Option<String>,
    prerequisites: Vec<SyntheticPrerequisite>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticBuildError {
    code: &'static str,
    message: String,
    retryable: bool,
}

impl SyntheticBuildError {
    fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }

    fn unavailable() -> Self {
        Self::new(
            "synthetic_build_unavailable",
            synthetic_build_unavailable_reason(),
            false,
        )
    }
}

#[derive(Debug, Deserialize)]
struct GithubCommitIdentity {
    date: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct GithubCommitDetails {
    author: Option<GithubCommitIdentity>,
    committer: Option<GithubCommitIdentity>,
    message: String,
}

#[derive(Debug, Deserialize)]
struct GithubCommit {
    commit: GithubCommitDetails,
    sha: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct VersionConfig {
    pub(crate) major: u64,
    pub(crate) minor: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageConfig {
    package_manager: String,
}

pub(super) struct SourceMetadata {
    pub(super) commit_count: u64,
    pub(super) package_manager: String,
    pub(super) version: VersionConfig,
}

fn command_output(mut command: Command, description: &str) -> Result<Output, SyntheticBuildError> {
    configure_desktop_child(&mut command);
    command.output().map_err(|error| {
        SyntheticBuildError::new(
            "synthetic_prerequisite_missing",
            format!("Could not run {description}: {error}"),
            true,
        )
    })
}

fn git_output(
    arguments: &[&str],
    cwd: Option<&Path>,
    description: &str,
) -> Result<Output, SyntheticBuildError> {
    let mut command = Command::new("git");
    command.args(arguments);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    command_output(command, description)
}

fn require_success(output: Output, description: &str) -> Result<String, SyntheticBuildError> {
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(SyntheticBuildError::new(
        "synthetic_source_failed",
        if detail.is_empty() {
            format!("{description} failed.")
        } else {
            format!("{description} failed: {detail}")
        },
        true,
    ))
}

fn mirror_git_output(
    mirror: &Path,
    arguments: &[&str],
    description: &str,
) -> Result<String, SyntheticBuildError> {
    let mirror = mirror.to_string_lossy();
    let mut complete = vec!["--git-dir", mirror.as_ref()];
    complete.extend_from_slice(arguments);
    require_success(git_output(&complete, None, description)?, description)
}

fn ensure_mirror(root: &Path) -> Result<PathBuf, SyntheticBuildError> {
    let mirror = root.join("mirror").join("cantrip.git");
    if !mirror.join("HEAD").is_file() {
        if mirror.exists() {
            fs::remove_dir_all(&mirror).map_err(|error| {
                SyntheticBuildError::new(
                    "synthetic_source_failed",
                    format!(
                        "Could not replace incomplete source mirror {}: {error}",
                        mirror.display()
                    ),
                    true,
                )
            })?;
        }
        let mirror_path = mirror.to_string_lossy();
        require_success(
            git_output(
                &[
                    "clone",
                    "--mirror",
                    "--filter=blob:none",
                    "--no-tags",
                    REPOSITORY_URL,
                    mirror_path.as_ref(),
                ],
                None,
                "clone the Cantrip source mirror",
            )?,
            "Cloning the Cantrip source mirror",
        )?;
    }
    mirror_git_output(
        &mirror,
        &["remote", "set-url", "origin", REPOSITORY_URL],
        "pin the Cantrip source remote",
    )?;
    mirror_git_output(
        &mirror,
        &[
            "fetch",
            "--no-tags",
            "--prune",
            "--filter=blob:none",
            "origin",
            "+refs/heads/main:refs/remotes/origin/main",
        ],
        "refresh Cantrip main",
    )?;
    Ok(mirror)
}

fn parse_source_metadata(
    commit_count: &str,
    version_json: &str,
    package_json: &str,
) -> Result<SourceMetadata, SyntheticBuildError> {
    let commit_count = commit_count.parse::<u64>().map_err(|_| {
        SyntheticBuildError::new(
            "synthetic_commit_unsupported",
            "The selected commit did not have a valid commit count.",
            false,
        )
    })?;
    let version = serde_json::from_str::<VersionConfig>(version_json).map_err(|error| {
        SyntheticBuildError::new(
            "synthetic_commit_unsupported",
            format!("The selected commit has unsupported version metadata: {error}"),
            false,
        )
    })?;
    let package = serde_json::from_str::<PackageConfig>(package_json).map_err(|error| {
        SyntheticBuildError::new(
            "synthetic_commit_unsupported",
            format!("The selected commit has unsupported package metadata: {error}"),
            false,
        )
    })?;
    if !package.package_manager.starts_with("pnpm@") {
        return Err(SyntheticBuildError::new(
            "synthetic_commit_unsupported",
            "The selected commit does not declare a supported pnpm package manager.",
            false,
        ));
    }
    Ok(SourceMetadata {
        commit_count,
        package_manager: package.package_manager,
        version,
    })
}

fn resolve_source_from_mirror(
    root: &Path,
    sha: &str,
) -> Result<SourceMetadata, SyntheticBuildError> {
    validate_full_sha(sha)?;
    let mirror = ensure_mirror(root)?;
    mirror_git_output(
        &mirror,
        &["cat-file", "-e", &format!("{sha}^{{commit}}")],
        "resolve the selected commit",
    )?;
    let ancestor = {
        let mirror_path = mirror.to_string_lossy();
        git_output(
            &[
                "--git-dir",
                mirror_path.as_ref(),
                "merge-base",
                "--is-ancestor",
                sha,
                "refs/remotes/origin/main",
            ],
            None,
            "verify the selected commit",
        )?
    };
    if !ancestor.status.success() {
        return Err(SyntheticBuildError::new(
            "synthetic_commit_not_on_main",
            "The selected commit is no longer reachable from Cantrip main.",
            false,
        ));
    }
    let commit_count = mirror_git_output(
        &mirror,
        &["rev-list", "--count", sha],
        "calculate the selected commit version",
    )?;
    let version_json = mirror_git_output(
        &mirror,
        &["show", &format!("{sha}:version.json")],
        "read version.json from the selected commit",
    )?;
    let package_json = mirror_git_output(
        &mirror,
        &["show", &format!("{sha}:package.json")],
        "read package.json from the selected commit",
    )?;
    parse_source_metadata(&commit_count, &version_json, &package_json)
}

fn prepare_source_worktree(root: &Path, sha: &str) -> Result<PathBuf, SyntheticBuildError> {
    validate_full_sha(sha)?;
    let mirror = ensure_mirror(root)?;
    let worktree = root.join("worktrees").join(sha);
    let worktree_value = worktree.to_string_lossy();
    let _ = mirror_git_output(
        &mirror,
        &["worktree", "remove", "--force", worktree_value.as_ref()],
        "remove a previous synthetic worktree",
    );
    if worktree.exists() {
        fs::remove_dir_all(&worktree).map_err(|error| {
            SyntheticBuildError::new(
                "synthetic_source_failed",
                format!(
                    "Could not clean previous synthetic worktree {}: {error}",
                    worktree.display()
                ),
                true,
            )
        })?;
    }
    mirror_git_output(&mirror, &["worktree", "prune"], "prune synthetic worktrees")?;
    mirror_git_output(
        &mirror,
        &["worktree", "add", "--detach", worktree_value.as_ref(), sha],
        "prepare the selected synthetic worktree",
    )?;
    Ok(worktree)
}

fn supported_platform() -> Option<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("darwin-arm64")
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Some("win32-x64")
    } else {
        None
    }
}

fn synthetic_build_is_available(desktop: bool, debug: bool, platform: Option<&str>) -> bool {
    desktop && !debug && platform.is_some()
}

fn synthetic_build_available() -> bool {
    synthetic_build_is_available(cfg!(desktop), cfg!(debug_assertions), supported_platform())
}

fn synthetic_build_unavailable_reason() -> String {
    if !cfg!(desktop) {
        "Synthetic builds are available only in the Cantrip desktop app.".into()
    } else if cfg!(debug_assertions) {
        "Synthetic builds are disabled in development builds.".into()
    } else if cfg!(target_os = "macos") {
        "Synthetic builds currently require Apple Silicon macOS.".into()
    } else if cfg!(target_os = "windows") {
        "Synthetic builds currently require 64-bit Windows.".into()
    } else {
        "Synthetic builds are currently supported only on macOS and Windows.".into()
    }
}

fn github_client() -> Result<Client, SyntheticBuildError> {
    Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent("Cantrip-Synthetic-Builder")
        .build()
        .map_err(|error| {
            SyntheticBuildError::new(
                "synthetic_commit_request_failed",
                format!("Could not prepare the Cantrip commit request: {error}"),
                true,
            )
        })
}

async fn github_response(
    request: reqwest::RequestBuilder,
    failure_message: &str,
) -> Result<Response, SyntheticBuildError> {
    request
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .and_then(Response::error_for_status)
        .map_err(|error| {
            SyntheticBuildError::new(
                "synthetic_commit_request_failed",
                format!("{failure_message}: {error}"),
                true,
            )
        })
}

fn parse_cursor(cursor: Option<&str>) -> Result<usize, SyntheticBuildError> {
    let page = cursor.unwrap_or("1").parse::<usize>().map_err(|_| {
        SyntheticBuildError::new(
            "synthetic_commit_cursor_invalid",
            "The commit-list cursor was invalid.",
            false,
        )
    })?;
    if !(1..=COMMIT_MAX_PAGE).contains(&page) {
        return Err(SyntheticBuildError::new(
            "synthetic_commit_cursor_invalid",
            "The commit-list cursor was outside the supported range.",
            false,
        ));
    }
    Ok(page)
}

fn validate_full_sha(sha: &str) -> Result<&str, SyntheticBuildError> {
    if sha.len() != 40
        || !sha
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(SyntheticBuildError::new(
            "synthetic_commit_invalid",
            "A full lowercase 40-character Git commit SHA is required.",
            false,
        ));
    }
    Ok(sha)
}

fn commit_subject(message: &str) -> String {
    message
        .lines()
        .next()
        .unwrap_or("Untitled commit")
        .trim()
        .chars()
        .take(500)
        .collect()
}

fn probe(arguments: &[&str]) -> Option<String> {
    let (program, arguments) = arguments.split_first()?;
    let mut command = Command::new(program);
    command.args(arguments);
    configure_desktop_child(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    (!stdout.is_empty())
        .then_some(stdout)
        .or_else(|| (!stderr.is_empty()).then_some(stderr))
}

fn first_version(value: &str) -> Option<(u64, u64, u64)> {
    value
        .split(|character: char| !(character.is_ascii_digit() || character == '.'))
        .filter(|part| !part.is_empty())
        .find_map(|part| {
            let mut values = part.split('.').map(str::parse::<u64>);
            Some((
                values.next()?.ok()?,
                values.next().transpose().ok().flatten().unwrap_or(0),
                values.next().transpose().ok().flatten().unwrap_or(0),
            ))
        })
}

fn prerequisite(
    id: &'static str,
    label: &'static str,
    detected_version: Option<String>,
    required_version: impl Into<String>,
    ready: impl FnOnce(&str) -> bool,
    installation: &'static str,
    install_url: Option<&'static str>,
) -> SyntheticPrerequisite {
    let status = match detected_version.as_deref() {
        None => SyntheticPrerequisiteStatus::Missing,
        Some(version) if ready(version) => SyntheticPrerequisiteStatus::Ready,
        Some(_) => SyntheticPrerequisiteStatus::NeedsAttention,
    };
    let message = match status {
        SyntheticPrerequisiteStatus::Ready => None,
        SyntheticPrerequisiteStatus::Missing => Some(format!("{label} was not detected.")),
        SyntheticPrerequisiteStatus::NeedsAttention => {
            Some(format!("The detected {label} version is not supported."))
        }
    };
    SyntheticPrerequisite {
        id,
        label,
        status,
        detected_version,
        required_version: required_version.into(),
        installation,
        install_url,
        message,
    }
}

fn scan_prerequisites(package_manager: &str) -> Vec<SyntheticPrerequisite> {
    let pnpm_version = package_manager.trim_start_matches("pnpm@").to_string();
    let mut prerequisites = vec![
        prerequisite(
            "git",
            "Git",
            probe(&["git", "--version"]),
            "Git 2.x",
            |version| first_version(version).is_some_and(|(major, _, _)| major >= 2),
            if cfg!(target_os = "windows") {
                "managed"
            } else {
                "system"
            },
            Some("https://git-scm.com/downloads"),
        ),
        prerequisite(
            "node",
            "Node.js",
            probe(&["node", "--version"]),
            "Node.js 24.x",
            |version| first_version(version).is_some_and(|(major, _, _)| major == 24),
            "managed",
            Some("https://nodejs.org/en/download"),
        ),
        prerequisite(
            "pnpm",
            "pnpm",
            probe(&["pnpm", "--version"]),
            format!("pnpm {pnpm_version}"),
            |version| {
                version
                    .lines()
                    .next()
                    .is_some_and(|line| line.trim() == pnpm_version)
            },
            "managed",
            Some("https://pnpm.io/installation"),
        ),
        prerequisite(
            "rust",
            "Rust",
            probe(&["rustc", "--version"]),
            "Rust 1.95.x",
            |version| {
                first_version(version).is_some_and(|(major, minor, _)| major == 1 && minor == 95)
            },
            "managed",
            Some("https://rustup.rs"),
        ),
    ];

    #[cfg(target_os = "macos")]
    prerequisites.push(prerequisite(
        "native-build-tools",
        "Xcode Command Line Tools",
        probe(&["xcode-select", "-p"]),
        "A selected Xcode developer directory",
        |value| !value.trim().is_empty(),
        "system",
        Some("https://developer.apple.com/xcode/resources/"),
    ));

    #[cfg(target_os = "windows")]
    {
        let vswhere = std::env::var_os("ProgramFiles(x86)")
            .map(PathBuf::from)
            .map(|root| root.join("Microsoft Visual Studio/Installer/vswhere.exe"));
        let visual_studio = vswhere.as_ref().and_then(|vswhere| {
            let program = vswhere.to_string_lossy();
            probe(&[
                program.as_ref(),
                "-latest",
                "-products",
                "*",
                "-requires",
                "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
                "-property",
                "installationPath",
            ])
        });
        prerequisites.push(prerequisite(
            "native-build-tools",
            "Visual Studio C++ Build Tools",
            visual_studio,
            "Visual Studio 2022 C++ tools, Windows SDK, and Spectre libraries",
            |value| !value.trim().is_empty(),
            "system",
            Some("https://visualstudio.microsoft.com/visual-cpp-build-tools/"),
        ));
        prerequisites.push(prerequisite(
            "cmake",
            "CMake",
            probe(&["cmake", "--version"]),
            "CMake 3.x or newer",
            |version| first_version(version).is_some_and(|(major, _, _)| major >= 3),
            "managed",
            Some("https://cmake.org/download/"),
        ));
        prerequisites.push(prerequisite(
            "nasm",
            "NASM",
            probe(&["nasm", "-v"]),
            "NASM 2.x",
            |version| first_version(version).is_some_and(|(major, _, _)| major >= 2),
            "managed",
            Some("https://www.nasm.us/"),
        ));
    }

    prerequisites
}

fn map_commit(commit: GithubCommit) -> Result<SyntheticCommit, SyntheticBuildError> {
    validate_full_sha(&commit.sha)?;
    let identity = commit
        .commit
        .author
        .or(commit.commit.committer)
        .ok_or_else(|| {
            SyntheticBuildError::new(
                "synthetic_commit_invalid",
                format!("Commit {} did not include author metadata.", commit.sha),
                true,
            )
        })?;
    Ok(SyntheticCommit {
        short_sha: commit.sha.chars().take(8).collect(),
        sha: commit.sha,
        subject: commit_subject(&commit.commit.message),
        author_name: identity.name,
        authored_at: identity.date,
        commit_count: None,
        synthetic_version: None,
        buildable: None,
        reason: None,
    })
}

#[tauri::command]
pub fn synthetic_build_capability() -> SyntheticBuildCapability {
    let platform = supported_platform();
    SyntheticBuildCapability {
        available: synthetic_build_available(),
        platform,
        reason: (!synthetic_build_available()).then(synthetic_build_unavailable_reason),
    }
}

#[tauri::command]
pub async fn scan_synthetic_build_prerequisites(
    sha: String,
    coordinator: State<'_, SyntheticBuildCoordinator>,
) -> Result<SyntheticPrerequisiteScan, SyntheticBuildError> {
    if !synthetic_build_available() {
        return Err(SyntheticBuildError::unavailable());
    }
    validate_full_sha(&sha)?;
    let preliminary = scan_prerequisites("pnpm@11.15.1");
    let git_ready = preliminary.iter().any(|prerequisite| {
        prerequisite.id == "git" && prerequisite.status == SyntheticPrerequisiteStatus::Ready
    });
    if !git_ready {
        return Ok(SyntheticPrerequisiteScan {
            target_sha: sha,
            ready: false,
            package_manager: None,
            prerequisites: preliminary,
        });
    }

    let source = coordinator.resolve_source(sha.clone()).await?;
    let prerequisites = scan_prerequisites(&source.package_manager);
    let ready = prerequisites
        .iter()
        .all(|prerequisite| prerequisite.status == SyntheticPrerequisiteStatus::Ready);
    Ok(SyntheticPrerequisiteScan {
        target_sha: sha,
        ready,
        package_manager: Some(source.package_manager),
        prerequisites,
    })
}

#[tauri::command]
pub async fn list_synthetic_build_commits(
    cursor: Option<String>,
) -> Result<SyntheticCommitPage, SyntheticBuildError> {
    if !synthetic_build_available() {
        return Err(SyntheticBuildError::unavailable());
    }
    let page = parse_cursor(cursor.as_deref())?;
    let client = github_client()?;
    let response = github_response(
        client.get(COMMITS_URL).query(&[
            ("sha", "main".to_string()),
            ("per_page", COMMIT_PAGE_SIZE.to_string()),
            ("page", page.to_string()),
        ]),
        "Could not load commits from Cantrip main",
    )
    .await?;
    let commits = response
        .json::<Vec<GithubCommit>>()
        .await
        .map_err(|error| {
            SyntheticBuildError::new(
                "synthetic_commit_invalid",
                format!("The Cantrip commit list was invalid: {error}"),
                true,
            )
        })?;
    let count = commits.len();
    let commits = commits
        .into_iter()
        .map(map_commit)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SyntheticCommitPage {
        commits,
        next_cursor: (count == COMMIT_PAGE_SIZE).then(|| (page + 1).to_string()),
    })
}

#[tauri::command]
pub async fn resolve_synthetic_build_target(
    sha: String,
    coordinator: State<'_, SyntheticBuildCoordinator>,
) -> Result<SyntheticCommit, SyntheticBuildError> {
    if !synthetic_build_available() {
        return Err(SyntheticBuildError::unavailable());
    }
    let sha = validate_full_sha(&sha)?.to_string();
    let client = github_client()?;
    let commit_response = github_response(
        client.get(format!("{COMMITS_URL}/{sha}")),
        "Could not resolve the selected Cantrip commit",
    )
    .await?;
    let mut commit = map_commit(commit_response.json::<GithubCommit>().await.map_err(
        |error| {
            SyntheticBuildError::new(
                "synthetic_commit_invalid",
                format!("The selected Cantrip commit was invalid: {error}"),
                true,
            )
        },
    )?)?;

    let source = coordinator.resolve_source(sha).await?;
    commit.commit_count = Some(source.commit_count);
    commit.synthetic_version = Some(format!(
        "{}.{}.{}-x",
        source.version.major, source.version.minor, source.commit_count
    ));
    commit.buildable = Some(true);
    Ok(commit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_requires_packaged_supported_desktop() {
        assert!(synthetic_build_is_available(
            true,
            false,
            Some("darwin-arm64")
        ));
        assert!(!synthetic_build_is_available(
            false,
            false,
            Some("darwin-arm64")
        ));
        assert!(!synthetic_build_is_available(
            true,
            true,
            Some("darwin-arm64")
        ));
        assert!(!synthetic_build_is_available(true, false, None));
    }

    #[test]
    fn validates_full_immutable_commit_sha() {
        assert!(validate_full_sha("0123456789abcdef0123456789abcdef01234567").is_ok());
        assert!(validate_full_sha("0123456").is_err());
        assert!(validate_full_sha("0123456789ABCDEF0123456789abcdef01234567").is_err());
    }

    #[test]
    fn parses_source_build_metadata() {
        let metadata = parse_source_metadata(
            "1375",
            r#"{"major":1,"minor":2}"#,
            r#"{"packageManager":"pnpm@11.15.1"}"#,
        )
        .expect("source metadata should parse");
        assert_eq!(metadata.commit_count, 1375);
        assert_eq!(metadata.version.major, 1);
        assert_eq!(metadata.version.minor, 2);
        assert_eq!(metadata.package_manager, "pnpm@11.15.1");
        assert!(parse_source_metadata(
            "1375",
            r#"{"major":1,"minor":2}"#,
            r#"{"packageManager":"npm@11.0.0"}"#,
        )
        .is_err());
    }

    #[test]
    fn parses_tool_versions_without_trusting_labels() {
        assert_eq!(first_version("git version 2.51.0"), Some((2, 51, 0)));
        assert_eq!(first_version("v24.4.1"), Some((24, 4, 1)));
        assert_eq!(first_version("unknown"), None);
    }

    #[test]
    fn truncates_commit_messages_to_a_subject() {
        assert_eq!(
            commit_subject("  Subject line  \n\nDetails"),
            "Subject line"
        );
        assert_eq!(commit_subject(""), "Untitled commit");
    }
}
