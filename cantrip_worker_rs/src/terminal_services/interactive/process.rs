use super::{Display, Entry, Resize};
use crate::logging::Logs;
use anyhow::Result;
use cantrip_wire::{JsString, Value, value::json};
use codex_utils_pty::{ChildFds, TerminalSize, spawn_pty_process_strict};
use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, watch};

pub(super) async fn spawn(
    cwd: PathBuf,
    terminal: JsString,
    size: TerminalSize,
    mut environment: HashMap<String, String>,
    logs: Arc<Logs>,
    exited: impl FnOnce(&Value) + Send + 'static,
) -> Result<(Entry, impl Future<Output = ()> + Send + 'static)> {
    environment.insert("TERM".into(), "xterm-256color".into());
    environment.insert("COLORTERM".into(), "truecolor".into());
    environment.insert("CANTRIP_TERMINAL_ID".into(), terminal.lossy().into_owned());
    let program = super::super::service::shell(&environment);
    let mut child = spawn_pty_process_strict(
        &program,
        &[],
        &cwd,
        &environment,
        &None,
        size,
        ChildFds::Attached(&[]),
    )
    .await?;
    let (stop, mut stopping) = watch::channel(false);
    let (finished, done) = watch::channel(false);
    let (resize, mut sizes) = mpsc::channel::<Resize>(64);
    let state = Arc::new(Mutex::new(Display::new(size)));
    let entry = Entry {
        location: super::Location::Host(cwd),
        stop,
        done,
        writer: child.session.writer_sender(),
        resize,
        state: state.clone(),
    };
    let actor = async move {
        logs.event(
            "info",
            "Terminal process started",
            json!({"event":"terminal.process.started",
            "subsystem":"terminal","launchType":"shell","terminalId":terminal,"status":"running"}),
        );
        let mut text = super::super::output::Utf8::default();
        let mut output = true;
        let mut exit = None;
        let mut shutdown = None;
        loop {
            if exit.is_some() && !output {
                break;
            }
            tokio::select! {
                biased;
                _ = stopping.changed(), if shutdown.is_none() => {
                    if child.session.hangup().is_err() {
                        child.session.request_terminate();
                    }
                    shutdown = Some(tokio::time::Instant::now() + Duration::from_secs(1));
                }
                _ = async {
                    match shutdown {
                        Some(deadline) => tokio::time::sleep_until(deadline).await,
                        None => std::future::pending::<()>().await,
                    }
                } => break,
                result = &mut child.exit_rx, if exit.is_none() => {
                    exit = Some(result.unwrap_or(-1));
                }
                bytes = child.stdout_rx.recv(), if output => {
                    if let Some(bytes) = bytes {
                        state.lock().unwrap().write(&text.push(&bytes));
                    } else {
                        output = false;
                    }
                }
                Some(request) = sizes.recv(), if shutdown.is_none() && exit.is_none() => {
                    let result = child.session.resize(request.size);
                    if result.is_ok() {
                        state.lock().unwrap().replay.resize(request.size);
                    }
                    let _ = request.complete.send(result);
                }
            }
        }
        while let Ok(bytes) = child.stdout_rx.try_recv() {
            state.lock().unwrap().write(&text.push(&bytes));
        }
        state.lock().unwrap().write(&text.finish());
        drop(child.stdout_rx);
        drop(child.stderr_rx);
        child.session.terminate_and_wait().await;
        let code = exit.or_else(|| child.session.exit_code()).unwrap_or(-1);
        let result = json!({"status":"exited","exitCode":code,"signal":Value::Null});
        state.lock().unwrap().finish(result.clone());
        exited(&result);
        finished.send_replace(true);
        logs.event("info","Terminal process exited",json!({"event":"terminal.process.exited",
            "subsystem":"terminal","launchType":"shell","terminalId":terminal,"exitCode":code,"status":"exited"}));
    };
    Ok((entry, actor))
}
