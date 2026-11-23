//! Owned managed app-server process, endpoint announcement and exit evidence.
mod monitor;
use super::{provider_errors::Policy, rpc_requests::Record};
use crate::logging::Logs;
use anyhow::{Result, anyhow};
use cantrip_wire::JsString;
use codex_utils_pty::{ProcessHandle, ProcessSignal};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{oneshot, watch},
    task::JoinHandle,
};

#[derive(Clone)]
pub struct Options {
    pub cwd: PathBuf,
    pub environment: HashMap<String, String>,
    pub runtime_id: Option<String>,
    pub policy: Policy,
    pub logs: Option<Arc<Logs>>,
    pub record: Record,
    pub startup_timeout: Duration,
}
impl Options {
    pub fn local(cwd: PathBuf, environment: HashMap<String, String>) -> Self {
        Self {
            cwd,
            environment,
            runtime_id: None,
            policy: Policy::default(),
            logs: None,
            record: Arc::new(|_, _| {}),
            startup_timeout: Duration::from_secs(120),
        }
    }
}
pub struct Process {
    session: Arc<Mutex<Option<ProcessHandle>>>,
    confirmed: bool,
    stopping: Arc<AtomicBool>,
    endpoint: Option<oneshot::Receiver<Result<JsString>>>,
    monitor: Option<JoinHandle<()>>,
    pub exit: watch::Receiver<Option<Exit>>,
}
#[derive(Clone, Copy)]
pub struct Exit {
    pub code: i32,
    pub confirmed: bool,
}

#[derive(Debug)]
pub(super) struct RetirementError(pub anyhow::Error);

impl std::fmt::Display for RetirementError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for RetirementError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.0.as_ref())
    }
}

pub(super) fn retirement_failed(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.is::<RetirementError>())
}

impl Process {
    pub async fn launch(binary: &Path, arguments: &[String], options: &Options) -> Result<Self> {
        let child = codex_utils_pty::spawn_pipe_process(
            binary,
            arguments,
            &options.cwd,
            &options.environment,
            &None,
            &[],
        )
        .await?;
        let (send, endpoint) = oneshot::channel();
        let (exited, exit) = watch::channel(None);
        let session = Arc::new(Mutex::new(Some(child.session)));
        let weak = Arc::downgrade(&session);
        let stopping = Arc::new(AtomicBool::new(false));
        let stop = stopping.clone();
        let observed: Arc<dyn Fn() -> Option<i32> + Send + Sync> = Arc::new(move || {
            weak.upgrade()?
                .lock()
                .ok()?
                .as_ref()?
                .native_exit_status()
                .map(|status| {
                    status
                        .code()
                        .unwrap_or_else(|| if stop.load(Ordering::Acquire) { 0 } else { 1 })
                })
        });
        let task = tokio::spawn(monitor::run(
            child.stdout_rx,
            child.stderr_rx,
            child.exit_rx,
            send,
            exited,
            options.clone(),
            observed,
        ));
        Ok(Self {
            session,
            confirmed: false,
            stopping,
            endpoint: Some(endpoint),
            monitor: Some(task),
            exit,
        })
    }
    pub async fn endpoint(&mut self, timeout: Duration) -> Result<JsString> {
        tokio::time::timeout(
            timeout,
            self.endpoint.take().expect("endpoint observed once"),
        )
        .await
        .map_err(|_| anyhow!("Codex app-server did not announce an endpoint within 120 seconds."))?
        .map_err(|_| anyhow!("Codex app-server exited before listening."))?
    }
    pub fn has_exited(&self) -> bool {
        self.session
            .lock()
            .unwrap()
            .as_ref()
            .is_none_or(ProcessHandle::has_exited)
    }
    pub fn interrupt(&self) {
        if let Some(session) = self.session.lock().unwrap().as_ref()
            && !session.has_exited()
        {
            self.stopping.store(true, Ordering::Release);
            let _ = session.signal(ProcessSignal::Interrupt);
        }
    }
    /// A real reaped child, not a closed socket or an attempted signal.
    pub fn exit_confirmed(&self) -> bool {
        self.confirmed
            || self
                .session
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|s| s.native_exit_status().is_some())
    }
    pub async fn close(&mut self) -> Result<()> {
        if !self.has_exited() {
            self.interrupt();
            if tokio::time::timeout(Duration::from_secs(2), async {
                while self.exit.borrow().is_none() {
                    if self.exit.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await
            .is_err()
                && let Some(session) = self.session.lock().unwrap().as_ref()
            {
                session.request_terminate();
            }
        }
        // Keep the observed handle available until the monitor publishes the
        // reaped status, including when exit races explicit close.
        while self.exit.borrow().is_none() {
            if self.exit.changed().await.is_err() {
                break;
            }
        }
        let session = self.session.lock().unwrap().take();
        if let Some(mut session) = session {
            session.terminate_and_wait().await;
            self.confirmed = session.native_exit_status().is_some();
        }
        if let Some(mut task) = self.monitor.take()
            && tokio::time::timeout(Duration::from_secs(2), &mut task)
                .await
                .is_err()
        {
            task.abort();
            let _ = task.await;
        }
        if !self.confirmed {
            return Err(RetirementError(anyhow!(
                "Could not confirm Codex app-server process exit."
            ))
            .into());
        }
        Ok(())
    }
}
