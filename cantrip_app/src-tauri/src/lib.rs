use std::{
    fs,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::json;
#[cfg(target_os = "macos")]
use tauri::menu::{MenuItemKind, PredefinedMenuItem};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent, State, WindowEvent,
};
#[cfg(desktop)]
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
#[cfg(desktop)]
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

mod desktop_update;
mod desktop_worker;
mod direct_probe;
mod local_logs;
mod process_environment;
mod project_share;
mod synthetic_build;
mod tunnel_forward;

use process_environment::configure_desktop_child;
use project_share::ProjectShareMounts;
use tunnel_forward::TunnelForwards;

pub(crate) struct ManagedRuntime {
    children: Mutex<Vec<ManagedChild>>,
    local_worker: Option<LocalWorkerRuntime>,
    server_url: String,
}

struct LocalWorkerRuntime {
    data_directory: PathBuf,
    worker_id: Option<String>,
}

impl ManagedRuntime {
    pub(crate) fn local_worker_data_directory(
        &self,
        server_url: &str,
        worker_id: &str,
    ) -> Option<&Path> {
        let local_worker = self.local_worker.as_ref()?;
        if desktop_worker::normalize_server_url(&self.server_url)
            .ok()?
            .as_str()
            != server_url
            || local_worker
                .worker_id
                .as_deref()
                .is_some_and(|local_worker_id| local_worker_id != worker_id)
        {
            return None;
        }
        Some(&local_worker.data_directory)
    }
}

struct ManagedChild {
    child: Child,
    exit_reported: bool,
    service: &'static str,
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
        app.state::<synthetic_build::SyntheticBuildCoordinator>()
            .cancel_active();
        app.state::<ProjectShareMounts>().cleanup();
        app.state::<TunnelForwards>().cleanup();
        app.state::<desktop_worker::DesktopWorkers>().stop_all();
        let runtime = app.state::<ManagedRuntime>();
        if let Ok(mut children) = runtime.children.lock() {
            for child in children.iter_mut().rev() {
                app.state::<local_logs::LocalServiceLogs>().runtime_event(
                    "info",
                    "Stopping bundled desktop service",
                    Some(json!({
                        "event": "desktop.child.stop.started",
                        "operation": "stop-child",
                        "service": child.service,
                        "subsystem": "desktop-runtime"
                    })),
                );
                terminate_child(&mut child.child);
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
pub(crate) fn approve_desktop_exit(app: &tauri::AppHandle) {
    app.state::<DesktopExitState>()
        .approved
        .store(true, Ordering::SeqCst);
}

#[cfg(desktop)]
fn exit_request_needs_confirmation(approved: bool, code: Option<i32>) -> bool {
    !approved && code != Some(tauri::RESTART_EXIT_CODE)
}

#[tauri::command]
fn local_server_url(runtime: State<'_, ManagedRuntime>) -> String {
    runtime.server_url.clone()
}

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
    logs: State<'_, local_logs::LocalServiceLogs>,
) {
    logs.append_client(&level, message.clone(), source.clone());
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
    let _ = window;
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
                    if let Err(_error) = window_vibrancy::apply_vibrancy(
                        &effect_window,
                        window_vibrancy::NSVisualEffectMaterial::Sidebar,
                        Some(window_vibrancy::NSVisualEffectState::FollowsWindowActiveState),
                        None,
                    ) {
                        effect_window
                            .app_handle()
                            .state::<local_logs::LocalServiceLogs>()
                            .runtime_event(
                                "warn",
                                "Could not apply macOS Pro Mode",
                                Some(json!({
                                    "event": "desktop.pro-mode.failed",
                                    "operation": "apply-vibrancy",
                                    "reasonCode": "native-effect-error",
                                    "subsystem": "desktop-window",
                                    "reasonCode": "native-effect-error"
                                })),
                            );
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

fn node_service_command(node: &Path, directory: &Path) -> Command {
    let mut command = Command::new(node);
    command.arg("dist/index.js").current_dir(directory);
    command
}

fn spawn_node_service(
    node: &Path,
    directory: &Path,
    environment: &[(&str, String)],
) -> Result<Child, String> {
    let mut command = node_service_command(node, directory);
    configure_desktop_child(&mut command);
    command.stdout(Stdio::null()).stderr(Stdio::null());
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
        let result = manager
            .is_enabled()
            .map_err(|error| format!("Could not verify launch-at-login: {error}"))?;
        app.state::<local_logs::LocalServiceLogs>().runtime_event(
            "info",
            "Desktop launch-at-login preference changed",
            Some(json!({
                "enabled": result,
                "event": "desktop.autostart.updated",
                "operation": "set-autostart",
                "status": "completed",
                "subsystem": "desktop-runtime"
            })),
        );
        Ok(result)
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
        app.state::<local_logs::LocalServiceLogs>().runtime_event(
            "debug",
            "Main desktop window shown",
            Some(json!({
                "event": "desktop.window.shown",
                "operation": "show-window",
                "subsystem": "desktop-window"
            })),
        );
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
    app.state::<local_logs::LocalServiceLogs>().runtime_event(
        "info",
        "Desktop windows closed while runtime remains active",
        Some(json!({
            "event": "desktop.windows.closed",
            "operation": "close-windows",
            "status": "background",
            "subsystem": "desktop-window"
        })),
    );
}

#[cfg(target_os = "macos")]
const NEW_AGENT_CHAT_ACTION_ID: &str = "project.new-agent-chat";
#[cfg(target_os = "macos")]
const NEW_TERMINAL_ACTION_ID: &str = "project.new-terminal";
#[cfg(target_os = "macos")]
const APP_ACTION_EVENT: &str = "cantrip://app-action";

#[cfg(target_os = "macos")]
fn setup_macos_application_menu(app: &tauri::App) -> tauri::Result<()> {
    let menu = Menu::default(app.handle())?;
    let items = menu.items()?;
    let Some(MenuItemKind::Submenu(application_menu)) = items.first() else {
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
    let file_menu = menu
        .items()?
        .into_iter()
        .find_map(|item| match item {
            MenuItemKind::Submenu(submenu) if submenu.text().ok().as_deref() == Some("File") => {
                Some(submenu)
            }
            _ => None,
        })
        .ok_or_else(|| tauri::Error::AssetNotFound("macOS File menu".into()))?;
    let new_agent_chat = MenuItem::with_id(
        app,
        NEW_AGENT_CHAT_ACTION_ID,
        "New Agent Chat",
        false,
        Some("CmdOrCtrl+N"),
    )?;
    let new_terminal = MenuItem::with_id(
        app,
        NEW_TERMINAL_ACTION_ID,
        "New Terminal",
        false,
        Some("CmdOrCtrl+T"),
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    file_menu.prepend_items(&[&new_agent_chat, &new_terminal, &separator])?;
    menu.set_as_app_menu()?;
    Ok(())
}

#[tauri::command]
fn set_desktop_app_action_availability(
    app: tauri::AppHandle,
    enabled_action_ids: Vec<String>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let menu = app
            .menu()
            .ok_or_else(|| "The macOS application menu is unavailable.".to_string())?;
        let submenus = menu.items().map_err(|error| error.to_string())?;
        for action_id in [NEW_AGENT_CHAT_ACTION_ID, NEW_TERMINAL_ACTION_ID] {
            let enabled = enabled_action_ids.iter().any(|id| id == action_id);
            let item = submenus.iter().find_map(|item| match item {
                MenuItemKind::Submenu(submenu) => submenu.get(action_id),
                _ => None,
            });
            let Some(MenuItemKind::MenuItem(item)) = item else {
                return Err(format!("The {action_id} menu action is unavailable."));
            };
            item.set_enabled(enabled)
                .map_err(|error| error.to_string())?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, enabled_action_ids);
    }
    Ok(())
}

#[cfg(desktop)]
fn request_quit_confirmation(app: &tauri::AppHandle) {
    let exit_state = app.state::<DesktopExitState>();
    if exit_state.confirmation_open.swap(true, Ordering::SeqCst) {
        return;
    }

    show_main_window(app);
    app.state::<local_logs::LocalServiceLogs>().runtime_event(
        "info",
        "Desktop quit confirmation requested",
        Some(json!({
            "event": "desktop.quit.confirmation-requested",
            "operation": "request-exit",
            "subsystem": "desktop-runtime"
        })),
    );
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
            app_handle
                .state::<local_logs::LocalServiceLogs>()
                .runtime_event(
                    "info",
                    "Desktop shutdown approved",
                    Some(json!({
                        "event": "desktop.quit.approved",
                        "operation": "request-exit",
                        "subsystem": "desktop-runtime"
                    })),
                );
            exit_state.approved.store(true, Ordering::SeqCst);
            app_handle.exit(0);
        }
    });
}

#[cfg(target_os = "macos")]
const MACOS_TRAY_ICON_SVG: &[u8] = include_bytes!("../icons/icons8-bolt.svg");
#[cfg(target_os = "macos")]
const MACOS_TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/tray-icon-macos.png");

#[cfg(target_os = "macos")]
fn install_macos_vector_tray_icon(tray: &tauri::tray::TrayIcon) -> tauri::Result<()> {
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSCellImagePosition, NSImage, NSImageScaling};
    use objc2_foundation::{MainThreadMarker, NSData, NSSize};

    tray.with_inner_tray_icon(|inner| -> std::io::Result<()> {
        let mtm = MainThreadMarker::new().ok_or_else(|| {
            std::io::Error::other("tray icon must be configured on the main thread")
        })?;
        let status_item = inner
            .ns_status_item()
            .ok_or_else(|| std::io::Error::other("macOS tray status item is unavailable"))?;
        let svg_data = NSData::with_bytes(MACOS_TRAY_ICON_SVG);

        let button = status_item
            .button(mtm)
            .ok_or_else(|| std::io::Error::other("macOS tray button is unavailable"))?;
        let image = NSImage::initWithData(NSImage::alloc(), &svg_data)
            .or_else(|| {
                let png_data = NSData::with_bytes(MACOS_TRAY_ICON_PNG);
                NSImage::initWithData(NSImage::alloc(), &png_data)
            })
            .ok_or_else(|| std::io::Error::other("macOS could not decode the tray icon"))?;
        image.setSize(NSSize::new(18.0, 18.0));
        image.setTemplate(true);
        button.setImage(Some(&image));
        button.setImagePosition(NSCellImagePosition::ImageOnly);
        button.setImageScaling(NSImageScaling::ScaleNone);
        Ok(())
    })??;
    Ok(())
}

#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Open Cantrip", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Cantrip", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let tray = TrayIconBuilder::new().menu(&menu).tooltip("Cantrip");
    #[cfg(not(target_os = "macos"))]
    let tray = match app.default_window_icon() {
        Some(icon) => tray.icon(icon.clone()),
        None => tray,
    };
    let tray = tray
        .on_menu_event(|app, event| match event.id.as_ref() {
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
    #[cfg(target_os = "macos")]
    install_macos_vector_tray_icon(&tray)?;
    Ok(())
}

fn build_runtime(app: &tauri::App) -> Result<ManagedRuntime, String> {
    let runtime_started_at = Instant::now();
    let service_logs = app.state::<local_logs::LocalServiceLogs>();
    if cfg!(mobile) {
        service_logs.runtime_event(
            "info",
            "Mobile client uses an external Cantrip server",
            Some(json!({
                "event": "desktop.runtime.external",
                "operation": "bootstrap-runtime",
                "runtimeKind": "mobile",
                "subsystem": "desktop-runtime"
            })),
        );
        return Ok(ManagedRuntime {
            children: Mutex::new(Vec::new()),
            local_worker: None,
            server_url: std::env::var("CANTRIP_SERVER_URL").unwrap_or_default(),
        });
    }
    if cfg!(debug_assertions) {
        service_logs.runtime_event(
            "info",
            "Development client uses externally managed local services",
            Some(json!({
                "event": "desktop.runtime.external",
                "operation": "bootstrap-runtime",
                "runtimeKind": "development",
                "subsystem": "desktop-runtime"
            })),
        );
        let data_directory = std::env::var_os("CANTRIP_WORKER_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .and_then(Path::parent)
                    .expect("the Tauri crate must be nested in the Cantrip repository")
                    .join(".cantrip/dev/worker")
            });
        return Ok(ManagedRuntime {
            children: Mutex::new(Vec::new()),
            local_worker: Some(LocalWorkerRuntime {
                data_directory,
                worker_id: std::env::var("CANTRIP_WORKER_ID")
                    .ok()
                    .and_then(|worker_id| {
                        let worker_id = worker_id.trim();
                        (!worker_id.is_empty()).then(|| worker_id.to_string())
                    }),
            }),
            server_url: std::env::var("CANTRIP_SERVER_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:4310".into()),
        });
    }

    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not resolve bundled resources: {error}"))?
        .join("runtime");
    service_logs.runtime_event(
        "info",
        "Bundled desktop runtime startup began",
        Some(json!({
            "event": "desktop.runtime.started",
            "operation": "bootstrap-runtime",
            "runtimeKind": "bundled",
            "subsystem": "desktop-runtime"
        })),
    );
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
            (
                "CANTRIP_SERVICE_LOG_DIR",
                logs.join("server").to_string_lossy().into_owned(),
            ),
        ],
    )?;
    service_logs.runtime_event(
        "info",
        "Bundled Cantrip Server process started",
        Some(json!({
            "event": "desktop.child.started",
            "operation": "start-child",
            "service": "server",
            "subsystem": "desktop-runtime"
        })),
    );
    if let Err(error) = wait_for_server(&mut server, port) {
        service_logs.runtime_event(
            "error",
            "Bundled Cantrip Server failed readiness",
            Some(json!({
                "durationMs": runtime_started_at.elapsed().as_millis(),
                "event": "desktop.child.readiness.failed",
                "operation": "wait-ready",
                "reasonCode": "readiness-timeout",
                "service": "server",
                "status": "failed",
                "subsystem": "desktop-runtime"
            })),
        );
        terminate_child(&mut server);
        return Err(error);
    }
    service_logs.runtime_event(
        "info",
        "Bundled Cantrip Server is ready",
        Some(json!({
            "durationMs": runtime_started_at.elapsed().as_millis(),
            "event": "desktop.child.ready",
            "operation": "wait-ready",
            "service": "server",
            "status": "ready",
            "subsystem": "desktop-runtime"
        })),
    );

    let worker = match spawn_node_service(
        &node,
        &worker_directory,
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
            (
                "CANTRIP_SERVICE_LOG_DIR",
                logs.join("workers/desktop-local")
                    .to_string_lossy()
                    .into_owned(),
            ),
        ],
    ) {
        Ok(worker) => worker,
        Err(error) => {
            terminate_child(&mut server);
            return Err(error);
        }
    };

    service_logs.runtime_event(
        "info",
        "Bundled Cantrip Worker process started",
        Some(json!({
            "durationMs": runtime_started_at.elapsed().as_millis(),
            "event": "desktop.child.started",
            "operation": "start-child",
            "service": "worker",
            "subsystem": "desktop-runtime"
        })),
    );

    Ok(ManagedRuntime {
        children: Mutex::new(vec![
            ManagedChild {
                child: server,
                exit_reported: false,
                service: "server",
            },
            ManagedChild {
                child: worker,
                exit_reported: false,
                service: "worker",
            },
        ]),
        local_worker: Some(LocalWorkerRuntime {
            data_directory: data.join("worker"),
            worker_id: Some("desktop-local".into()),
        }),
        server_url,
    })
}

#[cfg(desktop)]
fn monitor_owned_runtime(app: tauri::AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(2));
        let runtime = app.state::<ManagedRuntime>();
        let Ok(mut children) = runtime.children.lock() else {
            continue;
        };
        for managed in children.iter_mut() {
            if managed.exit_reported {
                continue;
            }
            match managed.child.try_wait() {
                Ok(Some(status)) => {
                    managed.exit_reported = true;
                    app.state::<local_logs::LocalServiceLogs>().runtime_event(
                        "error",
                        "Bundled desktop service exited unexpectedly",
                        Some(json!({
                            "event": "desktop.child.exited",
                            "exitCode": status.code(),
                            "operation": "monitor-child",
                            "service": managed.service,
                            "status": "failed",
                            "subsystem": "desktop-runtime"
                        })),
                    );
                }
                Ok(None) => {}
                Err(_error) => {
                    app.state::<local_logs::LocalServiceLogs>().runtime_event(
                        "warn",
                        "Bundled desktop service could not be inspected",
                        Some(json!({
                            "event": "desktop.child.monitor.failed",
                            "operation": "monitor-child",
                            "reasonCode": "process-inspection-failed",
                            "service": managed.service,
                            "subsystem": "desktop-runtime"
                        })),
                    );
                }
            }
        }
    });
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
            desktop_update::list_desktop_update_history,
            desktop_update::select_desktop_update,
            desktop_update::install_desktop_update,
            desktop_update::cancel_desktop_update,
            synthetic_build::synthetic_build_capability,
            synthetic_build::scan_synthetic_build_prerequisites,
            synthetic_build::list_synthetic_build_commits,
            synthetic_build::resolve_synthetic_build_target,
            synthetic_build::job::start_synthetic_build,
            synthetic_build::job::synthetic_build_status,
            synthetic_build::job::synthetic_build_logs,
            synthetic_build::job::cancel_synthetic_build,
            synthetic_build::artifact::list_cached_synthetic_builds,
            synthetic_build::artifact::install_cached_synthetic_build,
            synthetic_build::artifact::delete_cached_synthetic_build,
            synthetic_build::artifact::synthetic_build_identity,
            synthetic_build::artifact::open_synthetic_build_log,
            synthetic_build::artifact::open_synthetic_build_cache,
            synthetic_build::artifact::clean_unused_synthetic_build_cache,
            desktop_worker::list_desktop_workers,
            desktop_worker::list_desktop_worker_candidates,
            desktop_worker::pair_desktop_worker,
            desktop_worker::forget_desktop_worker,
            direct_probe::probe_direct_worker,
            local_logs::open_local_logs_directory,
            local_logs::read_local_service_logs,
            local_server_url,
            relay_client_log,
            set_desktop_app_action_availability,
            set_macos_pro_mode,
            project_share::reveal_local_project_folder,
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
            let local_logs = local_logs::build(app).map_err(std::io::Error::other)?;
            app.manage(local_logs);
            local_logs::start_maintenance(app.handle().clone());
            let runtime = build_runtime(app).map_err(|error| {
                app.state::<local_logs::LocalServiceLogs>().runtime_event(
                    "fatal",
                    "Local runtime startup failed",
                    Some(json!({
                        "event": "desktop.runtime.failed",
                        "operation": "bootstrap-runtime",
                        "reasonCode": "runtime-startup-failed",
                        "status": "failed",
                        "subsystem": "desktop-runtime"
                    })),
                );
                std::io::Error::other(error)
            })?;
            let desktop_workers =
                desktop_worker::build(app, &runtime.server_url).map_err(|error| {
                    app.state::<local_logs::LocalServiceLogs>().runtime_event(
                        "error",
                        "Desktop worker manager startup failed",
                        Some(json!({
                            "event": "desktop.worker-manager.failed",
                            "operation": "bootstrap-worker-manager",
                            "reasonCode": "worker-manager-startup-failed",
                            "status": "failed",
                            "subsystem": "desktop-worker"
                        })),
                    );
                    std::io::Error::other(error)
                })?;
            app.state::<local_logs::LocalServiceLogs>().runtime_event(
                "info",
                "Cantrip desktop runtime initialized",
                Some(json!({
                    "event": "desktop.runtime.ready",
                    "operation": "bootstrap-runtime",
                    "status": "ready",
                    "subsystem": "desktop-runtime"
                })),
            );
            app.manage(runtime);
            app.manage(desktop_workers);
            app.manage(ProjectShareMounts::default());
            app.manage(TunnelForwards::default());
            app.manage(desktop_update::DesktopUpdateCoordinator::default());
            app.manage(
                synthetic_build::SyntheticBuildCoordinator::build(app)
                    .map_err(std::io::Error::other)?,
            );
            #[cfg(desktop)]
            {
                app.manage(DesktopShutdownState::default());
                app.manage(DesktopExitState::default());
                setup_tray(app)?;
                #[cfg(target_os = "macos")]
                setup_macos_application_menu(app)?;
                app.on_menu_event(|app, event| match event.id().as_ref() {
                    "close-cantrip-windows" => close_desktop_windows(app),
                    #[cfg(target_os = "macos")]
                    NEW_AGENT_CHAT_ACTION_ID | NEW_TERMINAL_ACTION_ID => {
                        let _ = app.emit_to("main", APP_ACTION_EVENT, event.id().as_ref());
                    }
                    _ => {}
                });
                if std::env::args().any(|argument| argument == "--background") {
                    if let Some(window) = app.get_webview_window("main") {
                        window.hide()?;
                    }
                }
            }
            #[cfg(desktop)]
            monitor_owned_runtime(app.handle().clone());
            Ok(())
        });
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
            handle
                .state::<local_logs::LocalServiceLogs>()
                .runtime_event(
                    "debug",
                    "macOS requested the main window reopen",
                    Some(json!({
                        "event": "desktop.window.reopen",
                        "operation": "show-window",
                        "subsystem": "desktop-window"
                    })),
                );
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
            } else if label == "synthetic-build-progress"
                && handle
                    .state::<synthetic_build::SyntheticBuildCoordinator>()
                    .build_active()
            {
                api.prevent_close();
                let _ = handle.emit_to(label, "cantrip-synthetic-build-close-requested", ());
            }
        }
        if matches!(event, RunEvent::Exit) {
            handle
                .state::<local_logs::LocalServiceLogs>()
                .runtime_event(
                    "info",
                    "Cantrip desktop runtime is exiting",
                    Some(json!({
                        "event": "desktop.runtime.exit",
                        "operation": "shutdown-runtime",
                        "subsystem": "desktop-runtime"
                    })),
                );
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

    use super::{
        exit_request_needs_confirmation, node_service_command, run_shutdown_once,
        LocalWorkerRuntime, ManagedRuntime,
    };

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
    fn local_worker_runtime_matches_only_its_server_and_worker() {
        let data_directory = std::env::temp_dir().join("cantrip-local-worker");
        let runtime = ManagedRuntime {
            children: Mutex::new(Vec::new()),
            local_worker: Some(LocalWorkerRuntime {
                data_directory: data_directory.clone(),
                worker_id: Some("desktop-local".into()),
            }),
            server_url: "http://127.0.0.1:4310/".into(),
        };

        assert_eq!(
            runtime.local_worker_data_directory("http://127.0.0.1:4310", "desktop-local"),
            Some(data_directory.as_path())
        );
        assert!(runtime
            .local_worker_data_directory("https://cantrip.example", "desktop-local")
            .is_none());
        assert!(runtime
            .local_worker_data_directory("http://127.0.0.1:4310", "remote-worker")
            .is_none());
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
