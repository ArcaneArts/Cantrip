use super::{Display, Entry, Location, Resize};
use crate::{codex::turn::console, logging::Logs, terminal_services::ProcessExit};
use anyhow::{Context, Result};
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

pub(super) enum Local {
    Shell(PathBuf, HashMap<String, String>),
    Console(Box<console::Launch>),
}

pub(super) async fn spawn(
    launch: Local,
    location: Location,
    terminal: JsString,
    size: TerminalSize,
    logs: Arc<Logs>,
    exited: impl FnOnce(&Value) + Send + 'static,
) -> Result<(Entry, impl Future<Output = ()> + Send + 'static)> {
    let (kind, program, args, cwd, mut environment, gateway) = match launch {
        Local::Shell(cwd, environment) => {
            let program = PathBuf::from(super::super::service::shell(&environment));
            ("shell", program, Vec::new(), cwd, environment, None)
        }
        Local::Console(console) => {
            let console::Launch {
                program,
                args,
                cwd,
                environment,
                gateway,
            } = *console;
            ("codex", program, args, cwd, environment, Some(gateway))
        }
    };
    environment.insert("TERM".into(), "xterm-256color".into());
    environment.insert("COLORTERM".into(), "truecolor".into());
    environment.insert("CANTRIP_TERMINAL_ID".into(), terminal.lossy().into_owned());
    let mut child = spawn_pty_process_strict(
        program
            .to_str()
            .context("Terminal executable path must be Unicode.")?,
        &args,
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
    let mut display = Display::new(size, 1);
    display.bind_resize(&resize);
    let state = Arc::new(Mutex::new(display));
    let entry = Entry {
        location,
        stop,
        done,
        writer: child.session.writer_sender(),
        resize,
        state: state.clone(),
        managed_generation: Default::default(),
    };
    let actor = async move {
        logs.event(
            "info",
            "Terminal process started",
            json!({"event":"terminal.process.started",
            "subsystem":"terminal","launchType":kind,"terminalId":terminal,"status":"running"}),
        );
        let mut text = super::super::output::Utf8::default();
        let mut output = true;
        let mut exit = None;
        let mut shutdown = None;
        let mut gateway_stopped = gateway.as_ref().map(console::Gateway::stopped);
        loop {
            if exit.is_some() && !output {
                break;
            }
            tokio::select! {
                biased;
                _ = async {
                    tokio::select! {
                        _ = stopping.changed() => {},
                        _ = async {
                            if let Some(stopped) = &mut gateway_stopped {
                                let _ = stopped.wait_for(|stopped| *stopped).await;
                            } else {
                                std::future::pending::<()>().await;
                            }
                        } => {},
                    }
                }, if shutdown.is_none() => {
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
                Some(request) = sizes.recv(), if shutdown.is_none() && exit.is_none() => {
                    request.apply(
                        &state,
                        &mut child.session,
                        |size| state.lock().unwrap().replay.resize(size),
                    ).await;
                }
                bytes = child.stdout_rx.recv(), if output => {
                    if let Some(bytes) = bytes {
                        state.lock().unwrap().write(&text.push(&bytes));
                    } else {
                        output = false;
                    }
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
        if let Some(gateway) = gateway {
            gateway.close().await;
        }
        let status = ProcessExit::observed(&child.session, exit).unwrap_or(ProcessExit {
            code: -1,
            signal: None,
        });
        let result = status.result();
        state.lock().unwrap().finish(result.clone());
        exited(&result);
        finished.send_replace(true);
        logs.event("info","Terminal process exited",json!({"event":"terminal.process.exited",
            "subsystem":"terminal","launchType":kind,"terminalId":terminal,"exitCode":status.code,"signal":status.signal,"status":"exited"}));
    };
    Ok((entry, actor))
}
