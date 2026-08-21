use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{App, AppHandle, Manager, State};
use url::{Host, Url};
use uuid::Uuid;

use crate::{node_service_command, process_environment::configure_desktop_child, terminate_child};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopWorkerProfile {
    name: String,
    server_url: String,
    worker_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RetainedDesktopWorkerProfile {
    name: String,
    server_url: String,
    version: u8,
    worker_id: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorkerCredentialIdentity {
    credential: String,
    server_url: String,
    worker_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWorkerStatus {
    name: String,
    running: bool,
    server_url: String,
    worker_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWorkerCandidate {
    repository_count: usize,
    worker_id: String,
}

enum WorkerLaunch {
    Development { repository: PathBuf, tsx: PathBuf },
    Packaged { directory: PathBuf, node: PathBuf },
}

pub struct DesktopWorkers {
    active_local_server_url: String,
    children: Mutex<HashMap<String, Child>>,
    data_directory: PathBuf,
    launch: WorkerLaunch,
    logs_directory: PathBuf,
    profiles: Mutex<Vec<DesktopWorkerProfile>>,
    profiles_path: PathBuf,
}

#[derive(Clone, Copy)]
pub(crate) enum DesktopWorkerProjectStorage {
    Folders,
    Repositories,
}

impl DesktopWorkerProjectStorage {
    fn directory_name(self) -> &'static str {
        match self {
            Self::Folders => "folders",
            Self::Repositories => "repositories",
        }
    }
}

fn replacement_profile(
    existing: Option<&DesktopWorkerProfile>,
    name: &str,
    server_url: &str,
    reusable_worker_id: Option<&str>,
) -> (Option<String>, DesktopWorkerProfile) {
    let replaced_worker_id = existing.map(|profile| profile.worker_id.clone());
    (
        replaced_worker_id,
        DesktopWorkerProfile {
            name: name.to_string(),
            server_url: server_url.to_string(),
            worker_id: reusable_worker_id
                .map(str::to_string)
                .unwrap_or_else(|| format!("desktop-{}", Uuid::new_v4())),
        },
    )
}

fn replacement_credential_required(
    replaced_worker_id: Option<&str>,
    next_worker_id: &str,
    has_stored_credential: bool,
) -> bool {
    replaced_worker_id.is_some_and(|worker_id| worker_id != next_worker_id) && has_stored_credential
}

fn valid_desktop_worker_id(value: &str) -> bool {
    value
        .strip_prefix("desktop-")
        .and_then(|value| Uuid::parse_str(value).ok())
        .is_some()
}

fn should_autostart_profile(profile_server_url: &str, active_local_server_url: &str) -> bool {
    let Ok(profile_server) = Url::parse(profile_server_url) else {
        return false;
    };
    let loopback = match profile_server.host() {
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        None => false,
    };
    !loopback || profile_server_url == active_local_server_url
}

fn mirror_child_output<R: Read + Send + 'static>(mut reader: R, use_stderr: bool) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8 * 1_024];
        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) => return,
                Ok(read) => read,
                Err(error) => {
                    eprintln!("Could not read linked worker output: {error}");
                    return;
                }
            };
            let console_result = if use_stderr {
                std::io::stderr().write_all(&buffer[..read])
            } else {
                std::io::stdout().write_all(&buffer[..read])
            };
            if let Err(error) = console_result {
                eprintln!("Could not mirror linked worker output: {error}");
                return;
            }
        }
    });
}

pub(crate) fn normalize_server_url(value: &str) -> Result<String, String> {
    let mut parsed = Url::parse(value).map_err(|_| "The server URL is invalid.".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        return Err(
            "The server URL must be an HTTP(S) origin without credentials or a path.".into(),
        );
    }
    parsed.set_path("");
    Ok(parsed.to_string().trim_end_matches('/').to_string())
}

fn read_profiles(path: &Path) -> Vec<DesktopWorkerProfile> {
    let Ok(contents) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<DesktopWorkerProfile>>(&contents).unwrap_or_else(|error| {
        eprintln!("Could not read desktop worker registry: {error}");
        Vec::new()
    })
}

fn read_retained_profiles(data_directory: &Path) -> Vec<DesktopWorkerProfile> {
    let Ok(entries) = fs::read_dir(data_directory) else {
        return Vec::new();
    };
    let mut retained = entries
        .flatten()
        .filter_map(|entry| {
            let worker_id = entry.file_name().to_str()?.to_string();
            if !valid_desktop_worker_id(&worker_id) {
                return None;
            }
            let path = entry.path().join("desktop-profile.json");
            let contents = fs::read_to_string(&path).ok()?;
            let stored = serde_json::from_str::<RetainedDesktopWorkerProfile>(&contents).ok()?;
            let server_url = normalize_server_url(&stored.server_url).ok()?;
            let name = stored.name.trim();
            if stored.version != 1
                || stored.worker_id != worker_id
                || name.is_empty()
                || name.len() > 120
            {
                return None;
            }
            Some((
                fs::metadata(path)
                    .and_then(|metadata| metadata.modified())
                    .ok(),
                DesktopWorkerProfile {
                    name: name.to_string(),
                    server_url,
                    worker_id,
                },
            ))
        })
        .collect::<Vec<_>>();
    retained.sort_by(|left, right| right.0.cmp(&left.0));
    retained.into_iter().map(|(_, profile)| profile).collect()
}

fn recover_profiles(
    mut configured: Vec<DesktopWorkerProfile>,
    retained: Vec<DesktopWorkerProfile>,
) -> Vec<DesktopWorkerProfile> {
    let mut servers = configured
        .iter()
        .map(|profile| profile.server_url.clone())
        .collect::<HashSet<_>>();
    let mut workers = configured
        .iter()
        .map(|profile| profile.worker_id.clone())
        .collect::<HashSet<_>>();
    for profile in retained {
        if servers.contains(&profile.server_url) || workers.contains(&profile.worker_id) {
            continue;
        }
        servers.insert(profile.server_url.clone());
        workers.insert(profile.worker_id.clone());
        configured.push(profile);
    }
    configured
}

fn repository_count(profile_directory: &Path) -> usize {
    let Ok(owners) = fs::read_dir(profile_directory.join("repositories")) else {
        return 0;
    };
    owners
        .flatten()
        .filter_map(|owner| fs::read_dir(owner.path()).ok())
        .flat_map(|repositories| repositories.flatten())
        .filter(|repository| repository.path().join(".git").exists())
        .count()
}

fn sort_worker_candidates(candidates: &mut [DesktopWorkerCandidate]) {
    candidates.sort_by(|left, right| {
        right
            .repository_count
            .cmp(&left.repository_count)
            .then_with(|| left.worker_id.cmp(&right.worker_id))
    });
}

fn write_profiles(path: &Path, profiles: &[DesktopWorkerProfile]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The desktop worker registry path has no parent.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(profiles)
            .map_err(|error| format!("Could not encode desktop workers: {error}"))?,
    )
    .map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("Could not replace {}: {error}", path.display()))
}

impl DesktopWorkers {
    fn profile_directory(&self, worker_id: &str) -> PathBuf {
        self.data_directory.join(worker_id)
    }

    fn has_stored_credential(&self, worker_id: &str) -> bool {
        self.profile_directory(worker_id)
            .join("worker-credential.json")
            .is_file()
    }

    fn should_autostart(&self, profile: &DesktopWorkerProfile) -> bool {
        should_autostart_profile(&profile.server_url, &self.active_local_server_url)
    }

    pub(crate) fn resolve_project_directory(
        &self,
        server_url: &str,
        worker_id: &str,
        storage: DesktopWorkerProjectStorage,
        requested_path: &Path,
    ) -> Result<Option<PathBuf>, String> {
        let server_url = normalize_server_url(server_url)?;
        let local_worker = self
            .profiles
            .lock()
            .map_err(|_| "The desktop worker registry is unavailable.".to_string())?
            .iter()
            .any(|profile| profile.worker_id == worker_id && profile.server_url == server_url);
        if !local_worker {
            return Ok(None);
        }

        Ok(resolve_project_directory_under_root(
            &self.profile_directory(worker_id),
            storage,
            requested_path,
        ))
    }

    fn persist_profile(&self, profile: &DesktopWorkerProfile) -> Result<(), String> {
        let directory = self.profile_directory(&profile.worker_id);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Could not create {}: {error}", directory.display()))?;
        let path = directory.join("desktop-profile.json");
        let encoded = serde_json::to_vec_pretty(&RetainedDesktopWorkerProfile {
            name: profile.name.clone(),
            server_url: profile.server_url.clone(),
            version: 1,
            worker_id: profile.worker_id.clone(),
        })
        .map_err(|error| format!("Could not encode retained desktop worker: {error}"))?;
        if fs::read(&path).is_ok_and(|existing| existing == encoded) {
            return Ok(());
        }
        fs::write(&path, encoded)
            .map_err(|error| format!("Could not write {}: {error}", path.display()))
    }

    fn remove_profile_auth(&self, worker_id: &str) -> Result<(), String> {
        for filename in ["desktop-profile.json", "worker-credential.json"] {
            let path = self.profile_directory(worker_id).join(filename);
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("Could not remove {}: {error}", path.display()));
                }
            }
        }
        Ok(())
    }

    fn spawn(
        &self,
        profile: &DesktopWorkerProfile,
        enrollment_code: Option<&str>,
        replacement: Option<&StoredWorkerCredentialIdentity>,
    ) -> Result<Child, String> {
        let mut command = match &self.launch {
            WorkerLaunch::Development { repository, tsx } => {
                let mut command = Command::new(tsx);
                command
                    .arg(repository.join("cantrip_worker/src/index.ts"))
                    .current_dir(repository);
                command
            }
            WorkerLaunch::Packaged { directory, node } => node_service_command(node, directory),
        };
        configure_desktop_child(&mut command);
        command
            .env("CANTRIP_SERVER_URL", &profile.server_url)
            .env("CANTRIP_WORKER_ID", &profile.worker_id)
            .env("CANTRIP_WORKER_NAME", &profile.name)
            .env(
                "CANTRIP_SERVICE_LOG_DIR",
                self.service_log_path(&profile.worker_id)?,
            )
            .env(
                "CANTRIP_WORKER_DATA_DIR",
                self.profile_directory(&profile.worker_id),
            )
            .env_remove("CANTRIP_WORKER_TOKEN")
            .env_remove("CANTRIP_WORKER_DEVELOPMENT_BOOTSTRAP")
            .env_remove("CANTRIP_WORKER_CREDENTIAL")
            .env_remove("CANTRIP_WORKER_REPLACES_ID")
            .env_remove("CANTRIP_WORKER_REPLACES_CREDENTIAL");
        if cfg!(debug_assertions) {
            command.stdout(Stdio::piped()).stderr(Stdio::piped());
        } else {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
        if let Some(code) = enrollment_code {
            command.env("CANTRIP_WORKER_ENROLLMENT_CODE", code);
        } else {
            command.env_remove("CANTRIP_WORKER_ENROLLMENT_CODE");
        }
        if let Some(replacement) = replacement {
            command
                .env("CANTRIP_WORKER_REPLACES_ID", &replacement.worker_id)
                .env(
                    "CANTRIP_WORKER_REPLACES_CREDENTIAL",
                    &replacement.credential,
                );
        }
        let mut child = command.spawn().map_err(|error| {
            format!(
                "Could not start this machine's worker for {}: {error}",
                profile.server_url
            )
        })?;
        if cfg!(debug_assertions) {
            if let Some(child_stdout) = child.stdout.take() {
                mirror_child_output(child_stdout, false);
            }
            if let Some(child_stderr) = child.stderr.take() {
                mirror_child_output(child_stderr, true);
            }
        }
        Ok(child)
    }

    fn ensure_running(
        &self,
        profile: &DesktopWorkerProfile,
        enrollment_code: Option<&str>,
        replacement: Option<&StoredWorkerCredentialIdentity>,
    ) -> Result<(), String> {
        let mut children = self
            .children
            .lock()
            .map_err(|_| "The desktop worker process registry is unavailable.".to_string())?;
        if let Some(child) = children.get_mut(&profile.worker_id) {
            if child
                .try_wait()
                .map_err(|error| format!("Could not inspect the desktop worker: {error}"))?
                .is_none()
            {
                return Ok(());
            }
            children.remove(&profile.worker_id);
        }
        let child = self.spawn(profile, enrollment_code, replacement)?;
        children.insert(profile.worker_id.clone(), child);
        Ok(())
    }

    fn stop(&self, worker_id: &str) -> Result<(), String> {
        let mut children = self
            .children
            .lock()
            .map_err(|_| "The desktop worker process registry is unavailable.".to_string())?;
        if let Some(mut child) = children.remove(worker_id) {
            terminate_child(&mut child);
        }
        Ok(())
    }

    fn reusable_workers(&self, server_url: &str) -> Vec<DesktopWorkerCandidate> {
        let mut candidates = HashSet::new();
        if let Ok(profiles) = self.profiles.lock() {
            candidates.extend(
                profiles
                    .iter()
                    .filter(|profile| profile.server_url == server_url)
                    .map(|profile| profile.worker_id.clone()),
            );
        }
        if let Ok(entries) = fs::read_dir(&self.data_directory) {
            for entry in entries.flatten() {
                let directory_worker_id = entry.file_name().to_string_lossy().to_string();
                if valid_desktop_worker_id(&directory_worker_id)
                    && repository_count(&entry.path()) > 0
                {
                    candidates.insert(directory_worker_id.clone());
                }
                let credential_path = entry.path().join("worker-credential.json");
                let Ok(contents) = fs::read_to_string(credential_path) else {
                    continue;
                };
                let Ok(identity) =
                    serde_json::from_str::<StoredWorkerCredentialIdentity>(&contents)
                else {
                    continue;
                };
                if identity.server_url == server_url
                    && valid_desktop_worker_id(&identity.worker_id)
                    && directory_worker_id == identity.worker_id
                {
                    candidates.insert(identity.worker_id);
                }
            }
        }
        let mut candidates = candidates
            .into_iter()
            .map(|worker_id| DesktopWorkerCandidate {
                repository_count: repository_count(&self.profile_directory(&worker_id)),
                worker_id,
            })
            .collect::<Vec<_>>();
        sort_worker_candidates(&mut candidates);
        candidates.truncate(64);
        candidates
    }

    pub fn stop_all(&self) {
        if let Ok(mut children) = self.children.lock() {
            for child in children.values_mut() {
                terminate_child(child);
            }
            children.clear();
        }
    }

    pub fn service_log_path(&self, worker_id: &str) -> Result<PathBuf, String> {
        if !valid_desktop_worker_id(worker_id) {
            return Err("The linked worker identity is malformed.".into());
        }
        let profiles = self
            .profiles
            .lock()
            .map_err(|_| "The desktop worker registry is unavailable.".to_string())?;
        if !profiles
            .iter()
            .any(|profile| profile.worker_id == worker_id)
        {
            return Err("The linked worker is not managed by this installation.".into());
        }
        let directory = self.logs_directory.join("workers").join(worker_id);
        crate::local_logs::migrate_legacy_archive(
            &directory,
            "worker",
            &[self
                .logs_directory
                .join(format!("{worker_id}.service.jsonl"))],
        )?;
        Ok(directory)
    }
}

pub(crate) fn resolve_project_directory_under_root(
    worker_data_directory: &Path,
    storage: DesktopWorkerProjectStorage,
    requested_path: &Path,
) -> Option<PathBuf> {
    let profile_root = fs::canonicalize(worker_data_directory).ok()?;
    let storage_root = fs::canonicalize(profile_root.join(storage.directory_name())).ok()?;
    if storage_root == profile_root || !storage_root.starts_with(&profile_root) {
        return None;
    }
    let project_directory = fs::canonicalize(requested_path).ok()?;
    if project_directory == storage_root
        || !project_directory.starts_with(&storage_root)
        || !project_directory.is_dir()
    {
        return None;
    }
    Some(project_directory)
}

pub fn build(app: &App, active_local_server_url: &str) -> Result<DesktopWorkers, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve application data: {error}"))?
        .join("linked-workers");
    let logs_directory = root.join("logs");
    fs::create_dir_all(&logs_directory)
        .map_err(|error| format!("Could not create {}: {error}", logs_directory.display()))?;
    let profiles_path = root.join("desktop-workers.json");
    let data_directory = root.join("profiles");
    let configured_profiles = read_profiles(&profiles_path);
    let profiles = recover_profiles(
        configured_profiles.clone(),
        read_retained_profiles(&data_directory),
    );
    if profiles != configured_profiles {
        write_profiles(&profiles_path, &profiles)?;
    }
    let launch = if cfg!(debug_assertions) {
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| "Could not resolve the Cantrip repository root.".to_string())?
            .to_path_buf();
        WorkerLaunch::Development {
            tsx: repository.join(if cfg!(windows) {
                "node_modules/.bin/tsx.cmd"
            } else {
                "node_modules/.bin/tsx"
            }),
            repository,
        }
    } else {
        let resources = app
            .path()
            .resource_dir()
            .map_err(|error| format!("Could not resolve bundled resources: {error}"))?
            .join("runtime");
        WorkerLaunch::Packaged {
            directory: resources.join("worker"),
            node: resources.join(if cfg!(windows) { "node.exe" } else { "node" }),
        }
    };
    let manager = DesktopWorkers {
        active_local_server_url: normalize_server_url(active_local_server_url)?,
        children: Mutex::new(HashMap::new()),
        data_directory,
        launch,
        logs_directory,
        profiles: Mutex::new(profiles.clone()),
        profiles_path,
    };
    for profile in &profiles {
        if let Err(error) = manager.persist_profile(profile) {
            eprintln!("Could not retain linked desktop worker profile: {error}");
        }
    }
    for profile in profiles {
        if manager.should_autostart(&profile) && manager.has_stored_credential(&profile.worker_id) {
            if let Err(_error) = manager.ensure_running(&profile, None, None) {
                app.state::<crate::local_logs::LocalServiceLogs>()
                    .runtime_event(
                        "warn",
                        "Linked desktop worker failed to reconnect",
                        Some(json!({
                            "event": "desktop.linked-worker.reconnect.failed",
                            "operation": "reconnect-worker",
                            "reasonCode": "process-startup-failed",
                            "subsystem": "desktop-worker",
                            "workerId": profile.worker_id
                        })),
                    );
            }
        }
    }
    Ok(manager)
}

#[tauri::command]
pub fn list_desktop_workers(
    app: AppHandle,
    workers: State<'_, DesktopWorkers>,
) -> Result<Vec<DesktopWorkerStatus>, String> {
    let profiles = workers
        .profiles
        .lock()
        .map_err(|_| "The desktop worker registry is unavailable.".to_string())?
        .clone();
    for profile in &profiles {
        if workers.should_autostart(profile) && workers.has_stored_credential(&profile.worker_id) {
            if let Err(_error) = workers.ensure_running(profile, None, None) {
                app.state::<crate::local_logs::LocalServiceLogs>()
                    .runtime_event(
                        "warn",
                        "Linked desktop worker supervision failed",
                        Some(json!({
                            "event": "desktop.linked-worker.supervision.failed",
                            "operation": "supervise-worker",
                            "reasonCode": "process-startup-failed",
                            "subsystem": "desktop-worker",
                            "workerId": profile.worker_id
                        })),
                    );
            }
        }
    }
    let mut children = workers
        .children
        .lock()
        .map_err(|_| "The desktop worker process registry is unavailable.".to_string())?;
    profiles
        .into_iter()
        .map(|profile| {
            let running = children
                .get_mut(&profile.worker_id)
                .map(|child| child.try_wait().ok().flatten().is_none())
                .unwrap_or(false);
            Ok(DesktopWorkerStatus {
                name: profile.name,
                running,
                server_url: profile.server_url,
                worker_id: profile.worker_id,
            })
        })
        .collect()
}

#[tauri::command]
pub fn list_desktop_worker_candidates(
    server_url: String,
    workers: State<'_, DesktopWorkers>,
) -> Result<Vec<DesktopWorkerCandidate>, String> {
    let server_url = normalize_server_url(&server_url)?;
    Ok(workers.reusable_workers(&server_url))
}

#[tauri::command]
pub fn pair_desktop_worker(
    app: AppHandle,
    enrollment_code: String,
    name: String,
    server_url: String,
    worker_id: Option<String>,
    workers: State<'_, DesktopWorkers>,
) -> Result<DesktopWorkerStatus, String> {
    if !enrollment_code.starts_with("ctwl_") || enrollment_code.len() != 37 {
        return Err("The one-time worker enrollment is malformed.".into());
    }
    let server_url = normalize_server_url(&server_url)?;
    let name = name.trim();
    if name.is_empty() || name.len() > 120 {
        return Err("The worker name must contain between 1 and 120 characters.".into());
    }
    if worker_id
        .as_deref()
        .is_some_and(|worker_id| !valid_desktop_worker_id(worker_id))
    {
        return Err("The reusable desktop worker identity is malformed.".into());
    }
    let existing = workers
        .profiles
        .lock()
        .map_err(|_| "The desktop worker registry is unavailable.".to_string())?
        .iter()
        .find(|profile| profile.server_url == server_url)
        .cloned();
    let (replaced_worker_id, profile) =
        replacement_profile(existing.as_ref(), name, &server_url, worker_id.as_deref());
    let replacement = replaced_worker_id
        .as_ref()
        .filter(|worker_id| worker_id.as_str() != profile.worker_id)
        .and_then(|worker_id| {
            let contents = fs::read_to_string(
                workers
                    .profile_directory(worker_id)
                    .join("worker-credential.json"),
            )
            .ok()?;
            let stored = serde_json::from_str::<StoredWorkerCredentialIdentity>(&contents).ok()?;
            (stored.worker_id == *worker_id && stored.server_url == server_url).then_some(stored)
        });
    let replaced_worker_has_credential = replaced_worker_id
        .as_deref()
        .is_some_and(|worker_id| workers.has_stored_credential(worker_id));
    if replacement_credential_required(
        replaced_worker_id.as_deref(),
        &profile.worker_id,
        replaced_worker_has_credential,
    ) && replacement.is_none()
    {
        return Err(
            "The previous linked worker credential is unavailable, so its old account cannot be safely unlinked. Forget the old worker explicitly before pairing again."
                .into(),
        );
    }
    if let Some(worker_id) = replaced_worker_id.as_deref() {
        workers.stop(worker_id)?;
    }
    let credential_path = workers
        .profile_directory(&profile.worker_id)
        .join("worker-credential.json");
    if credential_path.exists() {
        fs::remove_file(&credential_path).map_err(|error| {
            format!("Could not reset the previous desktop worker enrollment: {error}")
        })?;
    }
    workers.persist_profile(&profile)?;
    {
        let mut profiles = workers
            .profiles
            .lock()
            .map_err(|_| "The desktop worker registry is unavailable.".to_string())?;
        profiles.retain(|candidate| candidate.server_url != server_url);
        profiles.push(profile.clone());
        write_profiles(&workers.profiles_path, &profiles)?;
    }
    workers.ensure_running(&profile, Some(&enrollment_code), replacement.as_ref())?;
    if let Some(worker_id) = replaced_worker_id
        .as_deref()
        .filter(|worker_id| *worker_id != profile.worker_id)
    {
        let retained_path = workers
            .profile_directory(worker_id)
            .join("desktop-profile.json");
        if let Err(error) = fs::remove_file(&retained_path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "Could not retire replaced desktop worker profile {}: {error}",
                    retained_path.display()
                );
            }
        }
    }
    app.state::<crate::local_logs::LocalServiceLogs>()
        .runtime_event(
            "info",
            "Linked desktop worker paired and started",
            Some(json!({
                "event": "desktop.linked-worker.paired",
                "operation": "pair-worker",
                "status": "running",
                "subsystem": "desktop-worker",
                "workerId": profile.worker_id
            })),
        );
    Ok(DesktopWorkerStatus {
        name: profile.name,
        running: true,
        server_url: profile.server_url,
        worker_id: profile.worker_id,
    })
}

#[tauri::command]
pub fn forget_desktop_worker(
    app: AppHandle,
    worker_id: String,
    workers: State<'_, DesktopWorkers>,
) -> Result<(), String> {
    workers.stop(&worker_id)?;
    let mut profiles = workers
        .profiles
        .lock()
        .map_err(|_| "The desktop worker registry is unavailable.".to_string())?;
    profiles.retain(|profile| profile.worker_id != worker_id);
    write_profiles(&workers.profiles_path, &profiles)?;
    workers.remove_profile_auth(&worker_id)?;
    app.state::<crate::local_logs::LocalServiceLogs>()
        .runtime_event(
            "info",
            "Linked desktop worker removed",
            Some(json!({
                "event": "desktop.linked-worker.removed",
                "operation": "forget-worker",
                "subsystem": "desktop-worker",
                "workerId": worker_id
            })),
        );
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, fs, path::Path, sync::Mutex};

    use super::{
        normalize_server_url, read_retained_profiles, recover_profiles,
        replacement_credential_required, replacement_profile, repository_count,
        should_autostart_profile, sort_worker_candidates, DesktopWorkerCandidate,
        DesktopWorkerProfile, DesktopWorkerProjectStorage, DesktopWorkers, WorkerLaunch,
    };

    fn test_manager(root: &Path) -> DesktopWorkers {
        DesktopWorkers {
            active_local_server_url: "http://127.0.0.1:4310".into(),
            children: Mutex::new(HashMap::new()),
            data_directory: root.join("profiles"),
            launch: WorkerLaunch::Development {
                repository: root.to_path_buf(),
                tsx: root.join("tsx"),
            },
            logs_directory: root.join("logs"),
            profiles: Mutex::new(Vec::new()),
            profiles_path: root.join("desktop-workers.json"),
        }
    }

    #[test]
    fn skips_orphaned_loopback_profiles_during_autostart() {
        assert!(!should_autostart_profile(
            "http://127.0.0.1:4320",
            "http://127.0.0.1:4310",
        ));
        assert!(should_autostart_profile(
            "http://127.0.0.1:4310",
            "http://127.0.0.1:4310",
        ));
        assert!(should_autostart_profile(
            "https://winterhold.cantrip.art",
            "http://127.0.0.1:4310",
        ));
    }

    fn local_project_manager(root: &Path, worker_id: &str) -> DesktopWorkers {
        let manager = test_manager(root);
        manager.profiles.lock().unwrap().push(DesktopWorkerProfile {
            name: "This machine".into(),
            server_url: "https://cantrip.example".into(),
            worker_id: worker_id.into(),
        });
        manager
    }

    #[test]
    fn normalizes_server_origins() {
        assert_eq!(
            normalize_server_url("https://relay.cantrip.art/").unwrap(),
            "https://relay.cantrip.art"
        );
        assert_eq!(
            normalize_server_url("http://127.0.0.1:4310").unwrap(),
            "http://127.0.0.1:4310"
        );
    }

    #[test]
    fn rejects_non_origin_server_urls() {
        assert!(normalize_server_url("file:///tmp/cantrip").is_err());
        assert!(normalize_server_url("https://relay.cantrip.art/api").is_err());
        assert!(normalize_server_url("https://user@example.com").is_err());
    }

    #[test]
    fn replaces_a_stale_server_profile_with_a_fresh_worker_identity() {
        let existing = DesktopWorkerProfile {
            name: "This machine".into(),
            server_url: "https://relay.cantrip.art".into(),
            worker_id: "desktop-owned-by-another-account".into(),
        };

        let (replaced_worker_id, replacement) = replacement_profile(
            Some(&existing),
            "This machine",
            "https://relay.cantrip.art",
            None,
        );

        assert_eq!(
            replaced_worker_id.as_deref(),
            Some(existing.worker_id.as_str())
        );
        assert_ne!(replacement.worker_id, existing.worker_id);
        assert!(replacement.worker_id.starts_with("desktop-"));
        assert_eq!(replacement.name, "This machine");
        assert_eq!(replacement.server_url, existing.server_url);
    }

    #[test]
    fn reuses_a_server_authorized_worker_identity() {
        let (_, replacement) = replacement_profile(
            None,
            "This machine",
            "https://relay.cantrip.art",
            Some("desktop-019fdc2c-e848-7552-b2ea-6fc7ef09e9f2"),
        );

        assert_eq!(
            replacement.worker_id,
            "desktop-019fdc2c-e848-7552-b2ea-6fc7ef09e9f2"
        );
    }

    #[test]
    fn credentialless_failed_enrollment_can_be_retried_with_a_fresh_identity() {
        assert!(!replacement_credential_required(
            Some("desktop-failed-enrollment"),
            "desktop-retry",
            false,
        ));
        assert!(replacement_credential_required(
            Some("desktop-linked-worker"),
            "desktop-replacement",
            true,
        ));
        assert!(!replacement_credential_required(
            Some("desktop-reused-worker"),
            "desktop-reused-worker",
            true,
        ));
    }

    #[test]
    fn counts_only_repository_roots_in_a_retained_profile() {
        let root =
            std::env::temp_dir().join(format!("cantrip-worker-candidate-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("repositories/ArcaneArts/Cantrip/.git")).unwrap();
        fs::create_dir_all(root.join("repositories/ArcaneArts/not-a-repository")).unwrap();
        fs::create_dir_all(root.join("repositories/VolmitSoftware/Iris")).unwrap();
        fs::write(
            root.join("repositories/VolmitSoftware/Iris/.git"),
            "gitdir: elsewhere",
        )
        .unwrap();

        assert_eq!(repository_count(Path::new(&root)), 2);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ranks_source_owning_worker_identities_first() {
        let mut candidates = vec![
            DesktopWorkerCandidate {
                repository_count: 0,
                worker_id: "desktop-current".into(),
            },
            DesktopWorkerCandidate {
                repository_count: 2,
                worker_id: "desktop-source-owner".into(),
            },
        ];

        sort_worker_candidates(&mut candidates);

        assert_eq!(candidates[0].worker_id, "desktop-source-owner");
    }

    #[test]
    fn only_restarts_profiles_with_a_stored_credential() {
        let root = std::env::temp_dir().join(format!(
            "cantrip-worker-credential-{}",
            uuid::Uuid::new_v4()
        ));
        let worker_id = "desktop-019fdc2c-e848-7552-b2ea-6fc7ef09e9f2";
        let profile_directory = root.join("profiles").join(worker_id);
        fs::create_dir_all(&profile_directory).unwrap();
        let manager = test_manager(&root);

        assert!(!manager.has_stored_credential(worker_id));
        fs::write(profile_directory.join("worker-credential.json"), "{}").unwrap();
        assert!(manager.has_stored_credential(worker_id));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolves_only_projects_owned_by_the_active_local_worker() {
        let root = std::env::temp_dir().join(format!(
            "cantrip-worker-project-reveal-{}",
            uuid::Uuid::new_v4()
        ));
        let worker_id = "desktop-019fdc2c-e848-7552-b2ea-6fc7ef09e9f2";
        let manager = local_project_manager(&root, worker_id);
        let repository = manager
            .profile_directory(worker_id)
            .join("repositories/ArcaneArts/Cantrip");
        let folder = manager
            .profile_directory(worker_id)
            .join("folders/019fdc2c-e848-7552-b2ea-6fc7ef09e9f3");
        let outside = root.join("outside");
        fs::create_dir_all(&repository).unwrap();
        fs::create_dir_all(&folder).unwrap();
        fs::create_dir_all(&outside).unwrap();

        assert_eq!(
            manager
                .resolve_project_directory(
                    "https://cantrip.example/",
                    worker_id,
                    DesktopWorkerProjectStorage::Repositories,
                    &repository,
                )
                .unwrap(),
            Some(fs::canonicalize(&repository).unwrap())
        );
        assert_eq!(
            manager
                .resolve_project_directory(
                    "https://cantrip.example",
                    worker_id,
                    DesktopWorkerProjectStorage::Folders,
                    &folder,
                )
                .unwrap(),
            Some(fs::canonicalize(&folder).unwrap())
        );
        assert_eq!(
            manager
                .resolve_project_directory(
                    "https://other.example",
                    worker_id,
                    DesktopWorkerProjectStorage::Repositories,
                    &repository,
                )
                .unwrap(),
            None
        );
        assert_eq!(
            manager
                .resolve_project_directory(
                    "https://cantrip.example",
                    "desktop-019fdc2c-e848-7552-b2ea-6fc7ef09e9f4",
                    DesktopWorkerProjectStorage::Repositories,
                    &repository,
                )
                .unwrap(),
            None
        );
        assert_eq!(
            manager
                .resolve_project_directory(
                    "https://cantrip.example",
                    worker_id,
                    DesktopWorkerProjectStorage::Repositories,
                    &outside,
                )
                .unwrap(),
            None
        );
        assert_eq!(
            manager
                .resolve_project_directory(
                    "https://cantrip.example",
                    worker_id,
                    DesktopWorkerProjectStorage::Folders,
                    &repository,
                )
                .unwrap(),
            None
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovers_worker_identity_from_retained_profile_data() {
        let root = std::env::temp_dir().join(format!(
            "cantrip-worker-retained-profile-{}",
            uuid::Uuid::new_v4()
        ));
        let manager = test_manager(&root);
        let profile = DesktopWorkerProfile {
            name: "This machine".into(),
            server_url: "https://winterhold.cantrip.art".into(),
            worker_id: "desktop-019fdc2c-e848-7552-b2ea-6fc7ef09e9f2".into(),
        };

        manager.persist_profile(&profile).unwrap();
        let recovered =
            recover_profiles(Vec::new(), read_retained_profiles(&manager.data_directory));

        assert_eq!(recovered, vec![profile]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn configured_server_profile_wins_over_an_older_retained_identity() {
        let configured = DesktopWorkerProfile {
            name: "Current machine".into(),
            server_url: "https://winterhold.cantrip.art".into(),
            worker_id: "desktop-019fdc2c-e848-7552-b2ea-6fc7ef09e9f2".into(),
        };
        let retained = DesktopWorkerProfile {
            name: "Old machine".into(),
            server_url: configured.server_url.clone(),
            worker_id: "desktop-019fdc2c-e848-7552-b2ea-6fc7ef09e9f3".into(),
        };

        assert_eq!(
            recover_profiles(vec![configured.clone()], vec![retained]),
            vec![configured]
        );
    }

    #[test]
    fn source_owning_profile_remains_a_restore_candidate_without_auth_files() {
        let root = std::env::temp_dir().join(format!(
            "cantrip-worker-orphaned-profile-{}",
            uuid::Uuid::new_v4()
        ));
        let manager = test_manager(&root);
        let worker_id = "desktop-019fdc2c-e848-7552-b2ea-6fc7ef09e9f2";
        fs::create_dir_all(
            manager
                .profile_directory(worker_id)
                .join("repositories/ArcaneArts/Cantrip/.git"),
        )
        .unwrap();

        let candidates = manager.reusable_workers("https://winterhold.cantrip.art");

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].worker_id, worker_id);
        assert_eq!(candidates[0].repository_count, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn forgetting_worker_auth_preserves_its_repository_data() {
        let root = std::env::temp_dir().join(format!(
            "cantrip-worker-forgotten-profile-{}",
            uuid::Uuid::new_v4()
        ));
        let manager = test_manager(&root);
        let worker_id = "desktop-019fdc2c-e848-7552-b2ea-6fc7ef09e9f2";
        let profile_directory = manager.profile_directory(worker_id);
        fs::create_dir_all(profile_directory.join("repositories/ArcaneArts/Cantrip/.git")).unwrap();
        fs::write(profile_directory.join("desktop-profile.json"), "{}").unwrap();
        fs::write(profile_directory.join("worker-credential.json"), "{}").unwrap();

        manager.remove_profile_auth(worker_id).unwrap();

        assert!(!profile_directory.join("desktop-profile.json").exists());
        assert!(!profile_directory.join("worker-credential.json").exists());
        assert!(profile_directory
            .join("repositories/ArcaneArts/Cantrip/.git")
            .exists());
        fs::remove_dir_all(root).unwrap();
    }
}
