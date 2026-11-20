use anyhow::{Result, bail};
use std::path::PathBuf;
fn main() -> Result<()> {
    if cantrip_worker::git::editor::run(std::env::args_os())? {
        return Ok(());
    }
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("mcp")) {
        return cantrip_worker::mcp::run(std::env::args_os().skip(2));
    }
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("codegraph-mcp")) {
        return cantrip_worker::launch_codegraph_mcp(std::env::args_os().skip(2));
    }
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("chromium-probe")) {
        return cantrip_worker::browser_probe::run(std::env::args_os().skip(2));
    }
    #[cfg(target_os = "linux")]
    codex_utils_pty::init_spawn_helper(std::env::args_os());
    let mut stdin = false;
    let mut env_file = PathBuf::from(".env");
    for argument in std::env::args().skip(1) {
        match argument.as_str() {
            "--version" => {
                println!("{}", cantrip_worker::version::value().stringify());
                return Ok(());
            }
            "--shutdown-on-stdin-close" => stdin = true,
            "--help" => {
                println!(
                    "cantrip-worker [--shutdown-on-stdin-close] [--env-file-if-exists=<path>] [--version]\ncantrip-worker mcp --connection <path>\ncantrip-worker chromium-probe <executable>\nNative worker conversion in progress; see docs/RUST_WORKER_PORT.md for implemented capabilities."
                );
                return Ok(());
            }
            _ => {
                if let Some(path) = argument.strip_prefix("--env-file-if-exists=") {
                    env_file = path.into();
                } else {
                    bail!("Unknown worker argument. Use --help for supported options.");
                }
            }
        }
    }
    // SAFETY: this synchronous entry has not created runtime/archive threads.
    unsafe {
        cantrip_config::env_file::load_if_exists(&env_file)?;
    }
    let _ = cantrip_wire::environment::timezone();
    let _ = cantrip_wire::environment::locale();
    let environment = std::env::vars_os()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .map(|(key, value)| {
            (
                if cfg!(windows) {
                    key.to_uppercase()
                } else {
                    key
                },
                value,
            )
        })
        .collect();
    let cwd = std::env::current_dir()?;
    let executable = std::env::current_exe()?;
    let parent = executable.parent().expect("worker executable directory");
    let root = if parent.file_name().is_some_and(|v| v == "bin") {
        parent.parent().unwrap_or(parent).to_path_buf()
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    };
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .build()?
        .block_on(cantrip_worker::runtime::serve(
            environment,
            &cwd,
            &root,
            stdin,
        ))
}
