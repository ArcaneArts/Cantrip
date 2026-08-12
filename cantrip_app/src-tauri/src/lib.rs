use std::{
    fs::{self, File, OpenOptions},
    net::{TcpListener, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tauri::{Manager, RunEvent, State};

mod project_share;

use project_share::ProjectShareMounts;

struct ManagedRuntime {
    children: Mutex<Vec<Child>>,
    server_url: String,
}

#[tauri::command]
fn local_server_url(runtime: State<'_, ManagedRuntime>) -> String {
    runtime.server_url.clone()
}

#[cfg(debug_assertions)]
fn sanitize_client_log(message: &str) -> String {
    message
        .chars()
        .take(16_384)
        .map(|character| match character {
            '\n' | '\t' => character,
            character if character.is_control() => '�',
            character => character,
        })
        .collect()
}

#[tauri::command]
fn relay_client_log(level: String, message: String) {
    #[cfg(debug_assertions)]
    {
        let level = match level.as_str() {
            "debug" => "debug",
            "error" => "error",
            "info" => "info",
            "warn" => "warn",
            _ => "log",
        };
        let prefix = format!("[client:{level}]");
        let message = sanitize_client_log(&message).replace('\n', &format!("\n{prefix} "));
        if matches!(level, "error" | "warn") {
            eprintln!("{prefix} {message}");
        } else {
            println!("{prefix} {message}");
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = (level, message);
}

#[tauri::command]
fn set_macos_pro_mode(window: tauri::WebviewWindow, enabled: bool) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let effect_window = window.clone();
        window
            .run_on_main_thread(move || {
                let _ = window_vibrancy::clear_vibrancy(&effect_window);
                if enabled {
                    if let Err(error) = window_vibrancy::apply_vibrancy(
                        &effect_window,
                        window_vibrancy::NSVisualEffectMaterial::Sidebar,
                        Some(window_vibrancy::NSVisualEffectState::FollowsWindowActiveState),
                        None,
                    ) {
                        eprintln!("Could not apply macOS Pro Mode: {error}");
                    }
                }
            })
            .map_err(|error| format!("Could not schedule macOS Pro Mode: {error}"))?;
        Ok(enabled)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, enabled);
        Ok(false)
    }
}

fn open_log(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))
}

fn spawn_node_service(
    node: &Path,
    directory: &Path,
    log_path: &Path,
    environment: &[(&str, String)],
) -> Result<Child, String> {
    let stdout = open_log(log_path)?;
    let stderr = stdout
        .try_clone()
        .map_err(|error| format!("Could not clone log handle: {error}"))?;
    let mut command = Command::new(node);
    command
        .arg(directory.join("dist/index.js"))
        .current_dir(directory)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    for (key, value) in environment {
        command.env(key, value);
    }
    command.spawn().map_err(|error| {
        format!(
            "Could not start service in {}: {error}",
            directory.display()
        )
    })
}

fn wait_for_server(child: &mut Child, port: u16) -> Result<(), String> {
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

fn reserve_local_listener(label: &str) -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Could not reserve a local {label} port: {error}"))
}

fn reserved_port(listener: &TcpListener, label: &str) -> Result<u16, String> {
    listener
        .local_addr()
        .map_err(|error| format!("Could not read reserved local {label} port: {error}"))
        .map(|address| address.port())
}

fn terminate_child(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
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
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn build_runtime(app: &tauri::App) -> Result<ManagedRuntime, String> {
    if cfg!(mobile) {
        return Ok(ManagedRuntime {
            children: Mutex::new(Vec::new()),
            server_url: std::env::var("CANTRIP_SERVER_URL").unwrap_or_default(),
        });
    }
    if cfg!(debug_assertions) {
        return Ok(ManagedRuntime {
            children: Mutex::new(Vec::new()),
            server_url: std::env::var("CANTRIP_SERVER_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:4310".into()),
        });
    }

    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not resolve bundled resources: {error}"))?
        .join("runtime");
    let data = match std::env::var_os("CANTRIP_DESKTOP_DATA_DIR") {
        Some(directory) => directory.into(),
        None => app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Could not resolve application data: {error}"))?,
    };
    let logs = data.join("logs");
    fs::create_dir_all(&logs)
        .map_err(|error| format!("Could not create {}: {error}", logs.display()))?;

    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let node = resources.join(node_name);
    let server_reservation = reserve_local_listener("server")?;
    let code_surface_reservation = reserve_local_listener("Code surface")?;
    let port = reserved_port(&server_reservation, "server")?;
    let code_surface_port = reserved_port(&code_surface_reservation, "Code surface")?;
    drop(server_reservation);
    drop(code_surface_reservation);

    let server_url = format!("http://127.0.0.1:{port}");
    let token_seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let worker_token = format!("desktop-{}-{token_seed}", std::process::id());
    let server_directory = resources.join("server");
    let worker_directory = resources.join("worker");
    let mut server = spawn_node_service(
        &node,
        &server_directory,
        &logs.join("server.log"),
        &[
            ("CANTRIP_SERVER_HOST", "127.0.0.1".into()),
            ("CANTRIP_SERVER_PORT", port.to_string()),
            ("CANTRIP_CODE_SURFACE_HOST", "127.0.0.1".into()),
            ("CANTRIP_CODE_SURFACE_PORT", code_surface_port.to_string()),
            (
                "CANTRIP_CODE_SURFACE_ORIGIN",
                format!("http://127.0.0.1:{code_surface_port}"),
            ),
            ("CANTRIP_DEPLOYMENT_MODE", "local".into()),
            ("CANTRIP_BOOTSTRAP_MODE", "tauri".into()),
            ("CANTRIP_AUTH_MODE", "none".into()),
            (
                "CANTRIP_DATA_DIR",
                data.join("server").to_string_lossy().into_owned(),
            ),
            ("CANTRIP_WORKER_TOKEN", worker_token.clone()),
        ],
    )?;
    if let Err(error) = wait_for_server(&mut server, port) {
        terminate_child(&mut server);
        return Err(error);
    }

    let worker = match spawn_node_service(
        &node,
        &worker_directory,
        &logs.join("worker.log"),
        &[
            ("CANTRIP_SERVER_URL", server_url.clone()),
            ("CANTRIP_WORKER_TOKEN", worker_token),
            ("CANTRIP_WORKER_DEVELOPMENT_BOOTSTRAP", "true".into()),
            ("CANTRIP_WORKER_ID", "desktop-local".into()),
            ("CANTRIP_WORKER_NAME", "Local Worker".into()),
            (
                "CANTRIP_WORKER_DATA_DIR",
                data.join("worker").to_string_lossy().into_owned(),
            ),
        ],
    ) {
        Ok(worker) => worker,
        Err(error) => {
            terminate_child(&mut server);
            return Err(error);
        }
    };

    Ok(ManagedRuntime {
        children: Mutex::new(vec![server, worker]),
        server_url,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            local_server_url,
            relay_client_log,
            set_macos_pro_mode,
            project_share::reveal_project_share,
        ])
        .setup(|app| {
            let runtime = build_runtime(app).map_err(std::io::Error::other)?;
            app.manage(runtime);
            app.manage(ProjectShareMounts::default());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Cantrip");

    #[cfg(desktop)]
    {
        let shutdown_handle = app.handle().clone();
        ctrlc::set_handler(move || shutdown_handle.exit(0))
            .expect("could not install Cantrip shutdown handler");
    }

    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit) {
            handle.state::<ProjectShareMounts>().cleanup();
            let runtime = handle.state::<ManagedRuntime>();
            if let Ok(mut children) = runtime.children.lock() {
                for child in children.iter_mut().rev() {
                    terminate_child(child);
                }
                children.clear();
            };
        }
    });
}
