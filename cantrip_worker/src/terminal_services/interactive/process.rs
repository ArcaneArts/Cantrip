use super::{Display, Entry, Location, Resize};
use crate::claude_code::{Installation as ClaudeInstallation, ProfileLease, SignIn};
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
    ClaudeLogin(ClaudeInstallation, ProfileLease),
}

pub(super) async fn spawn(
    launch: Local,
    location: Location,
    terminal: JsString,
    size: TerminalSize,
    logs: Arc<Logs>,
    exited: impl FnOnce(&Value) + Send + 'static,
) -> Result<(Entry, impl Future<Output = ()> + Send + 'static)> {
    let mut claude = None;
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
        Local::ClaudeLogin(installation, profile) => {
            let command = installation.account_command(profile.profile)?;
            let command = command.as_std();
            let environment = command
                .get_envs()
                .filter_map(|(name, value)| {
                    Some((name.to_str()?.to_owned(), value?.to_str()?.to_owned()))
                })
                .collect();
            let cwd = command
                .get_current_dir()
                .context("Managed Claude Code profile directory")?;
            claude = Some((installation, profile));
            (
                "claude-login",
                command.get_program().into(),
                vec!["auth".into(), "login".into()],
                cwd.to_owned(),
                environment,
                None,
            )
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
        let mut status = ProcessExit::observed(&child.session, exit).unwrap_or(ProcessExit {
            code: -1,
            signal: None,
        });
        if let Some((installation, profile)) = claude
            && status.code == 0
            && !installation
                .sign_in_status(profile.profile)
                .await
                .is_ok_and(|status| status == SignIn::Subscription)
        {
            status.code = 1;
        }
        let result = status.result();
        state.lock().unwrap().finish(result.clone());
        exited(&result);
        finished.send_replace(true);
        logs.event("info","Terminal process exited",json!({"event":"terminal.process.exited",
            "subsystem":"terminal","launchType":kind,"terminalId":terminal,"exitCode":status.code,"signal":status.signal,"status":"exited"}));
    };
    Ok((entry, actor))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::claude_code::{Manager, Profile, tests::install_fixture};
    use cantrip_config::Environment;

    #[tokio::test]
    async fn managed_claude_login_confirms_only_this_profile_and_is_cancellable() -> Result<()> {
        let root = tempfile::tempdir()?;
        let manager = Manager::new(root.path());
        install_fixture(
            &manager,
            r#"#!/bin/sh
case "$1 $2" in
  'auth login')
    printf 'Open https://claude.ai/fixture and enter code: '
    read -r code
    case "$code" in
      valid) touch "$CLAUDE_CONFIG_DIR/fixture-session" ;;
      false-success) exit 0 ;;
      *) exit 2 ;;
    esac ;;
  'auth status')
    if [ -f "$CLAUDE_CONFIG_DIR/fixture-session" ]; then
      echo '{"loggedIn":true,"authMethod":"claude.ai"}'
    else
      echo '{"loggedIn":false}'
      exit 1
    fi ;;
  *) exit 2 ;;
esac
"#,
        )?;
        let environment = Environment::from([("CANTRIP_LOG_LEVEL".into(), "off".into())]);
        let logs = Arc::new(Logs::initialize(root.path(), &environment, root.path()).await);
        let account_a = uuid::Uuid::new_v4();
        let profile_a = Profile::bound(&"owner".into(), &"server".into(), account_a);
        let profile_b = Profile::bound(&"owner".into(), &"server".into(), uuid::Uuid::new_v4());
        for (profile, input, expected) in [
            (profile_a, Some("valid\n"), 0),
            (profile_b, Some("false-success\n"), 1),
            (profile_b, Some("invalid\n"), 2),
            (profile_b, None, -1),
            (profile_b, Some("valid\n"), 0),
        ] {
            let (send, receive) = tokio::sync::oneshot::channel();
            let lease = manager.begin_sign_in(profile)?;
            assert!(manager.begin_sign_in(profile).is_err());
            let (entry, actor) = spawn(
                Local::ClaudeLogin(manager.installation().await?, lease),
                Location::ClaudeLogin(profile),
                "claude-login:fixture".into(),
                TerminalSize { rows: 24, cols: 80 },
                logs.clone(),
                move |value| {
                    let _ = send.send(value.clone());
                },
            )
            .await?;
            let actor = tokio::spawn(actor);
            if let Some(input) = input {
                entry.writer.send(input.as_bytes().to_vec()).await?;
            } else {
                entry.stop.send_replace(true);
            }
            let result = tokio::time::timeout(Duration::from_secs(10), receive).await??;
            tokio::time::timeout(Duration::from_secs(10), actor).await??;
            if input.is_some() {
                assert_eq!(result["exitCode"].as_i64(), Some(expected));
            } else {
                assert_ne!(result["exitCode"].as_i64(), Some(0));
            }
            if profile == profile_a {
                assert_eq!(manager.sign_in_status(profile_b).await?, SignIn::SignedOut);
            }
        }
        let restarted = Manager::new(root.path());
        assert_eq!(
            restarted.sign_in_status(profile_a).await?,
            SignIn::Subscription
        );
        assert_eq!(
            restarted.sign_in_status(profile_b).await?,
            SignIn::Subscription
        );
        logs.close().await;
        Ok(())
    }
}
