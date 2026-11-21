use super::{Desired, ProcessExit, Resize, ServiceIo, State, output::Utf8};
use crate::logging::Logs;
use cantrip_wire::{JsString, value::json};
use codex_utils_pty::{ChildFds, spawn_pty_process_strict};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, watch};

pub(super) async fn run(
    id: JsString,
    mut control: watch::Receiver<Desired>,
    state: Arc<Mutex<State>>,
    environment: HashMap<String, String>,
    logs: Arc<Logs>,
    delay: Duration,
    ready: tokio::sync::oneshot::Sender<()>,
) {
    let mut ready = Some(ready);
    loop {
        let desired = control.borrow_and_update().clone();
        if desired.closing {
            state.lock().unwrap().finish(None);
            return;
        }
        let Some(configuration) = desired.configuration else {
            state.lock().unwrap().finish(None);
            if control.changed().await.is_err() {
                return;
            }
            continue;
        };
        let (attempt, generation, size) = {
            let mut state = state.lock().unwrap();
            state.reset();
            state.phase = "starting";
            state.append("\r\n\x1b[90m[Starting terminal service]\x1b[0m\r\n");
            (state.restarts + 1, state.generation, state.size)
        };
        let mut environment = environment.clone();
        environment.insert("TERM".into(), "xterm-256color".into());
        environment.insert("COLORTERM".into(), "truecolor".into());
        environment.insert("CANTRIP_TERMINAL_ID".into(), id.lossy().into_owned());
        let (program, args) = launch(&configuration.command, &environment);
        let started = std::time::Instant::now();
        logs.event("info","Terminal process starting",json!({"event":"terminal.process.starting","subsystem":"terminal","operation":"spawn","status":"started","terminalId":id,"launchType":"command","service":true,"attempt":attempt,"processGeneration":generation}));
        let spawned = spawn_pty_process_strict(
            &program,
            &args,
            &configuration.cwd,
            &environment,
            &None,
            size,
            ChildFds::Attached(&[]),
        )
        .await;
        if let Some(ready) = ready.take() {
            let _ = ready.send(());
        }
        let exited = match spawned {
            Err(_) => {
                state
                    .lock()
                    .unwrap()
                    .append("\r\n\x1b[31m[Service failed to start]\x1b[0m\r\n");
                logs.repeated(format!("terminal-service-start-failed:{}",id.lossy()),"warn","Terminal service failed to start; retry scheduled",json!({"event":"terminal.service.start-failed","subsystem":"terminal","operation":"start-service","reasonCode":"spawn-failed","status":"retrying","terminalId":id,"attempt":attempt,"reconnectDelayMs":delay.as_millis() as u64}));
                None
            }
            Ok(mut process) => {
                let (resize, mut sizes) = mpsc::channel::<Resize>(64);
                {
                    let mut state = state.lock().unwrap();
                    if state.size != size {
                        let _ = process.session.resize(state.size);
                    }
                    state.phase = "running";
                    state.io = Some(ServiceIo {
                        writer: process.session.writer_sender(),
                        resize,
                    });
                }
                logs.event("info","Terminal process started",json!({"event":"terminal.process.started","subsystem":"terminal","operation":"spawn","status":"running","terminalId":id,"launchType":"command","service":true,"durationMs":started.elapsed().as_millis() as u64,"processGeneration":generation}));
                let mut utf8 = Utf8::default();
                let mut exit = None;
                let mut out_open = true;
                let mut stopping = None;
                loop {
                    if exit.is_some() && !out_open {
                        break;
                    }
                    tokio::select! {
                        biased;
                        _=control.changed(),if stopping.is_none()=>{
                            state.lock().unwrap().io = None;
                            if process.session.hangup().is_err(){process.session.request_terminate();}
                            stopping=Some(tokio::time::Instant::now()+Duration::from_secs(1));
                        },
                        _=async{match stopping{Some(deadline)=>tokio::time::sleep_until(deadline).await,None=>std::future::pending::<()>().await}}=>break,
                        result=&mut process.exit_rx,if exit.is_none()=>{
                            state.lock().unwrap().io = None;
                            exit=Some(result.unwrap_or(-1));
                        },
                        Some(request)=sizes.recv(),if stopping.is_none() && exit.is_none()=>{
                            let result=process.session.resize(request.size);
                            if result.is_ok(){ state.lock().unwrap().resize(request.size); }
                            let _=request.complete.send(result);
                        },
                        bytes=process.stdout_rx.recv(),if out_open=>match bytes {Some(bytes)=>append(&state,&utf8.push(&bytes)),None=>out_open=false},
                    }
                }
                state.lock().unwrap().io = None;
                // Drain already accepted output before retirement, then drop
                // receivers so bounded native helper sends cannot block joining.
                while let Ok(bytes) = process.stdout_rx.try_recv() {
                    append(&state, &utf8.push(&bytes));
                }
                append(&state, &utf8.finish());
                drop(process.stdout_rx);
                drop(process.stderr_rx);
                process.session.terminate_and_wait().await;
                ProcessExit::observed(&process.session, exit)
            }
        };
        let next = control.borrow().clone();
        if next.closing {
            state.lock().unwrap().finish(exited);
            return;
        }
        if next.configuration.is_none() {
            state.lock().unwrap().finish(exited);
            continue;
        }
        let immediate =
            next.configuration.as_ref() != Some(&configuration) || next.restart != desired.restart;
        let restart_delay = if immediate { Duration::ZERO } else { delay };
        {
            let mut state = state.lock().unwrap();
            state.phase = "restarting";
            state.exit = exited;
            if let Some(exit) = exited {
                let code = exit.code;
                state.restarts += 1;
                logs.event(if code==0 {"info"} else {"warn"},"Terminal service process exited; restart scheduled",json!({"event":"terminal.service.restart-scheduled","subsystem":"terminal","operation":"restart-service","reasonCode":if code==0 {"process-exited"}else{"process-failed"},"status":"retrying","terminalId":id,"exitCode":code,"signal":exit.signal,"durationMs":started.elapsed().as_millis() as u64,"reconnectDelayMs":restart_delay.as_millis() as u64,"attempt":state.restarts}));
                let timing = if immediate {
                    "now".to_owned()
                } else {
                    format!("in {} seconds", delay.as_secs_f64().ceil())
                };
                state.append(&format!(
                    "\r\n\x1b[90m[Service exited {code}; restarting {timing}]\x1b[0m\r\n"
                ));
            }
        }
        if immediate {
            continue;
        }
        tokio::select! {_=control.changed()=>{},_=tokio::time::sleep(delay)=>{}}
    }
}
fn append(state: &Mutex<State>, text: &str) {
    if !text.is_empty() {
        state.lock().unwrap().append(text);
    }
}
fn launch(command: &JsString, environment: &HashMap<String, String>) -> (String, Vec<String>) {
    let shell = shell(environment);
    #[cfg(windows)]
    {
        let name = shell.rsplit(['\\', '/']).next().unwrap_or("");
        let args = if name.eq_ignore_ascii_case("cmd") || name.eq_ignore_ascii_case("cmd.exe") {
            vec!["/d", "/s", "/c"]
        } else {
            vec!["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]
        };
        let mut args: Vec<String> = args.into_iter().map(String::from).collect();
        args.push(command.lossy().into_owned());
        (shell, args)
    }
    #[cfg(not(windows))]
    {
        (shell, vec!["-lc".into(), command.lossy().into_owned()])
    }
}

pub(super) fn shell(environment: &HashMap<String, String>) -> String {
    #[cfg(windows)]
    {
        environment
            .get("COMSPEC")
            .filter(|s| !s.is_empty())
            .cloned()
            .unwrap_or_else(|| "powershell.exe".into())
    }
    #[cfg(not(windows))]
    {
        environment
            .get("SHELL")
            .filter(|s| !s.is_empty())
            .cloned()
            .unwrap_or_else(|| {
                if cfg!(target_os = "macos") {
                    "/bin/zsh".into()
                } else {
                    "/bin/bash".into()
                }
            })
    }
}
