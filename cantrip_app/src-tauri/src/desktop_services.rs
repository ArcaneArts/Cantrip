//! Commands used by the packaged desktop supervisor. Package configuration
//! supplies database asset paths. Spawning reports actual executable errors.
use std::{
    fs,
    net::{SocketAddr, TcpStream},
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
        #[serde(rename = "legacyPostgresBin")]
        legacy_postgres_bin: Option<std::path::PathBuf>,
    },
}

pub fn worker_command(directory: &Path) -> Command {
    native_worker_command(&directory.join("bin").join(worker_binary_name()), directory)
}

pub(crate) fn worker_binary_name() -> &'static str {
    if cfg!(windows) {
        "cantrip-worker.exe"
    } else {
        "cantrip-worker"
    }
}

pub(crate) fn native_worker_command(executable: &Path, directory: &Path) -> Command {
    let mut command = Command::new(executable);
    command
        .current_dir(directory)
        .arg("--shutdown-on-stdin-close")
        .stdin(Stdio::piped());
    command
}

pub struct ServerLaunch {
    pub command: Command,
    pub preparation: Command,
}

pub fn server_command(directory: &Path) -> Result<ServerLaunch, String> {
    let file = directory.join("desktop-server.json");
    let ServerRuntime::Rust {
        postgres_bin,
        legacy_postgres_bin,
    } = match fs::read(&file) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Could not read {}: {error}", file.display()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ServerRuntime::Rust {
            postgres_bin: None,
            legacy_postgres_bin: None,
        },
        Err(error) => return Err(format!("Could not read {}: {error}", file.display())),
    };
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
    let mut preparation = native_command()?;
    preparation
        .args([
            "--migrate-only",
            "--upgrade-profile",
            "--legacy-postgres-bin-dir",
        ])
        .arg(
            directory.join(
                legacy_postgres_bin
                    .as_deref()
                    .unwrap_or(Path::new("legacy-postgres/bin")),
            ),
        );
    Ok(ServerLaunch {
        command: native_command()?,
        preparation,
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
    terminate_with_stdin_grace(child, Duration::from_secs(10));
}

pub fn terminate_server(child: &mut Child) {
    // Bundled PostgreSQL can spend 30 seconds stopping after the server has
    // drained requests and closed its database connections. On Windows, an
    // embedded PGlite checkpoint alone nearly consumed the old 60-second
    // allowance. Give the full Windows shutdown time to flush before taskkill.
    #[cfg(windows)]
    let grace = Duration::from_secs(180);
    #[cfg(not(windows))]
    let grace = Duration::from_secs(60);
    terminate_with_stdin_grace(child, grace);
}

fn terminate_with_stdin_grace(child: &mut Child, grace: Duration) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    // Native services own this pipe. Closing it also works on Windows, where
    // TerminateProcess cannot request an orderly database/service shutdown.
    if child.stdin.take().is_some() {
        let deadline = Instant::now() + grace;
        loop {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            thread::sleep(remaining.min(Duration::from_millis(50)));
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

pub fn wait_for_server(
    child: &mut Child,
    port: u16,
    mut cancelled: impl FnMut() -> bool,
) -> Result<bool, String> {
    // A fresh PGlite profile exceeded five minutes in Windows x64 QA.
    // Keep the wait cancellable and bound each connection attempt separately.
    const STARTUP_TIMEOUT: Duration = Duration::from_secs(10 * 60);
    const POLL_INTERVAL: Duration = Duration::from_millis(100);

    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        if cancelled() {
            terminate_server(child);
            return Ok(false);
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not inspect local server: {error}"))?
        {
            return Err(format!(
                "The bundled Cantrip Server exited during startup ({status})."
            ));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "The bundled Cantrip Server did not become ready within {} seconds.",
                STARTUP_TIMEOUT.as_secs()
            ));
        }
        if TcpStream::connect_timeout(&address, remaining.min(POLL_INTERVAL)).is_ok() {
            return Ok(true);
        }
        thread::sleep(
            deadline
                .saturating_duration_since(Instant::now())
                .min(POLL_INTERVAL),
        );
    }
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

    #[cfg(unix)]
    #[test]
    fn server_can_finish_draining_after_the_generic_child_deadline() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "read unused; sleep 11; exit 0"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();

        terminate_server(&mut child);

        assert!(child.wait().unwrap().success());
    }

    #[cfg(unix)]
    #[test]
    fn startup_waits_for_a_listener_after_the_previous_deadline() {
        use std::net::TcpListener;

        let reservation = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = reservation.local_addr().unwrap();
        let mut child = Command::new("/bin/sh")
            .args(["-c", "read unused"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        // The readiness loop must only be able to reach the delayed listener.
        drop(reservation);
        let listener = thread::spawn(move || {
            thread::sleep(Duration::from_secs(11));
            let listener = TcpListener::bind(address).unwrap();
            // Keep the listener alive while the supervisor observes it.
            listener.accept().unwrap();
        });
        let result = wait_for_server(&mut child, address.port(), || false);
        terminate_child(&mut child);
        assert_eq!(result, Ok(true));
        listener.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn cancelling_startup_reaps_the_server() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "read unused"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        assert_eq!(wait_for_server(&mut child, 0, || true), Ok(false));
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn configured_server_prepares_with_native_compatibility_tools() {
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
            r#"{"runtime":"rust","postgresBin":"postgres/bin","legacyPostgresBin":"tools/bin"}"#,
        )
        .unwrap();
        let launch = server_command(&directory).unwrap();
        assert_eq!(
            launch.preparation.get_program(),
            launch.command.get_program()
        );
        let args: Vec<_> = launch.preparation.get_args().collect();
        assert_eq!(
            &args[args.len() - 4..],
            &[
                std::ffi::OsStr::new("--migrate-only"),
                std::ffi::OsStr::new("--upgrade-profile"),
                std::ffi::OsStr::new("--legacy-postgres-bin-dir"),
                directory.join("tools/bin").as_os_str(),
            ]
        );
        let error = spawn_service(launch.preparation, &[], false, false).unwrap_err();
        assert!(error.contains("cantrip-server"), "{error}");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn packaged_worker_attempts_the_native_executable() {
        let directory = std::env::temp_dir().join(format!(
            "cantrip-desktop-worker-command-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let command = worker_command(&directory);
        assert_eq!(command.get_current_dir(), Some(directory.as_path()));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![std::ffi::OsStr::new("--shutdown-on-stdin-close")]
        );
        let error = spawn_service(command, &[], false, false).unwrap_err();
        assert!(error.contains("cantrip-worker"), "{error}");
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
        let launch = server_command(&directory).unwrap();
        let default_legacy_bin = directory.join("legacy-postgres/bin");
        assert_eq!(
            launch.preparation.get_args().last(),
            Some(default_legacy_bin.as_os_str())
        );
        let error = spawn_service(launch.command, &[], false, false).unwrap_err();
        assert!(error.contains("cantrip-server"), "{error}");
        fs::remove_dir_all(directory).unwrap();
    }
}
