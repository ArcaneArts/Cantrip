use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::Command,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use super::{
    supported_platform, validate_full_sha, SyntheticBuildCoordinator, SyntheticBuildError,
};
use crate::desktop_update::ActiveWorkSummary;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactManifest {
    schema_version: u32,
    component: String,
    target: String,
    version: String,
    commit_sha: String,
    build_id: String,
    built_at: String,
    overlay_digest: String,
    files: Vec<ArtifactFile>,
}

#[derive(Clone, Debug, Deserialize)]
struct ArtifactFile {
    path: String,
    size: Option<u64>,
    sha256: Option<String>,
    link: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedSyntheticBuild {
    id: String,
    version: String,
    commit_sha: String,
    build_id: String,
    built_at: String,
    platform: String,
    overlay_digest: String,
    size_bytes: u64,
    artifact_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticBuildIdentity {
    install_id: String,
    artifact_id: String,
    version: String,
    commit_sha: String,
    build_id: String,
    built_at: String,
    overlay_digest: String,
    installed_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallSyntheticBuildRequest {
    active_work: ActiveWorkSummary,
    confirm_active_work: bool,
}

fn read_manifest(path: &Path) -> Result<ArtifactManifest, SyntheticBuildError> {
    let bytes = fs::read(path.join("artifact.json")).map_err(|error| {
        SyntheticBuildError::new(
            "synthetic_artifact_missing",
            format!("The synthetic artifact manifest could not be read: {error}"),
            true,
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        SyntheticBuildError::new(
            "synthetic_artifact_invalid",
            format!("The synthetic artifact manifest is invalid: {error}"),
            false,
        )
    })
}

fn safe_relative(value: &str) -> bool {
    !value.is_empty()
        && Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn hash_file(path: &Path) -> Result<(u64, String), SyntheticBuildError> {
    let mut file = fs::File::open(path).map_err(|error| {
        SyntheticBuildError::new(
            "synthetic_artifact_invalid",
            format!(
                "Artifact file {} could not be opened: {error}",
                path.display()
            ),
            false,
        )
    })?;
    let mut hash = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            SyntheticBuildError::new(
                "synthetic_artifact_invalid",
                format!(
                    "Artifact file {} could not be verified: {error}",
                    path.display()
                ),
                false,
            )
        })?;
        if read == 0 {
            break;
        }
        size += read as u64;
        hash.update(&buffer[..read]);
    }
    Ok((size, format!("{:x}", hash.finalize())))
}

fn artifact_id(manifest: &ArtifactManifest) -> String {
    format!(
        "{}:{}:{}",
        manifest.target, manifest.commit_sha, manifest.overlay_digest
    )
}

fn verify_artifact(
    root: &Path,
    artifact: &Path,
) -> Result<CachedSyntheticBuild, SyntheticBuildError> {
    let artifacts_root = fs::canonicalize(root.join("artifacts")).map_err(|error| {
        SyntheticBuildError::new("synthetic_cache_unavailable", error.to_string(), true)
    })?;
    let artifact = fs::canonicalize(artifact).map_err(|error| {
        SyntheticBuildError::new("synthetic_artifact_missing", error.to_string(), true)
    })?;
    if !artifact.starts_with(&artifacts_root) {
        return Err(SyntheticBuildError::new(
            "synthetic_artifact_outside_cache",
            "The selected artifact is outside Cantrip's synthetic cache.",
            false,
        ));
    }
    let manifest = read_manifest(&artifact)?;
    if manifest.schema_version != 1
        || manifest.component != "cantrip-synthetic-desktop"
        || manifest.files.is_empty()
        || Some(manifest.target.as_str()) != supported_platform()
        || !manifest.version.ends_with("-x")
        || manifest.build_id.is_empty()
        || validate_full_sha(&manifest.commit_sha).is_err()
    {
        return Err(SyntheticBuildError::new(
            "synthetic_artifact_invalid",
            "The synthetic artifact manifest is incompatible.",
            false,
        ));
    }
    let mut total = 0_u64;
    for entry in &manifest.files {
        if !safe_relative(&entry.path) {
            return Err(SyntheticBuildError::new(
                "synthetic_artifact_invalid",
                "The artifact manifest contains an unsafe path.",
                false,
            ));
        }
        let path = artifact.join("bundle").join(&entry.path);
        if let Some(link) = &entry.link {
            if fs::read_link(&path)
                .ok()
                .as_ref()
                .and_then(|value| value.to_str())
                != Some(link)
            {
                return Err(SyntheticBuildError::new(
                    "synthetic_artifact_corrupt",
                    format!("Artifact link {} did not match its manifest.", entry.path),
                    false,
                ));
            }
        } else {
            let (size, digest) = hash_file(&path)?;
            if entry.size != Some(size) || entry.sha256.as_deref() != Some(&digest) {
                return Err(SyntheticBuildError::new(
                    "synthetic_artifact_corrupt",
                    format!("Artifact file {} did not match its manifest.", entry.path),
                    false,
                ));
            }
            total += size;
        }
    }
    Ok(CachedSyntheticBuild {
        id: artifact_id(&manifest),
        version: manifest.version,
        commit_sha: manifest.commit_sha,
        build_id: manifest.build_id,
        built_at: manifest.built_at,
        platform: manifest.target,
        overlay_digest: manifest.overlay_digest,
        size_bytes: total,
        artifact_path: artifact.to_string_lossy().into_owned(),
    })
}

fn find_manifests(directory: &Path, result: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.join("artifact.json").is_file() {
            result.push(path);
        } else if path.is_dir() {
            find_manifests(&path, result);
        }
    }
}

fn list_verified(root: &Path) -> Vec<CachedSyntheticBuild> {
    let mut paths = Vec::new();
    find_manifests(&root.join("artifacts"), &mut paths);
    let mut builds = paths
        .into_iter()
        .filter_map(|path| verify_artifact(root, &path).ok())
        .collect::<Vec<_>>();
    builds.sort_by(|left, right| right.built_at.cmp(&left.built_at));
    builds
}

fn find_installer(artifact: &Path) -> Result<PathBuf, SyntheticBuildError> {
    let mut candidates = Vec::new();
    fn walk(path: &Path, candidates: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, candidates);
            } else {
                candidates.push(path);
            }
        }
    }
    walk(&artifact.join("bundle"), &mut candidates);
    #[cfg(target_os = "macos")]
    let installer = candidates
        .into_iter()
        .find(|path| path.extension().is_some_and(|value| value == "dmg"));
    #[cfg(target_os = "windows")]
    let installer = candidates
        .into_iter()
        .find(|path| path.extension().is_some_and(|value| value == "exe"));
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let installer: Option<PathBuf> = None;
    installer.ok_or_else(|| {
        SyntheticBuildError::new(
            "synthetic_installer_missing",
            "The verified artifact does not contain an installer for this platform.",
            false,
        )
    })
}

#[cfg(target_os = "macos")]
fn find_macos_application(artifact: &Path) -> Result<PathBuf, SyntheticBuildError> {
    fn walk(path: &Path) -> Option<PathBuf> {
        let entries = fs::read_dir(path).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path.extension().is_some_and(|value| value == "app") {
                return Some(path);
            }
            if path.is_dir() {
                if let Some(found) = walk(&path) {
                    return Some(found);
                }
            }
        }
        None
    }
    walk(&artifact.join("bundle")).ok_or_else(|| {
        SyntheticBuildError::new(
            "synthetic_installer_missing",
            "The verified artifact does not contain a macOS application bundle.",
            false,
        )
    })
}

#[cfg(target_os = "macos")]
fn current_macos_application() -> Result<PathBuf, SyntheticBuildError> {
    let executable = std::env::current_exe().map_err(|error| {
        SyntheticBuildError::new("synthetic_install_path_failed", error.to_string(), false)
    })?;
    executable
        .ancestors()
        .find(|path| path.extension().is_some_and(|value| value == "app"))
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            SyntheticBuildError::new(
                "synthetic_install_path_failed",
                "Cantrip could not locate its current macOS application bundle.",
                false,
            )
        })
}

#[cfg(target_os = "windows")]
fn copy_directory(source: &Path, destination: &Path) -> Result<(), SyntheticBuildError> {
    fs::create_dir_all(destination).map_err(|error| {
        SyntheticBuildError::new("synthetic_rollback_stage_failed", error.to_string(), true)
    })?;
    for entry in fs::read_dir(source).map_err(|error| {
        SyntheticBuildError::new("synthetic_rollback_stage_failed", error.to_string(), true)
    })? {
        let entry = entry.map_err(|error| {
            SyntheticBuildError::new("synthetic_rollback_stage_failed", error.to_string(), true)
        })?;
        let target = destination.join(entry.file_name());
        if entry.path().is_dir() {
            copy_directory(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target).map_err(|error| {
                SyntheticBuildError::new("synthetic_rollback_stage_failed", error.to_string(), true)
            })?;
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn launch_install_handoff(
    artifact: &Path,
    active_identity: &Path,
    install_id: &str,
) -> Result<(), SyntheticBuildError> {
    const SCRIPT: &str = r#"
while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
open -n "$2"
sleep 10
if pgrep -f "$2/Contents/MacOS/" >/dev/null 2>&1; then
  cp "$4" "$5"
  exit 0
fi
open -n "$3"
"#;
    let synthetic_app = find_macos_application(artifact)?;
    let current_app = current_macos_application()?;
    Command::new("/bin/sh")
        .args(["-c", SCRIPT, "cantrip-synthetic-handoff"])
        .arg(std::process::id().to_string())
        .arg(synthetic_app)
        .arg(current_app)
        .arg(active_identity.with_file_name("pending.json"))
        .arg(active_identity)
        .arg(install_id)
        .spawn()
        .map_err(|error| {
            SyntheticBuildError::new(
                "synthetic_installer_launch_failed",
                format!("The synthetic relaunch helper could not start: {error}"),
                true,
            )
        })?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn launch_install_handoff(
    artifact: &Path,
    active_identity: &Path,
    install_id: &str,
    rollback_root: &Path,
) -> Result<(), SyntheticBuildError> {
    const SCRIPT: &str = r#"
param($OldPid, $Installer, $CurrentExe, $RollbackExe, $PendingIdentity, $ActiveIdentity, $InstallId)
Wait-Process -Id $OldPid -ErrorAction SilentlyContinue
$process = Start-Process -FilePath $Installer -PassThru
$process.WaitForExit()
if (Test-Path $CurrentExe) {
  $launched = Start-Process -FilePath $CurrentExe -PassThru
  Start-Sleep -Seconds 10
  if (-not $launched.HasExited) {
    Copy-Item -Force $PendingIdentity $ActiveIdentity
    exit 0
  }
}
if (Test-Path $RollbackExe) { Start-Process -FilePath $RollbackExe }
"#;
    let installer = find_installer(artifact)?;
    let current_exe = std::env::current_exe().map_err(|error| {
        SyntheticBuildError::new("synthetic_install_path_failed", error.to_string(), false)
    })?;
    let install_root = current_exe.parent().ok_or_else(|| {
        SyntheticBuildError::new(
            "synthetic_install_path_failed",
            "Cantrip could not locate its installation folder.",
            false,
        )
    })?;
    let rollback_app = rollback_root.join("app");
    copy_directory(install_root, &rollback_app)?;
    let rollback_exe = rollback_app.join(current_exe.file_name().unwrap_or_default());
    Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .arg(std::process::id().to_string())
        .arg(installer)
        .arg(&current_exe)
        .arg(rollback_exe)
        .arg(active_identity.with_file_name("pending.json"))
        .arg(active_identity)
        .arg(install_id)
        .spawn()
        .map_err(|error| {
            SyntheticBuildError::new(
                "synthetic_installer_launch_failed",
                format!("The synthetic install helper could not start: {error}"),
                true,
            )
        })?;
    Ok(())
}

pub(crate) fn reconcile_identity(root: &Path, running_version: &str) -> Result<(), String> {
    let pending_path = root.join("installs/pending.json");
    let active_path = root.join("installs/active.json");
    if let Ok(bytes) = fs::read(&pending_path) {
        if let Ok(identity) = serde_json::from_slice::<SyntheticBuildIdentity>(&bytes) {
            if identity.version == running_version {
                fs::rename(&pending_path, &active_path).map_err(|error| error.to_string())?;
                return Ok(());
            }
        }
    }
    if let Ok(bytes) = fs::read(&active_path) {
        if serde_json::from_slice::<SyntheticBuildIdentity>(&bytes)
            .ok()
            .is_some_and(|identity| identity.version != running_version)
        {
            let _ = fs::remove_file(active_path);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn list_cached_synthetic_builds(
    coordinator: State<'_, SyntheticBuildCoordinator>,
) -> Vec<CachedSyntheticBuild> {
    list_verified(coordinator.root())
}

#[tauri::command]
pub fn synthetic_build_identity(
    coordinator: State<'_, SyntheticBuildCoordinator>,
) -> Option<SyntheticBuildIdentity> {
    fs::read(coordinator.root().join("installs/active.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

#[tauri::command]
pub fn install_cached_synthetic_build(
    artifact_id: String,
    request: InstallSyntheticBuildRequest,
    app: AppHandle,
    coordinator: State<'_, SyntheticBuildCoordinator>,
) -> Result<String, SyntheticBuildError> {
    if request.active_work.total() > 0 && !request.confirm_active_work {
        return Err(SyntheticBuildError::new(
            "synthetic_install_active_work_confirmation_required",
            format!(
                "Installing will stop {} active Cantrip operation(s). Confirm before continuing.",
                request.active_work.total()
            ),
            true,
        ));
    }
    let artifact = list_verified(coordinator.root())
        .into_iter()
        .find(|item| item.id == artifact_id)
        .ok_or_else(|| {
            SyntheticBuildError::new(
                "synthetic_artifact_missing",
                "The selected cached build is unavailable or failed verification.",
                true,
            )
        })?;
    let artifact_path = PathBuf::from(&artifact.artifact_path);
    let identity = SyntheticBuildIdentity {
        install_id: Uuid::new_v4().to_string(),
        artifact_id: artifact.id,
        version: artifact.version,
        commit_sha: artifact.commit_sha,
        build_id: artifact.build_id,
        built_at: artifact.built_at,
        overlay_digest: artifact.overlay_digest,
        installed_at: Utc::now().to_rfc3339(),
    };
    fs::write(
        coordinator.root().join("installs/pending.json"),
        serde_json::to_vec_pretty(&identity).unwrap(),
    )
    .map_err(|error| {
        SyntheticBuildError::new("synthetic_install_stage_failed", error.to_string(), true)
    })?;
    crate::shutdown_owned_runtime(&app);
    let active_identity = coordinator.root().join("installs/active.json");
    #[cfg(target_os = "macos")]
    launch_install_handoff(&artifact_path, &active_identity, &identity.install_id)?;
    #[cfg(target_os = "windows")]
    launch_install_handoff(
        &artifact_path,
        &active_identity,
        &identity.install_id,
        &coordinator
            .root()
            .join("rollback")
            .join(&identity.install_id),
    )?;
    let _ = app.emit("cantrip-synthetic-build-install", &identity);
    let exit_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        crate::approve_desktop_exit(&exit_app);
        exit_app.exit(0);
    });
    Ok(identity.install_id)
}

#[tauri::command]
pub fn delete_cached_synthetic_build(
    artifact_id: String,
    coordinator: State<'_, SyntheticBuildCoordinator>,
) -> Result<bool, SyntheticBuildError> {
    let active_id = fs::read(coordinator.root().join("installs/active.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<SyntheticBuildIdentity>(&bytes).ok())
        .map(|identity| identity.artifact_id);
    if active_id.as_deref() == Some(&artifact_id) {
        return Err(SyntheticBuildError::new(
            "synthetic_artifact_active",
            "The currently installed synthetic build cannot be deleted.",
            false,
        ));
    }
    let Some(artifact) = list_verified(coordinator.root())
        .into_iter()
        .find(|item| item.id == artifact_id)
    else {
        return Ok(false);
    };
    fs::remove_dir_all(&artifact.artifact_path).map_err(|error| {
        SyntheticBuildError::new("synthetic_artifact_delete_failed", error.to_string(), true)
    })?;
    Ok(true)
}

#[tauri::command]
pub fn open_synthetic_build_log(
    job_id: String,
    coordinator: State<'_, SyntheticBuildCoordinator>,
) -> Result<(), SyntheticBuildError> {
    if !job_id
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || value == '-')
    {
        return Err(SyntheticBuildError::new(
            "synthetic_job_invalid",
            "The build job ID is invalid.",
            false,
        ));
    }
    let path = coordinator
        .root()
        .join("jobs")
        .join(job_id)
        .join("build.log");
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut value = Command::new("open");
        value.arg("-R").arg(path);
        value
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut value = Command::new("explorer");
        value.arg(format!("/select,{}", path.display()));
        value
    };
    command.spawn().map_err(|error| {
        SyntheticBuildError::new("synthetic_log_open_failed", error.to_string(), true)
    })?;
    Ok(())
}

#[tauri::command]
pub fn open_synthetic_build_cache(
    coordinator: State<'_, SyntheticBuildCoordinator>,
) -> Result<(), SyntheticBuildError> {
    let path = coordinator.root();
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut value = Command::new("open");
        value.arg(path);
        value
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut value = Command::new("explorer");
        value.arg(path);
        value
    };
    command.spawn().map_err(|error| {
        SyntheticBuildError::new("synthetic_cache_open_failed", error.to_string(), true)
    })?;
    Ok(())
}

fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                directory_size(&path)
            } else {
                entry.metadata().map_or(0, |metadata| metadata.len())
            }
        })
        .sum()
}

#[tauri::command]
pub fn clean_unused_synthetic_build_cache(
    coordinator: State<'_, SyntheticBuildCoordinator>,
) -> Result<u64, SyntheticBuildError> {
    if coordinator.build_active() {
        return Err(SyntheticBuildError::new(
            "synthetic_build_busy",
            "Wait for the active build to finish before cleaning its cache.",
            true,
        ));
    }
    let before = directory_size(coordinator.root());
    for path in [
        coordinator.root().join("worktrees"),
        coordinator.root().join("stores/cargo-target"),
    ] {
        if path.exists() {
            fs::remove_dir_all(&path).map_err(|error| {
                SyntheticBuildError::new("synthetic_cache_clean_failed", error.to_string(), true)
            })?;
            fs::create_dir_all(&path).map_err(|error| {
                SyntheticBuildError::new("synthetic_cache_clean_failed", error.to_string(), true)
            })?;
        }
    }
    Ok(before.saturating_sub(directory_size(coordinator.root())))
}

#[cfg(test)]
mod tests {
    use super::safe_relative;

    #[test]
    fn artifact_paths_cannot_escape_the_bundle() {
        assert!(safe_relative("nsis/Cantrip.exe"));
        assert!(!safe_relative("../Cantrip.exe"));
        assert!(!safe_relative("/tmp/Cantrip.exe"));
        assert!(!safe_relative("bundle/../Cantrip.exe"));
    }
}
