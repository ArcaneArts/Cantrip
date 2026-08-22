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

use super::{SyntheticBuildCoordinator, SyntheticBuildError};
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
    let installer = find_installer(Path::new(&artifact.artifact_path))?;
    let identity = SyntheticBuildIdentity {
        install_id: Uuid::new_v4().to_string(),
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
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut value = Command::new("open");
        value.arg(&installer);
        value
    };
    #[cfg(target_os = "windows")]
    let mut command = Command::new(&installer);
    command.spawn().map_err(|error| {
        SyntheticBuildError::new(
            "synthetic_installer_launch_failed",
            format!("The installer could not be opened: {error}"),
            true,
        )
    })?;
    let _ = app.emit("cantrip-synthetic-build-install", &identity);
    Ok(identity.install_id)
}

#[tauri::command]
pub fn delete_cached_synthetic_build(
    artifact_id: String,
    coordinator: State<'_, SyntheticBuildCoordinator>,
) -> Result<bool, SyntheticBuildError> {
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
