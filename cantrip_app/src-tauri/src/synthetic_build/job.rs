use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use super::{
    scan_prerequisites, supported_platform, validate_full_sha, SyntheticBuildCoordinator,
    SyntheticBuildError, SyntheticPrerequisiteStatus,
};
use crate::process_environment::configure_desktop_child;

const STATE_EVENT: &str = "cantrip-synthetic-build-state";
const LOG_EVENT: &str = "cantrip-synthetic-build-log-batch";
const MARKER: &str = "::cantrip-synthetic::";
const VERSION_OVERLAY: &str = include_str!("../../../../scripts/version.mjs");
const TAURI_BUILD_OVERLAY: &str = include_str!("../../../../scripts/tauri-build.mjs");
const PIPELINE_OVERLAY: &str = include_str!("../../../../scripts/synthetic-build.mjs");

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyntheticBuildJobState {
    Queued,
    Running,
    ReadyToInstall,
    Failed,
    Cancelled,
}

impl SyntheticBuildJobState {
    fn active(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyntheticBuildStepState {
    Pending,
    Running,
    Complete,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticBuildStep {
    id: String,
    label: String,
    state: SyntheticBuildStepState,
    weight: u8,
    message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticBuildJobError {
    code: String,
    message: String,
    retryable: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticBuildJob {
    id: String,
    target_sha: String,
    version: String,
    platform: String,
    state: SyntheticBuildJobState,
    step_id: Option<String>,
    progress: u8,
    steps: Vec<SyntheticBuildStep>,
    started_at: String,
    updated_at: String,
    artifact_path: Option<String>,
    overlay_digest: String,
    last_log_sequence: u64,
    error: Option<SyntheticBuildJobError>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticBuildStatus {
    job: Option<SyntheticBuildJob>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticBuildLogEntry {
    sequence: u64,
    timestamp: String,
    stream: String,
    message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticBuildLogBatch {
    entries: Vec<SyntheticBuildLogEntry>,
    next_sequence: u64,
    has_more: bool,
}

pub(crate) struct JobRuntime {
    root: PathBuf,
    state: Arc<Mutex<Option<SyntheticBuildJob>>>,
    cancel_requested: Arc<AtomicBool>,
    sequence: Arc<AtomicU64>,
    active_pid: Arc<AtomicU32>,
}

impl JobRuntime {
    pub(super) fn load(root: &Path) -> Result<Self, String> {
        let state_path = root.join("jobs/current.json");
        let mut job = fs::read(&state_path)
            .ok()
            .and_then(|contents| serde_json::from_slice::<SyntheticBuildJob>(&contents).ok());
        if let Some(job) = job.as_mut().filter(|job| job.state.active()) {
            job.state = SyntheticBuildJobState::Failed;
            job.updated_at = Utc::now().to_rfc3339();
            job.error = Some(SyntheticBuildJobError {
                code: "synthetic_build_interrupted".into(),
                message: "The previous synthetic build was interrupted when Cantrip exited.".into(),
                retryable: true,
            });
            persist_job(root, job)?;
        }
        let sequence = job.as_ref().map_or(0, |job| job.last_log_sequence);
        Ok(Self {
            root: root.to_path_buf(),
            state: Arc::new(Mutex::new(job)),
            cancel_requested: Arc::new(AtomicBool::new(false)),
            sequence: Arc::new(AtomicU64::new(sequence)),
            active_pid: Arc::new(AtomicU32::new(0)),
        })
    }

    pub(super) fn snapshot(&self) -> Result<Option<SyntheticBuildJob>, SyntheticBuildError> {
        self.state.lock().map(|state| state.clone()).map_err(|_| {
            SyntheticBuildError::new(
                "synthetic_build_busy",
                "The synthetic build state is busy.",
                true,
            )
        })
    }

    pub(super) fn active(&self) -> bool {
        self.snapshot()
            .ok()
            .flatten()
            .is_some_and(|job| job.state.active())
    }

    fn replace(&self, job: SyntheticBuildJob) -> Result<(), SyntheticBuildError> {
        persist_job(&self.root, &job).map_err(|error| {
            SyntheticBuildError::new("synthetic_build_state_failed", error, true)
        })?;
        let mut state = self.state.lock().map_err(|_| {
            SyntheticBuildError::new(
                "synthetic_build_busy",
                "The synthetic build state is busy.",
                true,
            )
        })?;
        *state = Some(job);
        Ok(())
    }

    pub(super) fn cancel_active(&self) {
        self.cancel_requested.store(true, Ordering::SeqCst);
        let pid = self.active_pid.load(Ordering::SeqCst);
        if pid != 0 {
            terminate_process_group(pid, true);
        }
    }
}

fn build_steps() -> Vec<SyntheticBuildStep> {
    [
        ("resolve-target", "Resolve target", 3),
        ("prepare-source", "Prepare source", 5),
        ("verify-prerequisites", "Verify prerequisites", 4),
        ("install-dependencies", "Install dependencies", 8),
        ("build-codex", "Build Codex runtime", 18),
        ("build-cli", "Build Cantrip CLI", 6),
        ("build-code", "Build Cantrip Code", 18),
        ("build-services", "Build Cantrip services", 14),
        ("build-desktop", "Package Cantrip desktop", 18),
        ("verify-artifact", "Verify synthetic artifact", 4),
        ("stage-install", "Stage synthetic artifact", 2),
    ]
    .into_iter()
    .map(|(id, label, weight)| SyntheticBuildStep {
        id: id.into(),
        label: label.into(),
        state: SyntheticBuildStepState::Pending,
        weight,
        message: None,
    })
    .collect()
}

fn overlay_digest() -> String {
    let mut digest = Sha256::new();
    for (name, contents) in [
        ("scripts/version.mjs", VERSION_OVERLAY),
        ("scripts/tauri-build.mjs", TAURI_BUILD_OVERLAY),
        ("scripts/synthetic-build.mjs", PIPELINE_OVERLAY),
    ] {
        digest.update(name.as_bytes());
        digest.update([0]);
        digest.update(contents.as_bytes());
        digest.update([0]);
    }
    format!("{:x}", digest.finalize())
}

fn persist_job(root: &Path, job: &SyntheticBuildJob) -> Result<(), String> {
    let job_directory = root.join("jobs").join(&job.id);
    fs::create_dir_all(&job_directory)
        .map_err(|error| format!("Could not create {}: {error}", job_directory.display()))?;
    let contents = serde_json::to_vec_pretty(job)
        .map_err(|error| format!("Could not encode synthetic build state: {error}"))?;
    fs::write(job_directory.join("job.json"), &contents)
        .map_err(|error| format!("Could not persist synthetic build state: {error}"))?;
    fs::write(root.join("jobs/current.json"), contents)
        .map_err(|error| format!("Could not persist current synthetic build state: {error}"))
}

fn progress(job: &SyntheticBuildJob) -> u8 {
    job.steps
        .iter()
        .filter(|step| step.state == SyntheticBuildStepState::Complete)
        .map(|step| u16::from(step.weight))
        .sum::<u16>()
        .min(100) as u8
}

fn update_step(
    job: &mut SyntheticBuildJob,
    id: &str,
    state: SyntheticBuildStepState,
    message: Option<String>,
) {
    if let Some(step) = job.steps.iter_mut().find(|step| step.id == id) {
        step.state = state;
        step.message = message;
        job.step_id = matches!(state, SyntheticBuildStepState::Running).then(|| id.to_string());
        job.progress = progress(job);
        job.updated_at = Utc::now().to_rfc3339();
    }
}

fn emit_state(app: &AppHandle, runtime: &JobRuntime, job: &SyntheticBuildJob) {
    let _ = runtime.replace(job.clone());
    let _ = app.emit(STATE_EVENT, job);
}

fn write_overlay(worktree: &Path) -> Result<String, String> {
    let digest = overlay_digest();
    for (relative, contents) in [
        ("scripts/version.mjs", VERSION_OVERLAY),
        ("scripts/tauri-build.mjs", TAURI_BUILD_OVERLAY),
        ("scripts/synthetic-build.mjs", PIPELINE_OVERLAY),
    ] {
        let destination = worktree.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
        }
        fs::write(&destination, contents)
            .map_err(|error| format!("Could not write {}: {error}", destination.display()))?;
    }
    Ok(digest)
}

fn sanitized_build_command(
    worktree: &Path,
    artifact_path: &Path,
    root: &Path,
    job: &SyntheticBuildJob,
) -> Command {
    let mut command = Command::new("node");
    command
        .arg(worktree.join("scripts/synthetic-build.mjs"))
        .arg("--target")
        .arg(&job.platform)
        .arg("--artifact-output")
        .arg(artifact_path)
        .current_dir(worktree)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    for key in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "TMP",
        "TEMP",
        "TMPDIR",
        "SYSTEMROOT",
        "COMSPEC",
        "PATHEXT",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
        "LOCALAPPDATA",
        "APPDATA",
        "INCLUDE",
        "LIB",
        "LIBPATH",
        "VCINSTALLDIR",
        "VSINSTALLDIR",
        "WindowsSdkDir",
        "WindowsSDKVersion",
        "DEVELOPER_DIR",
        "SDKROOT",
        "MACOSX_DEPLOYMENT_TARGET",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .env(
            "CANTRIP_VERSION_PATCH",
            job.version
                .split('.')
                .nth(2)
                .unwrap_or("0")
                .trim_end_matches("-x"),
        )
        .env("CANTRIP_SYNTHETIC_BUILD", "1")
        .env("CANTRIP_SYNTHETIC_COMMIT_SHA", &job.target_sha)
        .env("CANTRIP_SYNTHETIC_BUILT_AT", &job.started_at)
        .env("CANTRIP_SYNTHETIC_BUILD_ID", &job.id)
        .env("CANTRIP_SYNTHETIC_OVERLAY_DIGEST", &job.overlay_digest)
        .env("CANTRIP_SYNTHETIC_VERSION", &job.version)
        .env("CANTRIP_WINDOWS_BUNDLE", "nsis")
        .env("CARGO_HOME", root.join("stores/cargo-home"))
        .env("CARGO_TARGET_DIR", root.join("stores/cargo-target"))
        .env("CANTRIP_CODE_CACHE_DIR", root.join("stores/cantrip-code"))
        .env("pnpm_config_store_dir", root.join("stores/pnpm"));
    configure_desktop_child(&mut command);
    command
}

fn configure_process_group(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = command;
}

fn terminate_process_group(pid: u32, force: bool) {
    #[cfg(unix)]
    unsafe {
        libc::kill(
            -(pid as i32),
            if force { libc::SIGKILL } else { libc::SIGTERM },
        );
    }
    #[cfg(target_os = "windows")]
    {
        let mut taskkill = Command::new("taskkill.exe");
        taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        configure_desktop_child(&mut taskkill);
        let _ = taskkill.status();
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    let _ = (pid, force);
}

fn terminate_process_tree(child: &mut Child) {
    let pid = child.id();
    terminate_process_group(pid, false);

    for _ in 0..20 {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    terminate_process_group(pid, true);
    let _ = child.kill();
}

fn cleanup_worktree(root: &Path, worktree: &Path) {
    let mut reset = Command::new("git");
    reset
        .args(["reset", "--hard", "HEAD"])
        .current_dir(worktree);
    configure_desktop_child(&mut reset);
    let _ = reset.status();
    let mirror = root.join("mirror/cantrip.git");
    let mirror_value = mirror.to_string_lossy();
    let worktree_value = worktree.to_string_lossy();
    let mut remove = Command::new("git");
    remove.args([
        "--git-dir",
        mirror_value.as_ref(),
        "worktree",
        "remove",
        "--force",
        worktree_value.as_ref(),
    ]);
    configure_desktop_child(&mut remove);
    if !remove.status().is_ok_and(|status| status.success()) {
        let _ = fs::remove_dir_all(worktree);
    }
}

fn reader_thread(
    stream: &'static str,
    reader: impl std::io::Read + Send + 'static,
    sender: mpsc::Sender<(&'static str, String)>,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let _ = sender.send((stream, line));
        }
    });
}

fn append_log(
    runtime: &JobRuntime,
    log: &mut File,
    stream: &str,
    message: String,
) -> Option<SyntheticBuildLogEntry> {
    if message.starts_with(MARKER) {
        return None;
    }
    let sequence = runtime.sequence.fetch_add(1, Ordering::SeqCst) + 1;
    let entry = SyntheticBuildLogEntry {
        sequence,
        timestamp: Utc::now().to_rfc3339(),
        stream: stream.into(),
        message: message.chars().take(32_768).collect(),
    };
    if let Ok(encoded) = serde_json::to_string(&entry) {
        let _ = writeln!(log, "{encoded}");
        let _ = log.flush();
    }
    Some(entry)
}

fn process_marker(job: &mut SyntheticBuildJob, line: &str) -> bool {
    let Some(payload) = line.strip_prefix(MARKER) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(payload) else {
        return false;
    };
    if value.get("type").and_then(Value::as_str) == Some("step") {
        let Some(id) = value.get("id").and_then(Value::as_str) else {
            return false;
        };
        let state = match value.get("state").and_then(Value::as_str) {
            Some("running") => SyntheticBuildStepState::Running,
            Some("complete") => SyntheticBuildStepState::Complete,
            Some("failed") => SyntheticBuildStepState::Failed,
            _ => return false,
        };
        update_step(
            job,
            id,
            state,
            value
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string),
        );
        return true;
    }
    false
}

fn run_job(
    app: AppHandle,
    runtime: Arc<JobRuntime>,
    mut job: SyntheticBuildJob,
    worktree: PathBuf,
) {
    let artifact_path = runtime
        .root
        .join("artifacts")
        .join(&job.platform)
        .join(&job.target_sha)
        .join(&job.overlay_digest);
    let log_path = runtime.root.join("jobs").join(&job.id).join("build.log");
    let mut log = match OpenOptions::new().create(true).append(true).open(&log_path) {
        Ok(log) => log,
        Err(error) => {
            job.state = SyntheticBuildJobState::Failed;
            job.error = Some(SyntheticBuildJobError {
                code: "synthetic_build_log_failed".into(),
                message: format!("Could not open the synthetic build log: {error}"),
                retryable: true,
            });
            emit_state(&app, &runtime, &job);
            return;
        }
    };

    job.state = SyntheticBuildJobState::Running;
    emit_state(&app, &runtime, &job);
    let mut command = sanitized_build_command(&worktree, &artifact_path, &runtime.root, &job);
    configure_process_group(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            job.state = SyntheticBuildJobState::Failed;
            job.error = Some(SyntheticBuildJobError {
                code: "synthetic_build_spawn_failed".into(),
                message: format!("Could not start the synthetic build: {error}"),
                retryable: true,
            });
            emit_state(&app, &runtime, &job);
            return;
        }
    };
    runtime.active_pid.store(child.id(), Ordering::SeqCst);
    let (sender, receiver) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        reader_thread("stdout", stdout, sender.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        reader_thread("stderr", stderr, sender);
    }

    let status = loop {
        let mut batch = Vec::new();
        let mut state_changed = false;
        while let Ok((stream, line)) = receiver.try_recv() {
            state_changed |= process_marker(&mut job, &line);
            if let Some(entry) = append_log(&runtime, &mut log, stream, line) {
                job.last_log_sequence = entry.sequence;
                batch.push(entry);
            }
        }
        let has_logs = !batch.is_empty();
        if has_logs {
            let payload = SyntheticBuildLogBatch {
                next_sequence: batch
                    .last()
                    .map_or(job.last_log_sequence, |entry| entry.sequence),
                entries: batch,
                has_more: false,
            };
            let _ = app.emit(LOG_EVENT, payload);
        }
        if state_changed || has_logs {
            emit_state(&app, &runtime, &job);
        }
        if runtime.cancel_requested.load(Ordering::SeqCst) {
            terminate_process_tree(&mut child);
            break None;
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                job.error = Some(SyntheticBuildJobError {
                    code: "synthetic_build_wait_failed".into(),
                    message: format!("Could not inspect the synthetic build: {error}"),
                    retryable: true,
                });
                terminate_process_tree(&mut child);
                break Some(std::process::ExitStatus::default());
            }
        }
    };
    runtime.active_pid.store(0, Ordering::SeqCst);

    for (stream, line) in receiver.try_iter() {
        process_marker(&mut job, &line);
        if let Some(entry) = append_log(&runtime, &mut log, stream, line) {
            job.last_log_sequence = entry.sequence;
        }
    }
    job.step_id = None;
    job.updated_at = Utc::now().to_rfc3339();
    if status.is_none() {
        job.state = SyntheticBuildJobState::Cancelled;
        for step in job.steps.iter_mut().filter(|step| {
            matches!(
                step.state,
                SyntheticBuildStepState::Pending | SyntheticBuildStepState::Running
            )
        }) {
            step.state = SyntheticBuildStepState::Cancelled;
        }
    } else if status.is_some_and(|status| status.success()) {
        job.state = SyntheticBuildJobState::ReadyToInstall;
        job.progress = 100;
        job.artifact_path = Some(artifact_path.to_string_lossy().into_owned());
    } else {
        job.state = SyntheticBuildJobState::Failed;
        if job.error.is_none() {
            job.error = Some(SyntheticBuildJobError {
                code: "synthetic_build_failed".into(),
                message: "The synthetic build failed. Open the build log for details.".into(),
                retryable: true,
            });
        }
    }
    cleanup_worktree(&runtime.root, &worktree);
    emit_state(&app, &runtime, &job);
}

#[tauri::command]
pub async fn start_synthetic_build(
    app: AppHandle,
    sha: String,
    coordinator: State<'_, SyntheticBuildCoordinator>,
) -> Result<SyntheticBuildJob, SyntheticBuildError> {
    if !super::synthetic_build_available() {
        return Err(SyntheticBuildError::unavailable());
    }
    validate_full_sha(&sha)?;
    if coordinator
        .jobs()
        .snapshot()?
        .is_some_and(|job| job.state.active())
    {
        return Err(SyntheticBuildError::new(
            "synthetic_build_busy",
            "Another synthetic build is already running.",
            true,
        ));
    }
    let source = coordinator.resolve_source(sha.clone()).await?;
    let prerequisites = scan_prerequisites(&source.package_manager);
    if prerequisites
        .iter()
        .any(|item| item.status != SyntheticPrerequisiteStatus::Ready)
    {
        return Err(SyntheticBuildError::new(
            "synthetic_prerequisites_required",
            "All synthetic build prerequisites must be ready before building.",
            false,
        ));
    }
    let worktree = coordinator.prepare_worktree(sha.clone()).await?;
    let digest = write_overlay(&worktree)
        .map_err(|error| SyntheticBuildError::new("synthetic_overlay_failed", error, true))?;
    let version = format!(
        "{}.{}.{}-x",
        source.version.major, source.version.minor, source.commit_count
    );
    let now = Utc::now().to_rfc3339();
    let mut job = SyntheticBuildJob {
        id: Uuid::new_v4().to_string(),
        target_sha: sha,
        version,
        platform: supported_platform().unwrap_or("unsupported").into(),
        state: SyntheticBuildJobState::Queued,
        step_id: None,
        progress: 0,
        steps: build_steps(),
        started_at: now.clone(),
        updated_at: now,
        artifact_path: None,
        overlay_digest: digest,
        last_log_sequence: 0,
        error: None,
    };
    for id in ["resolve-target", "prepare-source", "verify-prerequisites"] {
        update_step(&mut job, id, SyntheticBuildStepState::Complete, None);
    }
    coordinator
        .jobs()
        .cancel_requested
        .store(false, Ordering::SeqCst);
    coordinator.jobs().sequence.store(0, Ordering::SeqCst);
    coordinator.jobs().replace(job.clone())?;

    let runtime = Arc::new(JobRuntime {
        root: coordinator.jobs().root.clone(),
        state: Arc::clone(&coordinator.jobs().state),
        cancel_requested: Arc::clone(&coordinator.jobs().cancel_requested),
        sequence: Arc::clone(&coordinator.jobs().sequence),
        active_pid: Arc::clone(&coordinator.jobs().active_pid),
    });
    let task_job = job.clone();
    tauri::async_runtime::spawn_blocking(move || run_job(app, runtime, task_job, worktree));
    Ok(job)
}

#[tauri::command]
pub fn synthetic_build_status(
    coordinator: State<'_, SyntheticBuildCoordinator>,
) -> Result<SyntheticBuildStatus, SyntheticBuildError> {
    Ok(SyntheticBuildStatus {
        job: coordinator.jobs().snapshot()?,
    })
}

#[tauri::command]
pub fn cancel_synthetic_build(
    job_id: String,
    coordinator: State<'_, SyntheticBuildCoordinator>,
) -> Result<bool, SyntheticBuildError> {
    let Some(job) = coordinator.jobs().snapshot()? else {
        return Ok(false);
    };
    if job.id != job_id || !job.state.active() {
        return Ok(false);
    }
    coordinator
        .jobs()
        .cancel_requested
        .store(true, Ordering::SeqCst);
    Ok(true)
}

#[tauri::command]
pub fn synthetic_build_logs(
    after_sequence: Option<u64>,
    limit: Option<usize>,
    coordinator: State<'_, SyntheticBuildCoordinator>,
) -> Result<SyntheticBuildLogBatch, SyntheticBuildError> {
    let Some(job) = coordinator.jobs().snapshot()? else {
        return Ok(SyntheticBuildLogBatch {
            entries: Vec::new(),
            next_sequence: 0,
            has_more: false,
        });
    };
    let after_sequence = after_sequence.unwrap_or(0);
    let limit = limit.unwrap_or(500).clamp(1, 2_000);
    let path = coordinator
        .root()
        .join("jobs")
        .join(job.id)
        .join("build.log");
    let entries = fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<SyntheticBuildLogEntry>(line).ok())
        .filter(|entry| entry.sequence > after_sequence)
        .take(limit + 1)
        .collect::<Vec<_>>();
    let has_more = entries.len() > limit;
    let entries = entries.into_iter().take(limit).collect::<Vec<_>>();
    Ok(SyntheticBuildLogBatch {
        next_sequence: entries
            .last()
            .map_or(after_sequence, |entry| entry.sequence),
        entries,
        has_more,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_weights_cover_the_complete_build() {
        assert_eq!(
            build_steps()
                .iter()
                .map(|step| u16::from(step.weight))
                .sum::<u16>(),
            100
        );
    }

    #[test]
    fn overlay_identity_is_stable_and_sha256_shaped() {
        let digest = overlay_digest();
        assert_eq!(digest.len(), 64);
        assert!(digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
}
