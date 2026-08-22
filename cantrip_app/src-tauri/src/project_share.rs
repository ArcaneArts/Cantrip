use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::Deserialize;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::{AppHandle, State};
use url::Url;
use zeroize::{Zeroize, Zeroizing};

use crate::{
    desktop_worker::{
        normalize_server_url, resolve_project_directory, DesktopWorkerProjectStorage,
        DesktopWorkers,
    },
    ManagedRuntime,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealProjectShareRequest {
    attachment_id: String,
    direct_tunnel_id: Option<String>,
    fallback_url: Option<String>,
    mount_lease_ms: u64,
    password: String,
    project_id: String,
    project_name: String,
    url: String,
    username: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealLocalProjectFolderRequest {
    folder_management: Option<LocalProjectFolderManagement>,
    path: String,
    server_url: String,
    source_kind: LocalProjectSourceKind,
    worker_id: String,
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

fn local_project_storage(
    source_kind: LocalProjectSourceKind,
    folder_management: Option<LocalProjectFolderManagement>,
) -> DesktopWorkerProjectStorage {
    match (source_kind, folder_management) {
        (LocalProjectSourceKind::Folder, Some(LocalProjectFolderManagement::External)) => {
            DesktopWorkerProjectStorage::ExternalFolder
        }
        (LocalProjectSourceKind::Folder, _) => DesktopWorkerProjectStorage::Folders,
        (LocalProjectSourceKind::Git, _) => DesktopWorkerProjectStorage::Repositories,
    }
}

struct MountedProjectShare {
    attachment_id: String,
    expires_at: Instant,
    fallback: Option<ProjectShareFallback>,
    location: NativeMount,
    url: String,
}

struct ProjectShareFallback {
    direct_tunnel_id: String,
    password: Zeroizing<String>,
    project_id: String,
    project_name: String,
    url: String,
    username: String,
}

enum NativeMount {
    #[cfg(target_os = "macos")]
    MacOs(PathBuf),
    #[cfg(windows)]
    Windows { remote: String },
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
pub async fn reveal_local_project_folder(
    runtime: State<'_, ManagedRuntime>,
    workers: State<'_, DesktopWorkers>,
    request: RevealLocalProjectFolderRequest,
) -> Result<bool, String> {
    let Ok(server_url) = normalize_server_url(&request.server_url) else {
        return Ok(false);
    };
    let storage = local_project_storage(request.source_kind, request.folder_management);
    let requested_path = std::path::Path::new(&request.path);
    let bundled_project = runtime
        .local_worker_data_directory(&server_url, &request.worker_id)
        .and_then(|data_directory| {
            resolve_project_directory(data_directory, storage, requested_path)
        });
    let project_directory = match bundled_project {
        Some(project_directory) => Some(project_directory),
        None => workers.resolve_project_directory(
            &server_url,
            &request.worker_id,
            storage,
            requested_path,
        )?,
    };
    let Some(project_directory) = project_directory else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || open_local_project_folder(&project_directory))
        .await
        .map_err(|error| format!("Could not join the local project reveal task: {error}"))??;
    Ok(true)
}

#[tauri::command]
pub fn list_direct_project_share_tunnels(
    state: State<'_, ProjectShareMounts>,
) -> Result<Vec<String>, String> {
    let mounts = state
        .mounts
        .lock()
        .map_err(|_| "The native project mount registry is unavailable.".to_string())?;
    let mut tunnel_ids = mounts
        .values()
        .filter_map(|mount| {
            mount
                .fallback
                .as_ref()
                .map(|fallback| fallback.direct_tunnel_id.clone())
        })
        .collect::<Vec<_>>();
    tunnel_ids.sort();
    Ok(tunnel_ids)
}

#[tauri::command]
pub async fn fallback_project_share(
    app: AppHandle,
    state: State<'_, ProjectShareMounts>,
    tunnel_id: String,
) -> Result<bool, String> {
    let mounts = Arc::clone(&state.mounts);
    tauri::async_runtime::spawn_blocking(move || {
        fallback_project_share_blocking(&app, mounts, &tunnel_id)
    })
    .await
    .map_err(|error| format!("Could not join the project share fallback task: {error}"))?
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
                let opened = open_native_mount(&existing.location);
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
        if let Err(error) = open_native_mount(&location) {
            let _ = release_native_mount(&location);
            return Err(error);
        }
        let fallback = project_share_fallback(&request);
        mounts.insert(
            request.project_id.clone(),
            MountedProjectShare {
                attachment_id: request.attachment_id.clone(),
                expires_at,
                fallback,
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

fn project_share_fallback(request: &RevealProjectShareRequest) -> Option<ProjectShareFallback> {
    Some(ProjectShareFallback {
        direct_tunnel_id: request.direct_tunnel_id.clone()?,
        password: Zeroizing::new(request.password.clone()),
        project_id: request.project_id.clone(),
        project_name: request.project_name.clone(),
        url: request.fallback_url.clone()?,
        username: request.username.clone(),
    })
}

fn fallback_project_share_blocking(
    app: &AppHandle,
    mounts: Arc<Mutex<HashMap<String, MountedProjectShare>>>,
    tunnel_id: &str,
) -> Result<bool, String> {
    let entry = {
        let mut registry = mounts
            .lock()
            .map_err(|_| "The native project mount registry is unavailable.".to_string())?;
        let project_id = registry.iter().find_map(|(project_id, mount)| {
            (mount
                .fallback
                .as_ref()
                .is_some_and(|fallback| fallback.direct_tunnel_id == tunnel_id))
            .then(|| project_id.clone())
        });
        project_id.and_then(|project_id| registry.remove(&project_id))
    };
    let Some(mut mounted) = entry else {
        return Ok(false);
    };
    let Some(fallback) = mounted.fallback.take() else {
        return Ok(false);
    };
    let mut request = RevealProjectShareRequest {
        attachment_id: mounted.attachment_id.clone(),
        direct_tunnel_id: None,
        fallback_url: None,
        mount_lease_ms: mounted
            .expires_at
            .saturating_duration_since(Instant::now())
            .as_millis()
            .try_into()
            .unwrap_or(1),
        password: fallback.password.as_str().to_owned(),
        project_id: fallback.project_id.clone(),
        project_name: fallback.project_name.clone(),
        url: fallback.url.clone(),
        username: fallback.username.clone(),
    };

    if native_mount_is_active(&mounted.location) {
        if let Err(error) = release_native_mount(&mounted.location) {
            mounted.fallback = Some(fallback);
            let project_id = request.project_id.clone();
            let attachment_id = mounted.attachment_id.clone();
            let expires_at = mounted.expires_at;
            mounts
                .lock()
                .map_err(|_| "The native project mount registry is unavailable.".to_string())?
                .insert(project_id.clone(), mounted);
            schedule_native_mount_expiration(
                Arc::clone(&mounts),
                project_id,
                attachment_id,
                expires_at,
            );
            request.password.zeroize();
            return Err(error);
        }
    }
    let result =
        validate_request(&request).and_then(|url| create_native_mount(app, &request, &url));
    request.password.zeroize();
    match result {
        Ok(location) => {
            mounted.location = location;
            mounted.url = fallback.url.clone();
            mounted.fallback = None;
            let project_id = fallback.project_id;
            let attachment_id = mounted.attachment_id.clone();
            let expires_at = mounted.expires_at;
            mounts
                .lock()
                .map_err(|_| "The native project mount registry is unavailable.".to_string())?
                .insert(project_id.clone(), mounted);
            schedule_native_mount_expiration(
                Arc::clone(&mounts),
                project_id,
                attachment_id,
                expires_at,
            );
            Ok(true)
        }
        Err(error) => {
            mounted.fallback = Some(fallback);
            let project_id = request.project_id;
            let attachment_id = mounted.attachment_id.clone();
            let expires_at = mounted.expires_at;
            mounts
                .lock()
                .map_err(|_| "The native project mount registry is unavailable.".to_string())?
                .insert(project_id.clone(), mounted);
            schedule_native_mount_expiration(
                Arc::clone(&mounts),
                project_id,
                attachment_id,
                expires_at,
            );
            Err(error)
        }
    }
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

    if request.direct_tunnel_id.as_ref().is_some_and(|tunnel_id| {
        tunnel_id.is_empty() || tunnel_id.len() > 200 || tunnel_id.chars().any(char::is_control)
    }) {
        return Err("The direct project share tunnel identifier is invalid.".into());
    }

    let url = validate_share_url(&request.url)?;
    if let Some(fallback_url) = &request.fallback_url {
        let fallback = validate_share_url(fallback_url)?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || fallback.path() != url.path()
            || request.direct_tunnel_id.is_none()
        {
            return Err("The project share fallback does not match its direct route.".into());
        }
    } else if request.direct_tunnel_id.is_some() {
        return Err("The direct project share omitted its server fallback.".into());
    }
    Ok(url)
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
fn open_native_mount(location: &NativeMount) -> Result<(), String> {
    use std::process::{Command, Stdio};

    let NativeMount::MacOs(path) = location;
    let output = Command::new("/usr/bin/open")
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Could not start Finder: {error}"))?;
    output
        .status
        .success()
        .then_some(())
        .ok_or_else(|| process_failure("Finder could not reveal the project share", &output))
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
fn open_native_mount(location: &NativeMount) -> Result<(), String> {
    use std::process::{Command, Stdio};

    let NativeMount::Windows { remote } = location;
    let output = Command::new("explorer.exe")
        .arg(remote)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Could not start File Explorer: {error}"))?;
    output
        .status
        .success()
        .then_some(())
        .ok_or_else(|| process_failure("File Explorer could not reveal the project share", &output))
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
fn open_native_mount(_location: &NativeMount) -> Result<(), String> {
    Err("Project reveal is available only in Cantrip for macOS and Windows.".into())
}

#[cfg(target_os = "macos")]
fn open_local_project_folder(path: &std::path::Path) -> Result<(), String> {
    use std::process::{Command, Stdio};

    let output = Command::new("/usr/bin/open")
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Could not start Finder: {error}"))?;
    output
        .status
        .success()
        .then_some(())
        .ok_or_else(|| process_failure("Finder could not open the local project folder", &output))
}

#[cfg(windows)]
fn open_local_project_folder(path: &std::path::Path) -> Result<(), String> {
    use std::process::{Command, Stdio};

    let output = Command::new("explorer.exe")
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Could not start File Explorer: {error}"))?;
    output.status.success().then_some(()).ok_or_else(|| {
        process_failure(
            "File Explorer could not open the local project folder",
            &output,
        )
    })
}

#[cfg(not(any(target_os = "macos", windows)))]
fn open_local_project_folder(_path: &std::path::Path) -> Result<(), String> {
    Err("Project reveal is available only in Cantrip for macOS and Windows.".into())
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
            direct_tunnel_id: None,
            fallback_url: None,
            mount_lease_ms: 60_000,
            password: "p".repeat(32),
            project_id: "project-1".into(),
            project_name: "Cantrip".into(),
            url: url.into(),
            username: "cantrip".into(),
        }
    }

    #[test]
    fn accepts_only_server_project_share_urls() {
        let valid =
            "https://cantrip.example/project-shares/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
        assert!(validate_request(&request(valid)).is_ok());
        assert!(validate_request(&request("file:///tmp/project")).is_err());
        assert!(validate_request(&request("https://user:pass@cantrip.example/project-shares/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/")).is_err());
        assert!(
            validate_request(&request("https://cantrip.example/api/projects/project-1")).is_err()
        );
        assert!(
            validate_request(&request("https://cantrip.example/project-shares/short/")).is_err()
        );
    }

    #[test]
    fn requires_a_matching_server_fallback_for_direct_mounts() {
        let direct =
            "http://127.0.0.1:43123/project-shares/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
        let fallback =
            "https://cantrip.example/project-shares/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
        let mut direct_request = request(direct);
        direct_request.direct_tunnel_id = Some("share-tunnel-1".into());
        direct_request.fallback_url = Some(fallback.into());
        assert!(validate_request(&direct_request).is_ok());

        direct_request.fallback_url = Some(
            "https://cantrip.example/project-shares/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/"
                .into(),
        );
        assert!(validate_request(&direct_request).is_err());
        direct_request.fallback_url = None;
        assert!(validate_request(&direct_request).is_err());

        direct_request.fallback_url = Some(fallback.into());
        direct_request.url = fallback.into();
        assert!(validate_request(&direct_request).is_err());
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
    fn resolves_only_explicit_external_folders_outside_managed_storage() {
        assert_eq!(
            local_project_storage(
                LocalProjectSourceKind::Folder,
                Some(LocalProjectFolderManagement::External),
            ),
            DesktopWorkerProjectStorage::ExternalFolder
        );
        assert_eq!(
            local_project_storage(
                LocalProjectSourceKind::Folder,
                Some(LocalProjectFolderManagement::Managed),
            ),
            DesktopWorkerProjectStorage::Folders
        );
        assert_eq!(
            local_project_storage(LocalProjectSourceKind::Git, None),
            DesktopWorkerProjectStorage::Repositories
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
                fallback: None,
                location: NativeMount::MacOs(path.clone()),
                url: "https://cantrip.example/project-shares/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/".into(),
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
