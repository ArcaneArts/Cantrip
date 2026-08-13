use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{App, Manager, State};
use url::Url;
use uuid::Uuid;

use crate::terminate_child;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopWorkerProfile {
    name: String,
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
) -> (Option<String>, DesktopWorkerProfile) {
    let replaced_worker_id = existing.map(|profile| profile.worker_id.clone());
    (
        replaced_worker_id,
        DesktopWorkerProfile {
            name: name.to_string(),
            server_url: server_url.to_string(),
            worker_id: format!("desktop-{}", Uuid::new_v4()),
        },
    )
}

fn open_log(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))
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
            WorkerLaunch::Packaged { directory, node } => {
                let mut command = Command::new(node);
                command
                    .arg(directory.join("dist/index.js"))
                    .current_dir(directory);
                command
            }
        };
        command
            .env("CANTRIP_SERVER_URL", &profile.server_url)
            .env("CANTRIP_WORKER_ID", &profile.worker_id)
            .env("CANTRIP_WORKER_NAME", &profile.name)
            .env(
                "CANTRIP_WORKER_DATA_DIR",
                self.profile_directory(&profile.worker_id),
            )
            .env_remove("CANTRIP_WORKER_TOKEN")
            .env_remove("CANTRIP_WORKER_DEVELOPMENT_BOOTSTRAP")
            .env_remove("CANTRIP_WORKER_CREDENTIAL")
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        if let Some(code) = enrollment_code {
            command.env("CANTRIP_WORKER_ENROLLMENT_CODE", code);
        } else {
            command.env_remove("CANTRIP_WORKER_ENROLLMENT_CODE");
        }
        command.spawn().map_err(|error| {
            format!(
                "Could not start this machine's worker for {}: {error}",
                profile.server_url
            )
        })
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

    pub fn stop_all(&self) {
        if let Ok(mut children) = self.children.lock() {
            for child in children.values_mut() {
                terminate_child(child);
            }
            children.clear();
        }
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
        if let Err(error) = manager.ensure_running(&profile, None) {
            eprintln!("Could not reconnect linked desktop worker: {error}");
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
        if let Err(error) = workers.ensure_running(profile, None) {
            eprintln!("Could not keep linked desktop worker running: {error}");
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
pub fn pair_desktop_worker(
    enrollment_code: String,
    name: String,
    server_url: String,
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
    let existing = workers
        .profiles
        .lock()
        .map_err(|_| "The desktop worker registry is unavailable.".to_string())?
        .iter()
        .find(|profile| profile.server_url == server_url)
        .cloned();
    let (replaced_worker_id, profile) = replacement_profile(existing.as_ref(), name, &server_url);
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
    use super::{normalize_server_url, replacement_profile, DesktopWorkerProfile};

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

        let (replaced_worker_id, replacement) =
            replacement_profile(Some(&existing), "This machine", "https://relay.cantrip.art");

        assert_eq!(
            replaced_worker_id.as_deref(),
            Some(existing.worker_id.as_str())
        );
        assert_ne!(replacement.worker_id, existing.worker_id);
        assert!(replacement.worker_id.starts_with("desktop-"));
        assert_eq!(replacement.name, "This machine");
        assert_eq!(replacement.server_url, existing.server_url);
    }
}
