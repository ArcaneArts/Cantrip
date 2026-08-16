use std::{
    fs::{self, File, OpenOptions},
    net::{TcpListener, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "macos")]
use tauri::menu::MenuItemKind;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, State, WindowEvent,
};
#[cfg(desktop)]
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
#[cfg(desktop)]
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

mod desktop_update;
mod desktop_worker;
mod direct_probe;
mod process_environment;
mod project_share;
mod tunnel_forward;

use process_environment::configure_desktop_child;
use project_share::ProjectShareMounts;
use tunnel_forward::TunnelForwards;

struct ManagedRuntime {
    children: Mutex<Vec<Child>>,
    server_url: String,
}

#[cfg(desktop)]
#[derive(Default)]
struct DesktopShutdownState {
    complete: Mutex<bool>,
}

#[cfg(desktop)]
fn run_shutdown_once(complete: &Mutex<bool>, shutdown: impl FnOnce()) -> bool {
    let mut complete = complete.lock().unwrap_or_else(|error| error.into_inner());
    if *complete {
        return false;
    }
    shutdown();
    *complete = true;
    true
}

#[cfg(desktop)]
pub(crate) fn shutdown_owned_runtime(app: &tauri::AppHandle) -> bool {
    let shutdown = app.state::<DesktopShutdownState>();
    run_shutdown_once(&shutdown.complete, || {
        app.state::<ProjectShareMounts>().cleanup();
        app.state::<TunnelForwards>().cleanup();
        app.state::<desktop_worker::DesktopWorkers>().stop_all();
        let runtime = app.state::<ManagedRuntime>();
        if let Ok(mut children) = runtime.children.lock() {
            for child in children.iter_mut().rev() {
                terminate_child(child);
            }
            children.clear();
        };
    })
}

#[cfg(desktop)]
#[derive(Default)]
struct DesktopExitState {
    approved: AtomicBool,
    confirmation_open: AtomicBool,
}

#[cfg(desktop)]
fn exit_request_needs_confirmation(approved: bool, code: Option<i32>) -> bool {
    !approved && code != Some(tauri::RESTART_EXIT_CODE)
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
fn relay_client_log(
    window: tauri::WebviewWindow,
    level: String,
    message: String,
    source: Option<String>,
) {
    #[cfg(debug_assertions)]
    {
        let level = match level.as_str() {
            "debug" => "debug",
            "error" => "error",
            "info" => "info",
            "trace" => "trace",
            "warn" => "warn",
            _ => "log",
        };
        let prefix = format!("[client:{}:{level}]", window.label());
        let message = sanitize_client_log(&message).replace('\n', &format!("\n{prefix} "));
        let source = source
            .as_deref()
            .map(sanitize_client_log)
            .map(|source| source.replace(['\n', '\t'], " "))
            .filter(|source| !source.is_empty())
            .map(|source| format!(" {source}"))
            .unwrap_or_default();
        if matches!(level, "error" | "warn") {
            eprintln!("{prefix}{source} {message}");
        } else {
            println!("{prefix}{source} {message}");
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = (window, level, message, source);
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

fn node_service_command(node: &Path, directory: &Path) -> Command {
    let mut command = Command::new(node);
    command.arg("dist/index.js").current_dir(directory);
    command
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
    let mut command = node_service_command(node, directory);
    configure_desktop_child(&mut command);
    command
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

pub(crate) fn terminate_child(child: &mut Child) {
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

#[tauri::command]
fn desktop_autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        app.autolaunch()
            .is_enabled()
            .map_err(|error| format!("Could not inspect launch-at-login: {error}"))
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Ok(false)
    }
}

#[tauri::command]
fn set_desktop_autostart(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        let manager = app.autolaunch();
        if enabled {
            manager
                .enable()
                .map_err(|error| format!("Could not enable launch-at-login: {error}"))?;
        } else {
            manager
                .disable()
                .map_err(|error| format!("Could not disable launch-at-login: {error}"))?;
        }
        manager
            .is_enabled()
            .map_err(|error| format!("Could not verify launch-at-login: {error}"))
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, enabled);
        Ok(false)
    }
}

#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
fn close_desktop_windows(app: &tauri::AppHandle) {
    for (label, window) in app.webview_windows() {
        if label == "main" {
            let _ = window.hide();
        } else {
            let _ = window.close();
        }
    }
}

#[cfg(target_os = "macos")]
fn setup_macos_application_menu(app: &tauri::App) -> tauri::Result<()> {
    let menu = Menu::default(app.handle())?;
    let Some(MenuItemKind::Submenu(application_menu)) = menu.items()?.into_iter().next() else {
        return Err(tauri::Error::AssetNotFound("macOS application menu".into()));
    };
    let items = application_menu.items()?;
    if !items.is_empty() {
        application_menu.remove_at(items.len() - 1)?;
    }
    application_menu.append(&MenuItem::with_id(
        app,
        "close-cantrip-windows",
        "Close Cantrip Windows",
        true,
        Some("CmdOrCtrl+Q"),
    )?)?;
    menu.set_as_app_menu()?;
    Ok(())
}

#[cfg(desktop)]
fn request_quit_confirmation(app: &tauri::AppHandle) {
    let exit_state = app.state::<DesktopExitState>();
    if exit_state.confirmation_open.swap(true, Ordering::SeqCst) {
        return;
    }

    show_main_window(app);
    let app_handle = app.clone();
    let mut dialog = app
        .dialog()
        .message(
            "Quitting Cantrip stops the local worker and server. Other devices will no longer be able to connect to this machine or run work on it.",
        )
        .title("Quit Cantrip?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit Cantrip".into(),
            "Keep Running".into(),
        ));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    dialog.show(move |confirmed| {
        let exit_state = app_handle.state::<DesktopExitState>();
        exit_state.confirmation_open.store(false, Ordering::SeqCst);
        if confirmed {
            exit_state.approved.store(true, Ordering::SeqCst);
            app_handle.exit(0);
        }
    });
}

#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Open Cantrip", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Cantrip", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::new().menu(&menu).tooltip("Cantrip");
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, event| match event.id.as_ref() {
        "show" => show_main_window(app),
        "quit" => request_quit_confirmation(app),
        _ => {}
    })
    .on_tray_icon_event(|tray, event| {
        if matches!(
            event,
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
        ) {
            show_main_window(tray.app_handle());
        }
    })
    .build(app)?;
    Ok(())
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            #[cfg(desktop)]
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(all(
        desktop,
        not(debug_assertions),
        any(target_os = "macos", target_os = "windows")
    ))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            desktop_autostart_enabled,
            set_desktop_autostart,
            desktop_update::desktop_update_capability,
            desktop_update::desktop_update_status,
            desktop_update::check_desktop_update,
            desktop_update::install_desktop_update,
            desktop_update::cancel_desktop_update,
            desktop_worker::list_desktop_workers,
            desktop_worker::list_desktop_worker_candidates,
            desktop_worker::pair_desktop_worker,
            desktop_worker::forget_desktop_worker,
            direct_probe::probe_direct_worker,
            local_server_url,
            relay_client_log,
            set_macos_pro_mode,
            project_share::fallback_project_share,
            project_share::list_direct_project_share_tunnels,
            project_share::reveal_project_share,
            tunnel_forward::start_tunnel_forward,
            tunnel_forward::refresh_tunnel_forward_relay,
            tunnel_forward::stop_tunnel_forward,
            tunnel_forward::list_tunnel_forwards,
        ])
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                Some(vec!["--background"]),
            ))?;
            let runtime = build_runtime(app).map_err(std::io::Error::other)?;
            let desktop_workers = desktop_worker::build(app).map_err(std::io::Error::other)?;
            app.manage(runtime);
            app.manage(desktop_workers);
            app.manage(ProjectShareMounts::default());
            app.manage(TunnelForwards::default());
            app.manage(desktop_update::DesktopUpdateCoordinator::default());
            #[cfg(desktop)]
            {
                app.manage(DesktopShutdownState::default());
                app.manage(DesktopExitState::default());
                setup_tray(app)?;
                #[cfg(target_os = "macos")]
                setup_macos_application_menu(app)?;
                app.on_menu_event(|app, event| {
                    if event.id().as_ref() == "close-cantrip-windows" {
                        close_desktop_windows(app);
                    }
                });
                if std::env::args().any(|argument| argument == "--background") {
                    if let Some(window) = app.get_webview_window("main") {
                        window.hide()?;
                    }
                }
            }
            Ok(())
        });
    #[cfg(debug_assertions)]
    let builder = builder.append_invoke_initialization_script(include_str!("client_log_relay.js"));
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building Cantrip");

    #[cfg(desktop)]
    {
        let shutdown_handle = app.handle().clone();
        ctrlc::set_handler(move || {
            shutdown_handle
                .state::<DesktopExitState>()
                .approved
                .store(true, Ordering::SeqCst);
            shutdown_handle.exit(0);
        })
        .expect("could not install Cantrip shutdown handler");
    }

    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = &event {
            show_main_window(handle);
        }
        #[cfg(desktop)]
        if let RunEvent::ExitRequested { code, api, .. } = &event {
            let state = handle.state::<DesktopExitState>();
            if exit_request_needs_confirmation(state.approved.load(Ordering::SeqCst), *code) {
                api.prevent_exit();
                request_quit_confirmation(handle);
            }
        }
        #[cfg(desktop)]
        if let RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } = &event
        {
            if label == "main" {
                api.prevent_close();
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
        }
        if matches!(event, RunEvent::Exit) {
            #[cfg(desktop)]
            shutdown_owned_runtime(handle);
        }
    });
}

#[cfg(all(test, desktop))]
mod tests {
    use std::{
        ffi::OsStr,
        path::Path,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Mutex,
        },
    };

    use super::{exit_request_needs_confirmation, node_service_command, run_shutdown_once};

    #[test]
    fn packaged_node_services_use_a_working_directory_relative_entrypoint() {
        let directory = Path::new(r"C:\Program Files\Cantrip\runtime\server");
        let command = node_service_command(
            Path::new(r"C:\Program Files\Cantrip\runtime\node.exe"),
            directory,
        );

        assert_eq!(command.get_current_dir(), Some(directory));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![OsStr::new("dist/index.js")]
        );
    }

    #[test]
    fn unsolicited_exit_requests_require_confirmation() {
        assert!(exit_request_needs_confirmation(false, None));
        assert!(exit_request_needs_confirmation(false, Some(0)));
    }

    #[test]
    fn approved_exits_and_restarts_skip_confirmation() {
        assert!(!exit_request_needs_confirmation(true, Some(0)));
        assert!(!exit_request_needs_confirmation(
            false,
            Some(tauri::RESTART_EXIT_CODE)
        ));
    }

    #[test]
    fn owned_runtime_shutdown_is_idempotent() {
        let complete = Mutex::new(false);
        let calls = AtomicUsize::new(0);

        assert!(run_shutdown_once(&complete, || {
            calls.fetch_add(1, Ordering::SeqCst);
        }));
        assert!(!run_shutdown_once(&complete, || {
            calls.fetch_add(1, Ordering::SeqCst);
        }));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
