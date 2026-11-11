//! Commands used by the packaged desktop supervisor. Runtime selection is
//! explicit package configuration; spawning reports actual executable errors.
use std::{
    fs,
    net::TcpStream,
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde::Deserialize;

use crate::process_environment::configure_desktop_child;

#[derive(Deserialize)]
#[serde(tag = "runtime", rename_all = "lowercase")]
enum ServerRuntime {
    Rust {
        #[serde(rename = "postgresBin")]
        postgres_bin: Option<std::path::PathBuf>,
        #[serde(rename = "profileConverter")]
        profile_converter: Option<std::path::PathBuf>,
    },
}

pub fn node_service_command(node: &Path, directory: &Path) -> Command {
    let mut command = Command::new(node);
    command.arg("dist/index.js").current_dir(directory);
    // A Windows worker does not read stdin. An inherited supervisor pipe can
    // stall Node before worker startup when the process has no console.
    #[cfg(windows)]
    command.stdin(Stdio::null());
    command
}

pub struct ServerLaunch {
    pub command: Command,
    pub preparation: Option<Command>,
    pub native: bool,
}

pub fn server_command(node: &Path, directory: &Path) -> Result<ServerLaunch, String> {
    let file = directory.join("desktop-server.json");
    let configuration = match fs::read(&file) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Could not read {}: {error}", file.display()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ServerRuntime::Rust {
            postgres_bin: None,
            profile_converter: Some("../profile-converter/dist/index.mjs".into()),
        },
        Err(error) => return Err(format!("Could not read {}: {error}", file.display())),
    };
    let mut preparation = None;
    let mut command = match configuration {
        ServerRuntime::Rust {
            postgres_bin,
            profile_converter,
        } => {
            let native_command = || -> Result<Command, String> {
                let mut command = Command::new(directory.join("bin").join(if cfg!(windows) {
                    "cantrip-server.exe"
                } else {
                    "cantrip-server"
                }));
                command
                    .current_dir(directory)
                    .arg("--env-file-if-exists=.env")
                    .arg("--bundled-pglite-runtime-dir")
                    .arg(directory.join("pglite"))
                    .arg("--shutdown-on-stdin-close")
                    .stdin(Stdio::piped());
                if let Some(bin) = &postgres_bin {
                    command
                        .arg("--bundled-postgres-bin-dir")
                        .arg(directory.join(bin));
                }
                #[cfg(target_os = "linux")]
                {
                    let mut paths = vec![directory.join("lib")];
                    if let Some(current) = std::env::var_os("LD_LIBRARY_PATH") {
                        paths.extend(std::env::split_paths(&current));
                    }
                    command.env(
                        "LD_LIBRARY_PATH",
                        std::env::join_paths(paths).map_err(|error| error.to_string())?,
                    );
                }
                Ok(command)
            };
            if let Some(converter) = profile_converter {
                let mut command = native_command()?;
                command
                    .args(["--migrate-only", "--upgrade-profile", "--legacy-node"])
                    .arg(node)
                    .arg("--legacy-profile-converter")
                    .arg(directory.join(converter));
                configure_desktop_child(&mut command);
                preparation = Some(command);
            }
            native_command()?
        }
    };
    configure_desktop_child(&mut command);
    Ok(ServerLaunch {
        command,
        preparation,
        native: true,
    })
}

pub fn spawn_service(
    mut command: Command,
    environment: &[(&str, String)],
    capture_stdout: bool,
    capture_stderr: bool,
) -> Result<Child, String> {
    configure_desktop_child(&mut command);
    command
        .stdout(if capture_stdout {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(if capture_stderr {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    for (key, value) in environment {
        command.env(key, value);
    }
    let executable = command.get_program().to_string_lossy().into_owned();
    command
        .spawn()
        .map_err(|error| format!("Could not start {executable}: {error}"))
}

/// Conversion duration depends on the actual database size. Wait for its real
/// completion, while allowing an approved desktop shutdown to cancel ownership.
pub fn wait_for_preparation(
    child: &mut Child,
    mut cancelled: impl FnMut() -> bool,
) -> Result<bool, String> {
    loop {
        if cancelled() {
            terminate_child(child);
            return Ok(false);
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(true),
            Ok(Some(status)) => {
                return Err(format!(
                    "Existing server data could not be prepared ({status}). The original data was retained; see the server logs."
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                terminate_child(child);
                return Err(format!(
                    "Could not wait for server data preparation: {error}"
                ));
            }
        }
    }
}

pub fn terminate_child(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    // Native servers own this pipe. Closing it also works on Windows, where
    // TerminateProcess cannot request an orderly database/service shutdown.
    if child.stdin.take().is_some() {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .status();
        for _ in 0..20 {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        configure_desktop_child(&mut command);
        let _ = command
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub fn server_environment(
    data: &Path,
    logs: &Path,
    port: u16,
    worker_token: &str,
) -> Vec<(&'static str, String)> {
    vec![
        ("CANTRIP_SERVER_HOST", "127.0.0.1".into()),
        ("CANTRIP_SERVER_PORT", port.to_string()),
        ("CANTRIP_DEPLOYMENT_MODE", "local".into()),
        ("CANTRIP_BOOTSTRAP_MODE", "tauri".into()),
        ("CANTRIP_AUTH_MODE", "none".into()),
        (
            "CANTRIP_DATA_DIR",
            data.join("server").to_string_lossy().into_owned(),
        ),
        ("CANTRIP_WORKER_TOKEN", worker_token.to_owned()),
        (
            "CANTRIP_SERVICE_LOG_DIR",
            logs.join("server").to_string_lossy().into_owned(),
        ),
    ]
}

pub fn worker_environment(
    data: &Path,
    logs: &Path,
    server_url: &str,
    worker_token: &str,
) -> Vec<(&'static str, String)> {
    vec![
        ("CANTRIP_SERVER_URL", server_url.to_owned()),
        ("CANTRIP_WORKER_TOKEN", worker_token.to_owned()),
        ("CANTRIP_WORKER_DEVELOPMENT_BOOTSTRAP", "true".into()),
        ("CANTRIP_WORKER_ID", "desktop-local".into()),
        ("CANTRIP_WORKER_NAME", "Local Worker".into()),
        (
            "CANTRIP_WORKER_DATA_DIR",
            data.join("worker").to_string_lossy().into_owned(),
        ),
        (
            "CANTRIP_SERVICE_LOG_DIR",
            logs.join("workers/desktop-local")
                .to_string_lossy()
                .into_owned(),
        ),
    ]
}

pub fn wait_for_server(child: &mut Child, port: u16) -> Result<(), String> {
    for _ in 0..100 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Ok(());
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not inspect local server: {error}"))?
        {
            return Err(format!(
                "The bundled Cantrip Server exited during startup ({status})."
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("The bundled Cantrip Server did not become ready within 10 seconds.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn pipe_owned_shutdown_finishes_before_signal_fallback() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "read unused; exit 0"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let began = Instant::now();
        terminate_child(&mut child);
        assert!(child.wait().unwrap().success());
        assert!(began.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn configured_native_server_attempts_the_executable_without_node_fallback() {
        let directory = std::env::temp_dir().join(format!(
            "cantrip-desktop-command-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        fs::write(
            directory.join("desktop-server.json"),
            r#"{"runtime":"rust","postgresBin":"postgres/bin"}"#,
        )
        .unwrap();
        let launch = server_command(Path::new("unused-node"), &directory).unwrap();
        assert!(launch.native);
        let error = spawn_service(launch.command, &[], false, false).unwrap_err();
        assert!(error.contains("cantrip-server"), "{error}");
        assert!(!error.contains("unused-node"), "{error}");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn missing_package_configuration_still_attempts_the_native_executable() {
        let directory = std::env::temp_dir().join(format!(
            "cantrip-native-default-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let launch = server_command(Path::new("unused-node"), &directory).unwrap();
        let error = spawn_service(launch.command, &[], false, false).unwrap_err();
        assert!(error.contains("cantrip-server"), "{error}");
        assert!(!error.contains("unused-node"), "{error}");
        fs::remove_dir_all(directory).unwrap();
    }
}
