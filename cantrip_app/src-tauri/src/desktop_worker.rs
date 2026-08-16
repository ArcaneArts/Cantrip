use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
};

use serde::{Deserialize, Serialize};
use tauri::{App, Manager, State};
use url::Url;
use uuid::Uuid;

use crate::{node_service_command, process_environment::configure_desktop_child, terminate_child};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopWorkerProfile {
    name: String,
    server_url: String,
    worker_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorkerCredentialIdentity {
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
    children: Mutex<HashMap<String, Child>>,
    data_directory: PathBuf,
    launch: WorkerLaunch,
    logs_directory: PathBuf,
    profiles: Mutex<Vec<DesktopWorkerProfile>>,
    profiles_path: PathBuf,
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

fn valid_desktop_worker_id(value: &str) -> bool {
    value
        .strip_prefix("desktop-")
        .and_then(|value| Uuid::parse_str(value).ok())
        .is_some()
}

fn open_log(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))
}

fn mirror_child_output<R: Read + Send + 'static>(mut reader: R, mut log: File, use_stderr: bool) {
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
            if let Err(error) = log.write_all(&buffer[..read]) {
                eprintln!("Could not persist linked worker output: {error}");
            }
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

fn normalize_server_url(value: &str) -> Result<String, String> {
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

    fn spawn(
        &self,
        profile: &DesktopWorkerProfile,
        enrollment_code: Option<&str>,
    ) -> Result<Child, String> {
        let log_path = self
            .logs_directory
            .join(format!("{}.log", profile.worker_id));
        let stdout = open_log(&log_path)?;
        let stderr = stdout
            .try_clone()
            .map_err(|error| format!("Could not clone worker log handle: {error}"))?;
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
                "CANTRIP_SERVICE_LOG_FILE",
                self.service_log_path(&profile.worker_id)?,
            )
            .env(
                "CANTRIP_WORKER_DATA_DIR",
                self.profile_directory(&profile.worker_id),
            )
            .env_remove("CANTRIP_WORKER_TOKEN")
            .env_remove("CANTRIP_WORKER_DEVELOPMENT_BOOTSTRAP")
            .env_remove("CANTRIP_WORKER_CREDENTIAL");
        if cfg!(debug_assertions) {
            command.stdout(Stdio::piped()).stderr(Stdio::piped());
        } else {
            command
                .stdout(Stdio::from(stdout.try_clone().map_err(|error| {
                    format!("Could not clone worker stdout log handle: {error}")
                })?))
                .stderr(Stdio::from(stderr.try_clone().map_err(|error| {
                    format!("Could not clone worker stderr log handle: {error}")
                })?));
        }
        if let Some(code) = enrollment_code {
            command.env("CANTRIP_WORKER_ENROLLMENT_CODE", code);
        } else {
            command.env_remove("CANTRIP_WORKER_ENROLLMENT_CODE");
        }
        let mut child = command.spawn().map_err(|error| {
            format!(
                "Could not start this machine's worker for {}: {error}",
                profile.server_url
            )
        })?;
        if cfg!(debug_assertions) {
            if let Some(child_stdout) = child.stdout.take() {
                mirror_child_output(child_stdout, stdout, false);
            }
            if let Some(child_stderr) = child.stderr.take() {
                mirror_child_output(child_stderr, stderr, true);
            }
        }
        Ok(child)
    }

    fn ensure_running(
        &self,
        profile: &DesktopWorkerProfile,
        enrollment_code: Option<&str>,
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
        let child = self.spawn(profile, enrollment_code)?;
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
                    && entry.file_name().to_string_lossy() == identity.worker_id
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
        Ok(self
            .logs_directory
            .join(format!("{worker_id}.service.jsonl")))
    }
}

pub fn build(app: &App) -> Result<DesktopWorkers, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve application data: {error}"))?
        .join("linked-workers");
    let logs_directory = root.join("logs");
    fs::create_dir_all(&logs_directory)
        .map_err(|error| format!("Could not create {}: {error}", logs_directory.display()))?;
    let profiles_path = root.join("desktop-workers.json");
    let profiles = read_profiles(&profiles_path);
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
        children: Mutex::new(HashMap::new()),
        data_directory: root.join("profiles"),
        launch,
        logs_directory,
        profiles: Mutex::new(profiles.clone()),
        profiles_path,
    };
    for profile in profiles {
        if manager.has_stored_credential(&profile.worker_id) {
            if let Err(error) = manager.ensure_running(&profile, None) {
                eprintln!("Could not reconnect linked desktop worker: {error}");
            }
        }
    }
    Ok(manager)
}

#[tauri::command]
pub fn list_desktop_workers(
    workers: State<'_, DesktopWorkers>,
) -> Result<Vec<DesktopWorkerStatus>, String> {
    let profiles = workers
        .profiles
        .lock()
        .map_err(|_| "The desktop worker registry is unavailable.".to_string())?
        .clone();
    for profile in &profiles {
        if workers.has_stored_credential(&profile.worker_id) {
            if let Err(error) = workers.ensure_running(profile, None) {
                eprintln!("Could not keep linked desktop worker running: {error}");
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
    if let Some(worker_id) = replaced_worker_id {
        workers.stop(&worker_id)?;
    }
    let credential_path = workers
        .profile_directory(&profile.worker_id)
        .join("worker-credential.json");
    if credential_path.exists() {
        fs::remove_file(&credential_path).map_err(|error| {
            format!("Could not reset the previous desktop worker enrollment: {error}")
        })?;
    }
    {
        let mut profiles = workers
            .profiles
            .lock()
            .map_err(|_| "The desktop worker registry is unavailable.".to_string())?;
        profiles.retain(|candidate| candidate.server_url != server_url);
        profiles.push(profile.clone());
        write_profiles(&workers.profiles_path, &profiles)?;
    }
    workers.ensure_running(&profile, Some(&enrollment_code))?;
    Ok(DesktopWorkerStatus {
        name: profile.name,
        running: true,
        server_url: profile.server_url,
        worker_id: profile.worker_id,
    })
}

#[tauri::command]
pub fn forget_desktop_worker(
    worker_id: String,
    workers: State<'_, DesktopWorkers>,
) -> Result<(), String> {
    workers.stop(&worker_id)?;
    let mut profiles = workers
        .profiles
        .lock()
        .map_err(|_| "The desktop worker registry is unavailable.".to_string())?;
    profiles.retain(|profile| profile.worker_id != worker_id);
    write_profiles(&workers.profiles_path, &profiles)
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, fs, path::Path, sync::Mutex};

    use super::{
        normalize_server_url, replacement_profile, repository_count, sort_worker_candidates,
        DesktopWorkerCandidate, DesktopWorkerProfile, DesktopWorkers, WorkerLaunch,
    };

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
        let manager = DesktopWorkers {
            children: Mutex::new(HashMap::new()),
            data_directory: root.join("profiles"),
            launch: WorkerLaunch::Development {
                repository: root.clone(),
                tsx: root.join("tsx"),
            },
            logs_directory: root.join("logs"),
            profiles: Mutex::new(Vec::new()),
            profiles_path: root.join("desktop-workers.json"),
        };

        assert!(!manager.has_stored_credential(worker_id));
        fs::write(profile_directory.join("worker-credential.json"), "{}").unwrap();
        assert!(manager.has_stored_credential(worker_id));

        fs::remove_dir_all(root).unwrap();
    }
}
