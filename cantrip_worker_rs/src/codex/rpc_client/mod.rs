//! The stdio probe/auth/import client, distinct from execution RPC settlement.
mod actor;
use anyhow::{Result, anyhow};
use cantrip_history::projection::Work;
use cantrip_wire::{JsString, Value, value::json};
use codex_utils_pty::{ProcessHandle, ProcessSignal};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
};
pub type Predicate = Arc<dyn Fn(&Value) -> bool + Send + Sync>;
pub(super) type Observe = Arc<dyn Fn(&Value) + Send + Sync>;
type Reply = std::result::Result<Value, JsString>;
enum Operation {
    Request {
        id: u64,
        method: JsString,
        params: Option<Value>,
        send: oneshot::Sender<Reply>,
    },
    Notify(Value),
    Wait {
        id: u64,
        method: JsString,
        predicate: Predicate,
        timeout: Duration,
        send: oneshot::Sender<Reply>,
    },
    Expired {
        id: u64,
        notification: bool,
    },
    Close,
}
struct Inner {
    operations: mpsc::UnboundedSender<Operation>,
    next: AtomicU64,
    next_wait: AtomicU64,
    closed: Arc<AtomicBool>,
    session: Arc<Mutex<Option<ProcessHandle>>>,
    io: Mutex<Option<JoinHandle<()>>>,
    close_guard: tokio::sync::Mutex<()>,
    confirm_exit: bool,
    exit_unconfirmed: AtomicBool,
    timeout: Duration,
}
#[derive(Clone)]
pub struct Client(Arc<Inner>);
fn response(receive: oneshot::Receiver<Reply>) -> Work<Value> {
    cantrip_transport::lifecycle::owned(async move {
        receive
            .await
            .map_err(|_| anyhow!("Codex app-server client closed."))?
            .map_err(|message| crate::error::WireError(message).into())
    })
}
impl Client {
    pub async fn spawn(
        binary: &Path,
        home: &Path,
        cwd: &Path,
        environment: &HashMap<String, String>,
        timeout: Duration,
    ) -> Result<Self> {
        Self::spawn_inner(binary, home, cwd, environment, timeout, None).await
    }

    pub(super) async fn spawn_auth(
        binary: &Path,
        home: &Path,
        cwd: &Path,
        environment: &HashMap<String, String>,
        observe: Observe,
    ) -> Result<Self> {
        Self::spawn_inner(
            binary,
            home,
            cwd,
            environment,
            Duration::from_secs(30),
            Some(observe),
        )
        .await
    }

    async fn spawn_inner(
        binary: &Path,
        home: &Path,
        cwd: &Path,
        environment: &HashMap<String, String>,
        timeout: Duration,
        observe: Option<Observe>,
    ) -> Result<Self> {
        let mut environment = environment.clone();
        if cfg!(windows) {
            environment.retain(|key, _| !key.eq_ignore_ascii_case("CODEX_HOME"));
        }
        environment.insert("CODEX_HOME".into(), home.to_string_lossy().into_owned());
        let auth = observe.is_some();
        let mut args = vec!["app-server".into(), "--listen".into(), "stdio://".into()];
        if auth {
            args.extend([
                "-c".into(),
                "model_provider=\"openai\"".into(),
                "-c".into(),
                "cli_auth_credentials_store=\"file\"".into(),
            ]);
        }
        let child =
            codex_utils_pty::spawn_pipe_process(binary, &args, cwd, &environment, &None, &[])
                .await?;
        let (send, receive) = mpsc::unbounded_channel();
        let closed = Arc::new(AtomicBool::new(false));
        let writer = child.session.writer_sender();
        let session = Arc::new(Mutex::new(Some(child.session)));
        let process = Arc::downgrade(&session);
        let observed: Arc<dyn Fn() -> Option<std::process::ExitStatus> + Send + Sync> =
            Arc::new(move || {
                let owner = process.upgrade()?;
                owner.lock().ok()?.as_ref()?.native_exit_status()
            });
        let io = tokio::spawn(actor::run(
            receive,
            send.clone(),
            closed.clone(),
            writer,
            child.stdout_rx,
            child.stderr_rx,
            child.exit_rx,
            timeout,
            observed,
            observe,
        ));
        Ok(Self(Arc::new(Inner {
            operations: send,
            next: AtomicU64::new(1),
            next_wait: AtomicU64::new(1),
            closed,
            session,
            io: Mutex::new(Some(io)),
            close_guard: tokio::sync::Mutex::new(()),
            confirm_exit: auth,
            exit_unconfirmed: AtomicBool::new(false),
            timeout,
        })))
    }
    pub(super) fn is_closed(&self) -> bool {
        self.0.closed.load(Ordering::Acquire)
    }
    pub fn request(&self, method: JsString, params: Option<Value>) -> Work<Value> {
        let id = self.0.next.fetch_add(1, Ordering::Relaxed);
        let (send, receive) = oneshot::channel();
        if !self.0.closed.load(Ordering::Acquire) {
            let _ = self.0.operations.send(Operation::Request {
                id,
                method,
                params,
                send,
            });
        }
        response(receive)
    }
    pub fn notify(&self, method: JsString, params: Option<Value>) -> Result<()> {
        let mut value = json!({"method":method});
        if let Some(params) = params {
            value["params"] = params;
        }
        self.0
            .operations
            .send(Operation::Notify(value))
            .map_err(|_| anyhow!("Codex app-server client closed."))
    }
    pub fn wait(
        &self,
        method: JsString,
        predicate: Predicate,
        timeout: Option<Duration>,
    ) -> Work<Value> {
        let id = self.0.next_wait.fetch_add(1, Ordering::Relaxed);
        let (send, receive) = oneshot::channel();
        if !self.0.closed.load(Ordering::Acquire) {
            let _ = self.0.operations.send(Operation::Wait {
                id,
                method,
                predicate,
                timeout: timeout.unwrap_or(self.0.timeout),
                send,
            });
        }
        response(receive)
    }
    /// An explicit close rejects observations immediately, then joins the owned
    /// native child. Abandoning the close response does not abandon cleanup.
    pub fn close(&self) -> Work<()> {
        self.0.closed.store(true, Ordering::Release);
        let _ = self.0.operations.send(Operation::Close);
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let _guard = this.0.close_guard.lock().await;
            let session = this.0.session.lock().unwrap().take();
            if let Some(mut session) = session {
                if !session.has_exited() {
                    let _ = session.signal(ProcessSignal::Interrupt);
                }
                let io = this.0.io.lock().unwrap().take();
                if let Some(mut io) = io {
                    if tokio::time::timeout(Duration::from_secs(2), &mut io)
                        .await
                        .is_err()
                    {
                        session.terminate_and_wait().await;
                        io.abort();
                        let _ = io.await;
                    } else {
                        session.terminate_and_wait().await;
                    }
                } else {
                    session.terminate_and_wait().await;
                }
                if this.0.confirm_exit && session.native_exit_status().is_none() {
                    this.0.exit_unconfirmed.store(true, Ordering::Release);
                }
            }
            if this.0.exit_unconfirmed.load(Ordering::Acquire) {
                anyhow::bail!("Could not confirm Codex authentication process exit.");
            }
            Ok(())
        })
    }
    pub fn initialize(
        &self,
        name: &str,
        title: &str,
        version: &str,
        experimental: bool,
    ) -> Work<Value> {
        let pending=self.request("initialize".into(),Some(json!({"clientInfo":json!({"name":name,"title":title,"version":version}),"capabilities":json!({"experimentalApi":experimental,"requestAttestation":false})})));
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let response = pending.await?;
            if response.get("error").is_some() {
                return Err(crate::error::WireError(
                    response["error"]["message"].as_js_string().unwrap().clone(),
                )
                .into());
            }
            this.notify("initialized".into(), Some(json!({})))?;
            Ok(response["result"].clone())
        })
    }
}
