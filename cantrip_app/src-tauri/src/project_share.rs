use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::{AppHandle, State};
use url::Url;
use zeroize::Zeroize;

use crate::{
    desktop_worker::{
        normalize_server_url, resolve_chat_scratch_directory, resolve_project_directory,
        DesktopWorkerProjectStorage, DesktopWorkers, LocalProjectDirectoryResolution,
    },
    ManagedRuntime,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealProjectShareRequest {
    attachment_id: String,
    mount_lease_ms: u64,
    password: String,
    project_id: String,
    project_name: String,
    #[serde(default)]
    relative_path: String,
    url: String,
    username: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealLocalProjectFolderRequest {
    folder_management: Option<LocalProjectFolderManagement>,
    path: String,
    #[serde(default)]
    placement_mode: LocalProjectPlacementMode,
    #[serde(default)]
    relative_path: String,
    server_url: String,
    source_kind: LocalProjectSourceKind,
    worker_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocalProjectRevealResult {
    Opened,
    WorkerNotLocal,
    ServerMismatch,
    SourcePathMissing,
    OutsideManagedRoot,
    ExplorerLaunchFailed,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealLocalChatScratchRequest {
    chat_id: String,
    #[serde(default)]
    relative_path: String,
    server_url: String,
    worker_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealChatShareRequest {
    attachment_id: String,
    chat_id: String,
    chat_name: String,
    mount_lease_ms: u64,
    password: String,
    #[serde(default)]
    relative_path: String,
    url: String,
    username: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum LocalProjectSourceKind {
    Folder,
    Git,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum LocalProjectFolderManagement {
    External,
    Managed,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum LocalProjectPlacementMode {
    Direct,
    #[default]
    Managed,
    ManagedLink,
}

fn local_project_storage(
    source_kind: LocalProjectSourceKind,
    folder_management: Option<LocalProjectFolderManagement>,
    placement_mode: LocalProjectPlacementMode,
) -> DesktopWorkerProjectStorage {
    match (source_kind, folder_management, placement_mode) {
        (LocalProjectSourceKind::Folder, Some(LocalProjectFolderManagement::External), _) => {
            DesktopWorkerProjectStorage::ExternalFolder
        }
        (LocalProjectSourceKind::Folder, _, _) => DesktopWorkerProjectStorage::Folders,
        (LocalProjectSourceKind::Git, _, LocalProjectPlacementMode::Direct) => {
            DesktopWorkerProjectStorage::ExternalFolder
        }
        (LocalProjectSourceKind::Git, _, _) => DesktopWorkerProjectStorage::Repositories,
    }
}

struct MountedProjectShare {
    attachment_id: String,
    expires_at: Instant,
    location: NativeMount,
    url: String,
}

enum NativeMount {
    #[cfg(target_os = "macos")]
    MacOs(PathBuf),
    #[cfg(windows)]
    Windows { remote: String },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NativeRevealTargetKind {
    Directory,
    File,
}

#[derive(Debug, Eq, PartialEq)]
struct NativeRevealTarget {
    kind: NativeRevealTargetKind,
    path: PathBuf,
}

#[derive(Default)]
pub struct ProjectShareMounts {
    mounts: Arc<Mutex<HashMap<String, MountedProjectShare>>>,
}

const MAX_NATIVE_MOUNT_LEASE_MS: u64 = 24 * 60 * 60_000;

impl ProjectShareMounts {
    pub fn cleanup(&self) {
        let mounts = match self.mounts.lock() {
            Ok(mut mounts) => mounts.drain().map(|(_, mount)| mount).collect::<Vec<_>>(),
            Err(_) => return,
        };
        for mount in mounts {
            let _ = release_native_mount(&mount.location);
        }
    }
}

#[tauri::command]
pub async fn reveal_project_share(
    app: AppHandle,
    state: State<'_, ProjectShareMounts>,
    request: RevealProjectShareRequest,
) -> Result<(), String> {
    let mounts = Arc::clone(&state.mounts);
    tauri::async_runtime::spawn_blocking(move || {
        reveal_project_share_blocking(&app, mounts, request)
    })
    .await
    .map_err(|error| format!("Could not join the native project reveal task: {error}"))?
}

#[tauri::command]
pub async fn reveal_chat_share(
    app: AppHandle,
    state: State<'_, ProjectShareMounts>,
    request: RevealChatShareRequest,
) -> Result<(), String> {
    let mounts = Arc::clone(&state.mounts);
    let request = RevealProjectShareRequest {
        attachment_id: request.attachment_id,
        mount_lease_ms: request.mount_lease_ms,
        password: request.password,
        project_id: format!("chat:{}", request.chat_id),
        project_name: request.chat_name,
        relative_path: request.relative_path,
        url: request.url,
        username: request.username,
    };
    tauri::async_runtime::spawn_blocking(move || {
        reveal_project_share_blocking(&app, mounts, request)
    })
    .await
    .map_err(|error| format!("Could not join the native Chat reveal task: {error}"))?
}

#[tauri::command]
pub async fn reveal_local_project_folder(
    runtime: State<'_, ManagedRuntime>,
    workers: State<'_, DesktopWorkers>,
    request: RevealLocalProjectFolderRequest,
) -> Result<LocalProjectRevealResult, String> {
    let Ok(server_url) = normalize_server_url(&request.server_url) else {
        return Ok(LocalProjectRevealResult::ServerMismatch);
    };
    let storage = local_project_storage(
        request.source_kind,
        request.folder_management,
        request.placement_mode,
    );
    let requested_path = std::path::Path::new(&request.path);
    let bundled_project = runtime
        .local_worker_data_directory(&server_url, &request.worker_id)
        .map(|data_directory| resolve_project_directory(data_directory, storage, requested_path));
    let linked_project = workers.resolve_project_directory(
        &server_url,
        &request.worker_id,
        storage,
        requested_path,
    )?;
    let resolution = [bundled_project, linked_project]
        .into_iter()
        .flatten()
        .reduce(|current, candidate| match (current, candidate) {
            (LocalProjectDirectoryResolution::Resolved(path), _) => {
                LocalProjectDirectoryResolution::Resolved(path)
            }
            (_, LocalProjectDirectoryResolution::Resolved(path)) => {
                LocalProjectDirectoryResolution::Resolved(path)
            }
            (LocalProjectDirectoryResolution::OutsideManagedRoot, _)
            | (_, LocalProjectDirectoryResolution::OutsideManagedRoot) => {
                LocalProjectDirectoryResolution::OutsideManagedRoot
            }
            _ => LocalProjectDirectoryResolution::SourcePathMissing,
        });
    let project_directory = match resolution {
        Some(LocalProjectDirectoryResolution::Resolved(path)) => path,
        Some(LocalProjectDirectoryResolution::SourcePathMissing) => {
            return Ok(LocalProjectRevealResult::SourcePathMissing);
        }
        Some(LocalProjectDirectoryResolution::OutsideManagedRoot) => {
            return Ok(LocalProjectRevealResult::OutsideManagedRoot);
        }
        None if runtime.has_local_worker_identity(&request.worker_id)
            || workers.has_worker_identity(&request.worker_id)? =>
        {
            return Ok(LocalProjectRevealResult::ServerMismatch);
        }
        None => return Ok(LocalProjectRevealResult::WorkerNotLocal),
    };
    let reveal_target = match resolve_reveal_target(&project_directory, &request.relative_path) {
        Ok(target) => target,
        Err(_) => return Ok(LocalProjectRevealResult::SourcePathMissing),
    };
    match tauri::async_runtime::spawn_blocking(move || open_local_project_target(&reveal_target))
        .await
    {
        Ok(Ok(())) => Ok(LocalProjectRevealResult::Opened),
        Ok(Err(_)) | Err(_) => Ok(LocalProjectRevealResult::ExplorerLaunchFailed),
    }
}

#[tauri::command]
pub async fn reveal_local_chat_scratch(
    runtime: State<'_, ManagedRuntime>,
    workers: State<'_, DesktopWorkers>,
    request: RevealLocalChatScratchRequest,
) -> Result<bool, String> {
    let Ok(server_url) = normalize_server_url(&request.server_url) else {
        return Ok(false);
    };
    let bundled_scratch = runtime
        .local_worker_data_directory(&server_url, &request.worker_id)
        .and_then(|data_directory| {
            resolve_chat_scratch_directory(data_directory, &request.chat_id)
        });
    let scratch_directory = match bundled_scratch {
        Some(directory) => Some(directory),
        None => workers.resolve_chat_scratch_directory(
            &server_url,
            &request.worker_id,
            &request.chat_id,
        )?,
    };
    let Some(scratch_directory) = scratch_directory else {
        return Ok(false);
    };
    let reveal_target = resolve_chat_reveal_target(&scratch_directory, &request.relative_path)?;
    tauri::async_runtime::spawn_blocking(move || open_local_project_target(&reveal_target))
        .await
        .map_err(|error| format!("Could not join the local Chat reveal task: {error}"))??;
    Ok(true)
}

fn reveal_project_share_blocking(
    app: &AppHandle,
    mount_registry: Arc<Mutex<HashMap<String, MountedProjectShare>>>,
    mut request: RevealProjectShareRequest,
) -> Result<(), String> {
    let result = (|| {
        let url = validate_request(&request)?;
        let expires_at = mount_expiration_deadline(request.mount_lease_ms)?;
        let mut mounts = mount_registry
            .lock()
            .map_err(|_| "The native project mount registry is unavailable.".to_string())?;

        if let Some(existing) = mounts.get_mut(&request.project_id) {
            if existing.attachment_id == request.attachment_id
                && existing.url == request.url
                && native_mount_is_active(&existing.location)
            {
                let reschedule = expires_at < existing.expires_at;
                if reschedule {
                    existing.expires_at = expires_at;
                }
                let opened = open_native_mount(&existing.location, &request.relative_path);
                drop(mounts);
                if reschedule {
                    schedule_native_mount_expiration(
                        Arc::clone(&mount_registry),
                        request.project_id.clone(),
                        request.attachment_id.clone(),
                        expires_at,
                    );
                }
                return opened;
            }
        }

        if let Some(stale) = mounts.remove(&request.project_id) {
            release_native_mount(&stale.location)?;
        }

        let location = create_native_mount(app, &request, &url)?;
        if let Err(error) = open_native_mount(&location, &request.relative_path) {
            let _ = release_native_mount(&location);
            return Err(error);
        }
        mounts.insert(
            request.project_id.clone(),
            MountedProjectShare {
                attachment_id: request.attachment_id.clone(),
                expires_at,
                location,
                url: request.url.clone(),
            },
        );
        drop(mounts);
        schedule_native_mount_expiration(
            Arc::clone(&mount_registry),
            request.project_id.clone(),
            request.attachment_id.clone(),
            expires_at,
        );
        Ok(())
    })();
    request.password.zeroize();
    result
}

fn mount_expiration_deadline(mount_lease_ms: u64) -> Result<Instant, String> {
    if mount_lease_ms == 0 || mount_lease_ms > MAX_NATIVE_MOUNT_LEASE_MS {
        return Err("The project share mount lease is invalid.".into());
    }
    Instant::now()
        .checked_add(Duration::from_millis(mount_lease_ms))
        .ok_or_else(|| "The project share mount lease is invalid.".to_string())
}

fn schedule_native_mount_expiration(
    mounts: Arc<Mutex<HashMap<String, MountedProjectShare>>>,
    project_id: String,
    attachment_id: String,
    expires_at: Instant,
) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep_until(expires_at.into()).await;
        let expired = match mounts.lock() {
            Ok(mut mounts) => {
                let should_remove = mounts.get(&project_id).is_some_and(|mount| {
                    mount.attachment_id == attachment_id && mount.expires_at <= Instant::now()
                });
                should_remove.then(|| mounts.remove(&project_id)).flatten()
            }
            Err(_) => None,
        };
        if let Some(mount) = expired {
            let _ = release_native_mount(&mount.location);
        }
    });
}

fn validate_request(request: &RevealProjectShareRequest) -> Result<Url, String> {
    if request.attachment_id.is_empty()
        || request.attachment_id.len() > 64
        || !request
            .attachment_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("The project share attachment identifier is invalid.".into());
    }
    if request.project_id.is_empty() || request.project_id.len() > 200 {
        return Err("The project identifier is invalid.".into());
    }
    if request.username.is_empty() || request.username.len() > 128 {
        return Err("The project share username is invalid.".into());
    }
    if request.password.len() < 24 || request.password.len() > 256 {
        return Err("The project share password is invalid.".into());
    }
    if request.project_name.len() > 512 {
        return Err("The project name is too long to reveal.".into());
    }
    validate_relative_reveal_path(&request.relative_path)?;

    let url = validate_share_url(&request.url)?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
        return Err("Project shares must terminate on the protected local tunnel.".into());
    }
    Ok(url)
}

fn validate_relative_reveal_path(relative_path: &str) -> Result<Vec<&str>, String> {
    if relative_path.len() > 8_192
        || relative_path.contains('\0')
        || relative_path.starts_with('/')
        || relative_path.contains('\\')
        || matches!(
            relative_path.as_bytes(),
            [drive, b':', ..] if drive.is_ascii_alphabetic()
        )
    {
        return Err("The requested project folder path is invalid.".into());
    }
    let segments = relative_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments
        .iter()
        .any(|segment| matches!(*segment, "." | ".."))
    {
        return Err("The requested project folder path is invalid.".into());
    }
    Ok(segments)
}

fn resolve_reveal_target(
    root: &std::path::Path,
    relative_path: &str,
) -> Result<NativeRevealTarget, String> {
    let path = validate_relative_reveal_path(relative_path)?
        .into_iter()
        .fold(root.to_path_buf(), |path, segment| path.join(segment));
    let metadata = std::fs::metadata(&path).map_err(|error| {
        format!(
            "The requested project path is unavailable ({}): {error}",
            path.display()
        )
    })?;
    let kind = if metadata.is_dir() {
        NativeRevealTargetKind::Directory
    } else if metadata.is_file() {
        NativeRevealTargetKind::File
    } else {
        return Err("The requested project path is not a file or folder.".into());
    };
    Ok(NativeRevealTarget { kind, path })
}

fn resolve_chat_reveal_target(
    root: &std::path::Path,
    relative_path: &str,
) -> Result<NativeRevealTarget, String> {
    let canonical_root = std::fs::canonicalize(root).map_err(|error| {
        format!(
            "The Chat scratch folder is unavailable ({}): {error}",
            root.display()
        )
    })?;
    let mut path = canonical_root.clone();
    for segment in validate_relative_reveal_path(relative_path)? {
        path.push(segment);
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
            format!(
                "The requested Chat file is unavailable ({}): {error}",
                path.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err("Chat file reveal does not follow symbolic links.".into());
        }
    }
    let canonical_path = std::fs::canonicalize(&path).map_err(|error| {
        format!(
            "The requested Chat file is unavailable ({}): {error}",
            path.display()
        )
    })?;
    if canonical_path != canonical_root && !canonical_path.starts_with(&canonical_root) {
        return Err("The requested Chat file is outside its scratch folder.".into());
    }
    let metadata = std::fs::metadata(&canonical_path).map_err(|error| {
        format!(
            "The requested Chat file is unavailable ({}): {error}",
            canonical_path.display()
        )
    })?;
    let kind = if metadata.is_dir() {
        NativeRevealTargetKind::Directory
    } else if metadata.is_file() {
        NativeRevealTargetKind::File
    } else {
        return Err("The requested Chat path is not a file or folder.".into());
    };
    Ok(NativeRevealTarget {
        kind,
        path: canonical_path,
    })
}

fn validate_share_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value)
        .map_err(|_| "The server returned an invalid project share URL.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("The server returned an unsafe project share URL.".into());
    }
    let path = url.path().strip_suffix('/').unwrap_or(url.path());
    let token = path
        .strip_prefix("/project-shares/")
        .filter(|value| !value.contains('/'))
        .ok_or_else(|| "The server returned an unexpected project share path.".to_string())?;
    if token.len() != 43
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("The server returned an invalid project share token.".into());
    }
    Ok(url)
}

#[cfg(any(target_os = "macos", test))]
fn project_volume_name(project_name: &str) -> String {
    let name = project_name
        .chars()
        .filter(|character| !character.is_control() && !matches!(character, '/' | ':' | '\\'))
        .take(80)
        .collect::<String>();
    let name = name.trim();
    if name.is_empty() {
        "Cantrip Project".into()
    } else {
        format!("Cantrip - {name}")
    }
}

#[cfg(target_os = "macos")]
fn create_native_mount(
    app: &AppHandle,
    request: &RevealProjectShareRequest,
    url: &Url,
) -> Result<NativeMount, String> {
    use std::{
        fs::{self, OpenOptions},
        io::{Seek, SeekFrom, Write},
        os::unix::fs::OpenOptionsExt,
        process::{Command, Stdio},
        time::{SystemTime, UNIX_EPOCH},
    };

    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve Cantrip's data directory: {error}"))?
        .join("project-shares");
    fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create {}: {error}", root.display()))?;
    let mount_path = root.join(&request.attachment_id);
    if fs::symlink_metadata(&mount_path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("The project share mount path is a symbolic link.".into());
    }
    fs::create_dir_all(&mount_path)
        .map_err(|error| format!("Could not create {}: {error}", mount_path.display()))?;

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let credentials_path = root.join(format!(
        ".credentials-{}-{}-{nonce}",
        std::process::id(),
        request.attachment_id
    ));
    let mut credentials_file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(&credentials_path)
        .map_err(|error| format!("Could not prepare project share credentials: {error}"))?;
    let mut credentials = encode_mount_webdav_credentials(&request.username, &request.password);
    let operation = (|| {
        credentials_file
            .write_all(&credentials)
            .and_then(|_| credentials_file.flush())
            .map_err(|error| format!("Could not prepare project share credentials: {error}"))?;
        credentials_file
            .seek(SeekFrom::Start(0))
            .map_err(|error| format!("Could not prepare project share credentials: {error}"))?;
        let credentials_input = credentials_file
            .try_clone()
            .map_err(|error| format!("Could not prepare project share credentials: {error}"))?;
        let output = Command::new("/sbin/mount_webdav")
            .args(["-S", "-a", "0", "-v"])
            .arg(project_volume_name(&request.project_name))
            .arg(url.as_str())
            .arg(&mount_path)
            .stdin(Stdio::from(credentials_input))
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|error| format!("Could not start the macOS WebDAV mounter: {error}"))?;
        if !output.status.success() {
            // mount_webdav receives the capability URL on argv. Keep its stderr out
            // of user-facing errors in case a platform release echoes that URL.
            return Err(format!(
                "macOS could not mount the project share (exit status {}).",
                output.status
            ));
        }
        Ok(NativeMount::MacOs(mount_path.clone()))
    })();

    let credential_length = credentials.len();
    credentials.zeroize();
    let _ = credentials_file.seek(SeekFrom::Start(0));
    let _ = credentials_file.write_all(&vec![0_u8; credential_length]);
    let _ = credentials_file.sync_data();
    drop(credentials_file);
    let _ = fs::remove_file(&credentials_path);
    if operation.is_err() {
        let _ = fs::remove_dir(&mount_path);
    }
    operation
}

#[cfg(target_os = "macos")]
fn encode_mount_webdav_credentials(username: &str, password: &str) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(username.len() + password.len() + 20);
    for value in [username.as_bytes(), password.as_bytes(), &[], &[], &[]] {
        encoded.extend_from_slice(&(value.len() as u32).to_be_bytes());
        encoded.extend_from_slice(value);
    }
    encoded
}

#[cfg(target_os = "macos")]
fn native_mount_is_active(location: &NativeMount) -> bool {
    use std::os::unix::fs::MetadataExt;

    let NativeMount::MacOs(path) = location;
    let Some(parent) = path.parent() else {
        return false;
    };
    match (std::fs::metadata(path), std::fs::metadata(parent)) {
        (Ok(mount), Ok(parent)) => mount.dev() != parent.dev(),
        _ => false,
    }
}

#[cfg(target_os = "macos")]
fn open_native_mount(location: &NativeMount, relative_path: &str) -> Result<(), String> {
    let NativeMount::MacOs(path) = location;
    reveal_native_target(&resolve_reveal_target(path, relative_path)?)
}

#[cfg(target_os = "macos")]
fn release_native_mount(location: &NativeMount) -> Result<(), String> {
    use std::process::{Command, Stdio};

    let NativeMount::MacOs(path) = location;
    if native_mount_is_active(location) {
        let output = Command::new("/sbin/umount")
            .arg(path)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|error| format!("Could not start the macOS unmount command: {error}"))?;
        if !output.status.success() {
            return Err(process_failure(
                "macOS could not release the previous project share",
                &output,
            ));
        }
    }
    std::fs::remove_dir(path)
        .or_else(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(error)
            }
        })
        .map_err(|error| format!("Could not clean up {}: {error}", path.display()))
}

#[cfg(windows)]
fn create_native_mount(
    _app: &AppHandle,
    request: &RevealProjectShareRequest,
    url: &Url,
) -> Result<NativeMount, String> {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR},
        NetworkManagement::{
            WNet::{WNetAddConnection2W, CONNECT_TEMPORARY, NETRESOURCEW, RESOURCETYPE_DISK},
            WebDav::DavGetUNCFromHTTPPath,
        },
    };

    let mut url_wide = wide(url.as_str());
    let mut remote_length = 0_u32;
    let first_result =
        unsafe { DavGetUNCFromHTTPPath(url_wide.as_ptr(), ptr::null_mut(), &mut remote_length) };
    if first_result != ERROR_INSUFFICIENT_BUFFER || remote_length == 0 {
        url_wide.zeroize();
        return Err(windows_error(
            "Windows could not translate the project share URL",
            first_result,
        ));
    }
    let mut remote_wide = vec![0_u16; remote_length as usize];
    let conversion_result = unsafe {
        DavGetUNCFromHTTPPath(
            url_wide.as_ptr(),
            remote_wide.as_mut_ptr(),
            &mut remote_length,
        )
    };
    url_wide.zeroize();
    if conversion_result != NO_ERROR {
        remote_wide.zeroize();
        return Err(windows_error(
            "Windows could not translate the project share URL",
            conversion_result,
        ));
    }
    let remote = String::from_utf16_lossy(
        &remote_wide[..remote_wide
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(remote_wide.len())],
    );
    let mut username_wide = wide(&request.username);
    let mut password_wide = wide(&request.password);
    let resource = NETRESOURCEW {
        dwType: RESOURCETYPE_DISK,
        // Drive-letter DOS devices are scoped to a Windows logon session and
        // may not exist in the Explorer shell that handles the reveal request.
        lpLocalName: ptr::null_mut(),
        lpRemoteName: remote_wide.as_mut_ptr(),
        ..Default::default()
    };
    let connection_result = unsafe {
        WNetAddConnection2W(
            &resource,
            password_wide.as_ptr(),
            username_wide.as_ptr(),
            CONNECT_TEMPORARY,
        )
    };
    username_wide.zeroize();
    password_wide.zeroize();
    remote_wide.zeroize();
    if connection_result != NO_ERROR {
        return Err(windows_error(
            "Windows could not mount the project share",
            connection_result,
        ));
    }
    if let Err(error) = std::fs::metadata(&remote) {
        let location = NativeMount::Windows { remote };
        let _ = release_native_mount(&location);
        return Err(format!(
            "Windows connected to the project share but could not access it ({error})."
        ));
    }
    Ok(NativeMount::Windows { remote })
}

#[cfg(windows)]
fn native_mount_is_active(location: &NativeMount) -> bool {
    let NativeMount::Windows { remote } = location;
    std::fs::metadata(remote).is_ok()
}

#[cfg(windows)]
fn open_native_mount(location: &NativeMount, relative_path: &str) -> Result<(), String> {
    let NativeMount::Windows { remote } = location;
    reveal_native_target(&resolve_reveal_target(
        std::path::Path::new(remote),
        relative_path,
    )?)
}

#[cfg(windows)]
fn release_native_mount(location: &NativeMount) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::{ERROR_NOT_CONNECTED, NO_ERROR},
        NetworkManagement::WNet::WNetCancelConnection2W,
    };

    let NativeMount::Windows { remote } = location;
    let mut remote_wide = wide(remote);
    let result = unsafe { WNetCancelConnection2W(remote_wide.as_ptr(), 0, 1) };
    remote_wide.zeroize();
    if matches!(result, NO_ERROR | ERROR_NOT_CONNECTED) {
        Ok(())
    } else {
        Err(windows_error(
            "Windows could not release the previous project share",
            result,
        ))
    }
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn windows_error(context: &str, code: u32) -> String {
    format!(
        "{context} ({}; Windows error {code}).",
        std::io::Error::from_raw_os_error(code as i32)
    )
}

#[cfg(not(any(target_os = "macos", windows)))]
fn create_native_mount(
    _app: &AppHandle,
    _request: &RevealProjectShareRequest,
    _url: &Url,
) -> Result<NativeMount, String> {
    Err("Project reveal is available only in Cantrip for macOS and Windows.".into())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn native_mount_is_active(_location: &NativeMount) -> bool {
    false
}

#[cfg(not(any(target_os = "macos", windows)))]
fn open_native_mount(_location: &NativeMount, _relative_path: &str) -> Result<(), String> {
    Err("Project reveal is available only in Cantrip for macOS and Windows.".into())
}

#[cfg(target_os = "macos")]
fn reveal_native_target(target: &NativeRevealTarget) -> Result<(), String> {
    use std::process::{Command, Stdio};

    let mut command = Command::new("/usr/bin/open");
    if target.kind == NativeRevealTargetKind::File {
        command.arg("-R");
    }
    let output = command
        .arg(&target.path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Could not start Finder: {error}"))?;
    output
        .status
        .success()
        .then_some(())
        .ok_or_else(|| process_failure("Finder could not reveal the project entry", &output))
}

#[cfg(windows)]
fn reveal_native_target(target: &NativeRevealTarget) -> Result<(), String> {
    use std::process::{Command, Stdio};

    let output = Command::new("explorer.exe")
        .arg(windows_reveal_argument(target))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Could not start File Explorer: {error}"))?;
    output
        .status
        .success()
        .then_some(())
        .ok_or_else(|| process_failure("File Explorer could not reveal the project entry", &output))
}

#[cfg(any(windows, test))]
fn windows_reveal_argument(target: &NativeRevealTarget) -> std::ffi::OsString {
    let path = windows_explorer_compatible_path(&target.path);
    if target.kind == NativeRevealTargetKind::Directory {
        return path.as_os_str().to_owned();
    }
    let mut selection = std::ffi::OsString::from("/select,");
    selection.push(path);
    selection
}

#[cfg(any(windows, test))]
fn windows_explorer_compatible_path(path: &std::path::Path) -> &std::path::Path {
    #[cfg(windows)]
    {
        // Rust canonicalization returns verbatim `\\?\` paths on Windows.
        // Explorer's shell parser does not consistently accept them, so use
        // the compatible DOS form whenever it is safe to do so.
        dunce::simplified(path)
    }
    #[cfg(not(windows))]
    {
        path
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn reveal_native_target(_target: &NativeRevealTarget) -> Result<(), String> {
    Err("Project reveal is available only in Cantrip for macOS and Windows.".into())
}

fn open_local_project_target(target: &NativeRevealTarget) -> Result<(), String> {
    reveal_native_target(target)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn release_native_mount(_location: &NativeMount) -> Result<(), String> {
    Ok(())
}

#[cfg(any(target_os = "macos", windows))]
fn process_failure(context: &str, output: &std::process::Output) -> String {
    let detail = String::from_utf8_lossy(&output.stderr)
        .trim()
        .chars()
        .take(300)
        .collect::<String>();
    if detail.is_empty() {
        format!("{context} (exit status {}).", output.status)
    } else {
        format!("{context}: {detail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(url: &str) -> RevealProjectShareRequest {
        RevealProjectShareRequest {
            attachment_id: "ad6b8438-6418-4cdb-bf74-c7bd0f35035b".into(),
            mount_lease_ms: 60_000,
            password: "p".repeat(32),
            project_id: "project-1".into(),
            project_name: "Cantrip".into(),
            relative_path: String::new(),
            url: url.into(),
            username: "cantrip".into(),
        }
    }

    #[test]
    fn accepts_only_local_protected_project_share_urls() {
        let valid =
            "http://127.0.0.1:43123/project-shares/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
        assert!(validate_request(&request(valid)).is_ok());
        assert!(validate_request(&request("file:///tmp/project")).is_err());
        assert!(validate_request(&request("http://user:pass@127.0.0.1:43123/project-shares/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/")).is_err());
        assert!(
            validate_request(&request("http://127.0.0.1:43123/api/projects/project-1")).is_err()
        );
        assert!(
            validate_request(&request("http://127.0.0.1:43123/project-shares/short/")).is_err()
        );
        assert!(validate_request(&request(
            "https://cantrip.example/project-shares/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
        ))
        .is_err());
    }

    #[test]
    fn serializes_local_project_reveal_results_for_the_desktop_client() {
        assert_eq!(
            serde_json::to_string(&LocalProjectRevealResult::WorkerNotLocal).unwrap(),
            "\"worker-not-local\""
        );
        assert_eq!(
            serde_json::to_string(&LocalProjectRevealResult::OutsideManagedRoot).unwrap(),
            "\"outside-managed-root\""
        );
        assert_eq!(
            serde_json::to_string(&LocalProjectRevealResult::ExplorerLaunchFailed).unwrap(),
            "\"explorer-launch-failed\""
        );
    }

    #[test]
    fn accepts_only_relative_project_folder_paths() {
        assert_eq!(
            validate_relative_reveal_path("src/components/explorer").unwrap(),
            vec!["src", "components", "explorer"]
        );
        assert!(validate_relative_reveal_path("").unwrap().is_empty());
        for path in [
            "/Users/example/project",
            "../outside",
            "src/../outside",
            "C:/project",
            r"src\\outside",
        ] {
            assert!(validate_relative_reveal_path(path).is_err(), "{path}");
        }
    }

    #[test]
    fn resolves_files_and_directories_as_distinct_reveal_targets() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "cantrip-project-reveal-target-{}-{nonce}",
            std::process::id()
        ));
        let directory = root.join("src");
        let file = directory.join("main.ts");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(&file, b"export {};\n").unwrap();

        assert_eq!(
            resolve_reveal_target(&root, "src").unwrap(),
            NativeRevealTarget {
                kind: NativeRevealTargetKind::Directory,
                path: directory,
            }
        );
        let file_target = resolve_reveal_target(&root, "src/main.ts").unwrap();
        assert_eq!(
            file_target,
            NativeRevealTarget {
                kind: NativeRevealTargetKind::File,
                path: file,
            }
        );
        assert!(windows_reveal_argument(&file_target)
            .to_string_lossy()
            .starts_with("/select,"));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn removes_verbatim_drive_prefixes_before_opening_file_explorer() {
        let directory = NativeRevealTarget {
            kind: NativeRevealTargetKind::Directory,
            path: PathBuf::from(r"\\?\C:\Users\example\Cantrip"),
        };
        assert_eq!(
            windows_reveal_argument(&directory),
            std::ffi::OsString::from(r"C:\Users\example\Cantrip")
        );

        let file = NativeRevealTarget {
            kind: NativeRevealTargetKind::File,
            path: PathBuf::from(r"\\?\C:\Users\example\Cantrip\README.md"),
        };
        assert_eq!(
            windows_reveal_argument(&file),
            std::ffi::OsString::from(r"/select,C:\Users\example\Cantrip\README.md")
        );
    }

    #[test]
    fn resolves_chat_reveals_only_inside_the_canonical_scratch_root() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "cantrip-chat-reveal-target-{}-{nonce}",
            std::process::id()
        ));
        let directory = root.join("results");
        let file = directory.join("summary.md");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(&file, b"# Summary\n").unwrap();

        assert_eq!(
            resolve_chat_reveal_target(&root, "results/summary.md").unwrap(),
            NativeRevealTarget {
                kind: NativeRevealTargetKind::File,
                path: std::fs::canonicalize(&file).unwrap(),
            }
        );
        assert!(resolve_chat_reveal_target(&root, "../outside").is_err());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn chat_reveal_never_follows_symbolic_links() {
        use std::os::unix::fs::symlink;

        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "cantrip-chat-reveal-symlink-{}-{nonce}",
            std::process::id()
        ));
        let root = base.join("scratch");
        let outside = base.join("outside.txt");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&outside, b"outside").unwrap();
        symlink(&outside, root.join("link.txt")).unwrap();

        assert!(resolve_chat_reveal_target(&root, "link.txt")
            .unwrap_err()
            .contains("symbolic links"));

        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn sanitizes_native_volume_names() {
        assert_eq!(project_volume_name("Cantrip"), "Cantrip - Cantrip");
        assert_eq!(project_volume_name("../../:\n"), "Cantrip - ....");
        assert_eq!(project_volume_name("\0\n"), "Cantrip Project");
    }

    #[test]
    fn bounds_native_mount_leases() {
        assert!(mount_expiration_deadline(1).is_ok());
        assert!(mount_expiration_deadline(0).is_err());
        assert!(mount_expiration_deadline(MAX_NATIVE_MOUNT_LEASE_MS + 1).is_err());
    }

    #[test]
    fn classifies_local_project_storage_boundaries() {
        assert_eq!(
            local_project_storage(
                LocalProjectSourceKind::Folder,
                Some(LocalProjectFolderManagement::External),
                LocalProjectPlacementMode::Managed,
            ),
            DesktopWorkerProjectStorage::ExternalFolder
        );
        assert_eq!(
            local_project_storage(
                LocalProjectSourceKind::Folder,
                Some(LocalProjectFolderManagement::Managed),
                LocalProjectPlacementMode::Managed,
            ),
            DesktopWorkerProjectStorage::Folders
        );
        assert_eq!(
            local_project_storage(
                LocalProjectSourceKind::Git,
                None,
                LocalProjectPlacementMode::Managed,
            ),
            DesktopWorkerProjectStorage::Repositories
        );
        assert_eq!(
            local_project_storage(
                LocalProjectSourceKind::Git,
                None,
                LocalProjectPlacementMode::ManagedLink,
            ),
            DesktopWorkerProjectStorage::Repositories
        );
        assert_eq!(
            local_project_storage(
                LocalProjectSourceKind::Git,
                None,
                LocalProjectPlacementMode::Direct,
            ),
            DesktopWorkerProjectStorage::ExternalFolder
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn encodes_credentials_for_mount_webdav_without_text_delimiters() {
        let encoded = encode_mount_webdav_credentials("user", "password");
        assert_eq!(&encoded[0..4], &4_u32.to_be_bytes());
        assert_eq!(&encoded[4..8], b"user");
        assert_eq!(&encoded[8..12], &8_u32.to_be_bytes());
        assert_eq!(&encoded[12..20], b"password");
        assert_eq!(&encoded[20..], &[0_u8; 12]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn releases_native_mounts_when_the_server_lease_ends() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "cantrip-project-share-lease-{}-{nonce}",
            std::process::id()
        ));
        let path = root.join("attachment-1");
        std::fs::create_dir_all(&path).unwrap();
        let expires_at = Instant::now() + Duration::from_millis(20);
        let registry = Arc::new(Mutex::new(HashMap::from([(
            "project-1".into(),
            MountedProjectShare {
                attachment_id: "attachment-1".into(),
                expires_at,
                location: NativeMount::MacOs(path.clone()),
                url: "http://127.0.0.1:43123/project-shares/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/".into(),
            },
        )])));
        schedule_native_mount_expiration(
            Arc::clone(&registry),
            "project-1".into(),
            "attachment-1".into(),
            expires_at,
        );

        for _ in 0..100 {
            if !path.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!path.exists());
        assert!(registry.lock().unwrap().is_empty());
        std::fs::remove_dir(root).unwrap();
    }
}
