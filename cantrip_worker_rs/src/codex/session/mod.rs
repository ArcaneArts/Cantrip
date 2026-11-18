//! Managed native process/WebSocket lifetime. Execution policy is an owner adapter.
mod socket;
use super::{
    process_transport::{Options, Process},
    rpc_requests::{Failure, Ports, Requests, Response, Settlement},
};
use crate::history::live::observation::Hub;
use anyhow::{Result, anyhow};
use cantrip_history::projection::Work;
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{sync::mpsc, task::JoinHandle};
use tokio_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};
#[derive(Clone, Debug)]
pub enum EventKind {
    Message(Value),
    TransportLost(JsString),
    ProcessExited(i32),
}
#[derive(Clone, Debug)]
pub struct Event {
    pub generation: String,
    pub kind: EventKind,
}
#[derive(Clone, Default)]
struct ThreadVersions(Arc<Mutex<HashMap<JsString, u64>>>);

impl ThreadVersions {
    fn closed(&self, thread: JsString) {
        *self.0.lock().unwrap().entry(thread).or_default() += 1;
    }

    fn current(&self, thread: &JsString) -> u64 {
        self.0.lock().unwrap().get(thread).copied().unwrap_or(0)
    }
}

enum Outgoing {
    Send(Message),
    Close,
}
struct Inner {
    requests: Requests,
    outgoing: mpsc::UnboundedSender<Outgoing>,
    closed: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
    process: Arc<tokio::sync::Mutex<Option<Process>>>,
    io: Mutex<Option<JoinHandle<()>>>,
    close: tokio::sync::Mutex<()>,
    history: Hub,
    threads: ThreadVersions,
    generation: String,
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
        self.history.replace(None);
        self.requests
            .reject_all("Codex app-server client closed.".into());
        let _ = self.outgoing.send(Outgoing::Close);
        let process = self.process.clone();
        let io = self.io.lock().unwrap().take();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                if let Some(mut process) = process.lock().await.take() {
                    let _ = process.close().await;
                }
                if let Some(mut io) = io
                    && tokio::time::timeout(Duration::from_secs(2), &mut io)
                        .await
                        .is_err()
                {
                    io.abort();
                    let _ = io.await;
                }
            });
        } else if let Some(io) = io {
            io.abort();
        }
    }
}
#[derive(Clone)]
pub struct Session(Arc<Inner>);
impl Session {
    pub fn launch(
        binary: PathBuf,
        arguments: Vec<String>,
        options: Options,
    ) -> Work<(Self, mpsc::UnboundedReceiver<Event>)> {
        cantrip_transport::lifecycle::owned(async move {
            let mut process = Process::launch(&binary, &arguments, &options).await?;
            let connected = async {
                let endpoint = process.endpoint(options.startup_timeout).await?;
                let socket = tokio::time::timeout(
                    options.startup_timeout,
                    tokio_tungstenite::connect_async_with_config(
                        endpoint.lossy().into_owned(),
                        Some(
                            WebSocketConfig::default()
                                .max_message_size(Some(100 * 1024 * 1024))
                                .max_frame_size(Some(100 * 1024 * 1024)),
                        ),
                        true,
                    ),
                )
                .await
                .map_err(|_| {
                    anyhow!("Codex app-server WebSocket did not connect within 120 seconds.")
                })??
                .0;
                Ok::<_, anyhow::Error>(socket)
            }
            .await;
            let socket = match connected {
                Ok(socket) => socket,
                Err(error) => {
                    if let Err(cleanup) = process.close().await {
                        return Err(cleanup.context(error.to_string()));
                    }
                    return Err(error);
                }
            };
            let exit = process.exit.clone();
            let process = Arc::new(tokio::sync::Mutex::new(Some(process)));
            let (outgoing, receive) = mpsc::unbounded_channel();
            let (events, observations) = mpsc::unbounded_channel();
            let closed = Arc::new(AtomicBool::new(false));
            let exited = Arc::new(AtomicBool::new(false));
            let send = outgoing.clone();
            let is_closed = closed.clone();
            let requests = Requests::new(Ports {
                send: Arc::new(move |value| {
                    if is_closed.load(Ordering::Acquire) {
                        return Err(Failure::send("Codex app-server is not writable.").into());
                    }
                    send.send(Outgoing::Send(Message::Text(value.stringify().into())))
                        .map_err(|_| Failure::send("Codex app-server is not writable.").into())
                }),
                record: options.record,
                policy: options.policy,
                runtime_id: options.runtime_id,
                logs: options.logs,
            });
            let generation = uuid::Uuid::new_v4().to_string();
            let history = Hub::default();
            history.replace(Some(generation.as_str().into()));
            let threads = ThreadVersions::default();
            let io = tokio::spawn(socket::run(
                socket,
                receive,
                outgoing.clone(),
                requests.clone(),
                closed.clone(),
                exited.clone(),
                process.clone(),
                exit,
                events,
                history.clone(),
                threads.clone(),
                generation.clone(),
            ));
            Ok((
                Self(Arc::new(Inner {
                    requests,
                    outgoing,
                    closed,
                    exited,
                    process,
                    io: Mutex::new(Some(io)),
                    close: tokio::sync::Mutex::new(()),
                    history,
                    threads,
                    generation,
                })),
                observations,
            ))
        })
    }
    pub fn generation(&self) -> Option<&str> {
        (!self.0.closed.load(Ordering::Acquire)).then_some(self.0.generation.as_str())
    }
    pub(super) fn history(&self) -> Hub {
        self.0.history.clone()
    }
    pub(super) fn thread_version(&self, thread: &JsString) -> u64 {
        self.0.threads.current(thread)
    }
    pub fn process_exited(&self) -> bool {
        self.0.exited.load(Ordering::Acquire)
    }
    pub fn remember_secret(&self, secret: JsString) {
        self.0.requests.remember_secret(secret);
    }
    pub fn pending_count(&self) -> usize {
        self.0.requests.pending_count()
    }
    pub fn request(
        &self,
        method: JsString,
        params: Option<Value>,
        timeout: Option<Duration>,
        settlement: Option<Arc<dyn Settlement>>,
    ) -> Work<Response> {
        self.0.requests.request(method, params, timeout, settlement)
    }
    pub fn send(&self, value: Value) -> Result<()> {
        if self.0.closed.load(Ordering::Acquire) {
            return Err(Failure::send("Codex app-server is not writable.").into());
        }
        self.0
            .outgoing
            .send(Outgoing::Send(Message::Text(value.stringify().into())))
            .map_err(|_| Failure::send("Codex app-server is not writable.").into())
    }
    pub fn initialize(
        &self,
        name: &str,
        title: &str,
        version: &str,
        experimental: bool,
    ) -> Work<Response> {
        let request=self.request("initialize".into(),Some(json!({"clientInfo":json!({"name":name,"title":title,"version":version}),"capabilities":json!({"experimentalApi":experimental,"mcpServerOpenaiFormElicitation":true,"requestAttestation":false})})),Some(Duration::from_secs(120)),None);
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let result = request.await?;
            this.send(json!({"method":"initialized","params":json!({})}))?;
            Ok(result)
        })
    }
    pub fn close(&self) -> Work<()> {
        self.0.closed.store(true, Ordering::Release);
        self.0.history.replace(None);
        self.0
            .requests
            .reject_all("Codex app-server client closed.".into());
        let _ = self.0.outgoing.send(Outgoing::Close);
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let _close = this.0.close.lock().await;
            if let Some(mut process) = this.0.process.lock().await.take() {
                process.close().await?;
                this.0
                    .exited
                    .store(process.exit_confirmed(), Ordering::Release);
            }
            let task = this.0.io.lock().unwrap().take();
            if let Some(mut io) = task
                && tokio::time::timeout(Duration::from_secs(2), &mut io)
                    .await
                    .is_err()
            {
                io.abort();
                let _ = io.await;
            }
            Ok(())
        })
    }
}
