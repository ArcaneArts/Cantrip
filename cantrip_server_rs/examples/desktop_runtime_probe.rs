//! Local artifact acceptance using the desktop's production launch/supervision
//! code, without substituting a Node launcher or requiring a renderer session.
#[path = "../../cantrip_app/src-tauri/src/desktop_services.rs"]
mod desktop_services;
#[path = "../../cantrip_app/src-tauri/src/process_environment.rs"]
mod process_environment;

use anyhow::{Context, Result};
use desktop_services::*;
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Read},
    net::TcpListener,
    path::PathBuf,
    process::Child,
};

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        terminate_child(&mut self.0);
    }
}
fn capture(child: &mut Child) {
    fn reader(stream: impl Read + Send + 'static) {
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                eprintln!("{line}");
            }
        });
    }
    if let Some(stdout) = child.stdout.take() {
        reader(stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        reader(stderr);
    }
}
fn main() -> Result<()> {
    let mut arguments = std::env::args_os().skip(1);
    let resources = PathBuf::from(arguments.next().context("runtime directory")?);
    let data = PathBuf::from(
        arguments
            .next()
            .context("disposable desktop data directory")?,
    );
    let without_worker = arguments
        .next()
        .is_some_and(|arg| arg == "--without-worker");
    let logs = data.join("logs");
    std::fs::create_dir_all(&logs)?;
    let node = resources.join(if cfg!(windows) { "node.exe" } else { "node" });
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    let token = format!("desktop-probe-{}", std::process::id());
    let launch = server_command(&node, &resources.join("server")).map_err(anyhow::Error::msg)?;
    if let Some(command) = launch.preparation {
        let mut child = OwnedChild(
            spawn_service(
                command,
                &server_environment(&data, &logs, port, &token),
                true,
                true,
            )
            .map_err(anyhow::Error::msg)?,
        );
        capture(&mut child.0);
        wait_for_preparation(&mut child.0, || false).map_err(anyhow::Error::msg)?;
    }
    let native = launch.native;
    let mut server = OwnedChild(
        spawn_service(
            launch.command,
            &server_environment(&data, &logs, port, &token),
            true,
            true,
        )
        .map_err(anyhow::Error::msg)?,
    );
    capture(&mut server.0);
    wait_for_server(&mut server.0, port, || false).map_err(anyhow::Error::msg)?;
    let origin = format!("http://127.0.0.1:{port}");
    let mut worker = if without_worker {
        None
    } else {
        let mut child = OwnedChild(
            spawn_service(
                node_service_command(&node, &resources.join("worker")),
                &worker_environment(&data, &logs, &origin, &token),
                true,
                true,
            )
            .map_err(anyhow::Error::msg)?,
        );
        capture(&mut child.0);
        Some(child)
    };
    println!(
        "{}",
        json!({"event":"server.listening", "origin":origin,
        "serverPid":server.0.id(), "workerPid":worker.as_ref().map(|w|w.0.id()), "native":native})
    );
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input)?;
    if let Some(worker) = worker.as_mut() {
        terminate_child(&mut worker.0);
    }
    terminate_server(&mut server.0);
    let status = server.0.wait()?;
    println!(
        "{}",
        json!({"event":"desktop.server.stopped", "exitCode":status.code()})
    );
    anyhow::ensure!(
        status.success(),
        "desktop server did not shut down cleanly: {status}"
    );
    Ok(())
}
