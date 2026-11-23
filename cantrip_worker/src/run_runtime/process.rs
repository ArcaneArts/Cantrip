use super::{Control, Environment, Failure, shell::Command};
use crate::terminal_services::output::Utf8;
use codex_utils_pty::{ChildFds, TerminalSize, spawn_pty_process_strict};
use std::sync::atomic::Ordering;
use tokio::time::{Duration, Instant, sleep_until};

#[derive(Default)]
pub(super) struct Exit {
    pub code: Option<i32>,
    pub signal: Option<String>,
}

pub(super) async fn run(
    command: &Command,
    environment: &Environment,
    control: &Control,
    grace: Duration,
    timeout: Option<Duration>,
    mut output: impl FnMut(&str),
    started: impl FnOnce(),
) -> Result<Option<Exit>, Failure> {
    if *control.stop.borrow() {
        return Ok(None);
    }
    let mut child = spawn_pty_process_strict(
        &command.program,
        &command.arguments,
        &command.cwd,
        environment,
        &None,
        TerminalSize {
            rows: 40,
            cols: 120,
        },
        ChildFds::Attached(&[]),
    )
    .await
    .map_err(|_| Failure::new("spawn", "launch-failed", "The Run could not start.", true))?;
    started();
    let mut decoder = Utf8::default();
    let mut stop = control.stop.clone();
    let mut exited = None;
    let mut output_open = true;
    let mut drain_until = None;
    let mut force_at = None;
    let timeout_at = timeout.map(|duration| Instant::now() + duration);
    let mut due_to_timeout = false;

    let interrupt = |force: bool, child: &codex_utils_pty::ProcessHandle| {
        if child.has_exited() {
            None
        } else if force || child.terminate_gracefully().is_err() {
            force_live(child);
            None
        } else {
            Some(Instant::now() + grace)
        }
    };
    if *stop.borrow_and_update() {
        force_at = interrupt(control.force.load(Ordering::Acquire), &child.session);
    }
    while exited.is_none() || output_open {
        tokio::select! {
            biased;
            _ = stop.changed(), if exited.is_none() => {
                force_at = interrupt(control.force.load(Ordering::Acquire), &child.session);
            }
            _ = deadline(force_at), if exited.is_none() => {
                force_live(&child.session);
                force_at = None;
            }
            _ = deadline(timeout_at), if exited.is_none() && !due_to_timeout => {
                force_live(&child.session);
                due_to_timeout = true;
            }
            result = &mut child.exit_rx, if exited.is_none() => {
                exited = Some(result.ok());
                drain_until = Some(Instant::now() + Duration::from_millis(500));
            }
            _ = deadline(drain_until), if output_open => break,
            bytes = child.stdout_rx.recv(), if output_open => match bytes {
                Some(bytes) => output(&decoder.push(&bytes)),
                None => output_open = false,
            },
        }
    }
    while let Ok(bytes) = child.stdout_rx.try_recv() {
        output(&decoder.push(&bytes));
    }
    output(&decoder.finish());
    drop(child.stdout_rx);
    drop(child.stderr_rx);
    child.session.terminate_and_wait().await;
    if due_to_timeout {
        return Err(Failure::new(
            "environment",
            "codex-environment-setup-timeout",
            "The Codex environment setup exceeded its bounded execution time.",
            true,
        ));
    }
    let code = exited.flatten().or_else(|| child.session.exit_code());
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = child
            .session
            .native_exit_status()
            .and_then(|status| status.signal())
        {
            return Ok(Some(Exit {
                code: Some(0),
                signal: Some(signal.to_string()),
            }));
        }
    }
    Ok(Some(Exit { code, signal: None }))
}

fn force_live(child: &codex_utils_pty::ProcessHandle) {
    if !child.has_exited() {
        child.request_terminate();
    }
}

async fn deadline(at: Option<Instant>) {
    if let Some(at) = at {
        sleep_until(at).await;
    } else {
        std::future::pending::<()>().await;
    }
}

/// The Linux preparation helper inherits the executor's process ownership.
/// Its setup command uses ordinary pipes, preserving preparation output
/// without terminal echo or translated line endings.
#[cfg(all(feature = "guest-run-definitions", target_os = "linux"))]
pub(super) async fn guest_setup(
    command: &Command,
    environment: &Environment,
    output: &mut String,
) -> Result<Exit, Failure> {
    use std::{os::unix::process::ExitStatusExt, process::Stdio};
    use tokio::{io::AsyncReadExt, process::Command as Process};
    let failure = |message| Failure::new("environment", "linux-preparation-failed", message, true);
    let mut child = Process::new(&command.program)
        .args(&command.arguments)
        .current_dir(&command.cwd)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| failure("The Linux environment setup could not start."))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let result = tokio::time::timeout(Duration::from_secs(120), async {
        let mut out_buffer = [0; 8192];
        let mut err_buffer = [0; 8192];
        let mut open = [true; 2];
        let mut decoders = [Utf8::default(), Utf8::default()];
        let mut bytes = 0;
        while open.iter().any(|open| *open) {
            let (stream, count) = tokio::select! {
                count = stdout.read(&mut out_buffer), if open[0] => (0, count),
                count = stderr.read(&mut err_buffer), if open[1] => (1, count),
            };
            let count =
                count.map_err(|_| failure("Linux environment output could not be read."))?;
            bytes += count;
            if bytes > 1024 * 1024 {
                return Err(failure("Linux environment preparation exceeded its bound."));
            }
            if count == 0 {
                open[stream] = false;
                output.push_str(&decoders[stream].finish());
            } else {
                let buffer = if stream == 0 {
                    &out_buffer
                } else {
                    &err_buffer
                };
                output.push_str(&decoders[stream].push(&buffer[..count]));
            }
        }
        let status = child
            .wait()
            .await
            .map_err(|_| failure("The Linux environment setup exit could not be read."))?;
        Ok(Exit {
            code: Some(status.code().unwrap_or(1)),
            signal: status.signal().map(|signal| signal.to_string()),
        })
    })
    .await;
    let result = result
        .unwrap_or_else(|_| Err(failure("Linux environment preparation exceeded its bound.")));
    if result.is_err() && child.id().is_some() {
        let _ = cantrip_host::process::signal_owned(
            &child,
            libc::SIGKILL,
            true,
            "Owned Linux environment setup",
        );
        let _ = child.wait().await;
    }
    result
}
