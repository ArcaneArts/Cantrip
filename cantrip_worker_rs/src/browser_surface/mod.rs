//! Host browser surfaces on the authenticated worker command and data transports.
mod link;
mod profile;
mod session;

use crate::{connection::Outbound, encryption::Service, logging::Logs};
use anyhow::{Context, Result, anyhow, bail, ensure};
use cantrip_framing::remote_surface::Frame;
use cantrip_transport::output::{Buffered, Queued};
use cantrip_wire::{JsString, Value, value::json};
pub(crate) use link::{Kind as LinkLane, Lane, Link};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{
    sync::{Notify, mpsc, oneshot, watch},
    task::JoinSet,
    time::MissedTickBehavior,
};

const LIMIT: usize = 4;
const QUEUE: usize = 32;
const INPUT_BUFFER: usize = 8 * 1024 * 1024;

pub(crate) struct Manager {
    state: Mutex<Registry>,
    shared: Arc<Shared>,
    stop: watch::Sender<bool>,
}

#[derive(Default)]
struct Registry {
    running: HashMap<JsString, Arc<Endpoint>>,
    tasks: JoinSet<()>,
    closed: bool,
}

struct Endpoint {
    sender: mpsc::Sender<Work>,
    buffered: Buffered,
    attachments: Mutex<HashMap<JsString, Weak<Route>>>,
}

struct Route {
    epoch: u64,
    owner: JsString,
    server: Value,
    link: Mutex<Option<Arc<Link>>>,
}

enum FrameSource {
    Legacy(u64),
    Link { link: Weak<Link>, channel: Weak<()> },
}

struct Shared {
    encryption: Arc<Service>,
    outgoing: Arc<Outbound>,
    logs: Arc<Logs>,
    profiles: profile::Profiles,
}

type Callback = oneshot::Sender<Result<Value>>;

enum Work {
    Command {
        value: Value,
        epoch: u64,
        done: Callback,
    },
    Frame {
        frame: Queued<Frame>,
        source: FrameSource,
    },
    Refresh(JsString),
}

pub(crate) fn capabilities(environment: &cantrip_config::Environment) -> Value {
    json!({
        "browser": profile::discover(environment),
        "desktop": false,
        "transports": ["websocket"],
        "iceTransportPolicies": ["relay"],
        "maxSessions": LIMIT,
    })
}

pub(crate) fn supports(kind: &str) -> bool {
    matches!(
        kind,
        "surface.attach"
            | "surface.detach"
            | "surface.configure"
            | "surface.suspend"
            | "surface.resume"
            | "surface.close"
    )
}

impl Manager {
    pub fn new(
        data_directory: &Path,
        environment: &cantrip_config::Environment,
        encryption: Arc<Service>,
        outgoing: Arc<Outbound>,
        logs: Arc<Logs>,
    ) -> Self {
        Self {
            state: Mutex::default(),
            shared: Arc::new(Shared {
                encryption,
                outgoing,
                logs,
                profiles: profile::Profiles::new(data_directory, environment),
            }),
            stop: watch::channel(false).0,
        }
    }

    pub fn submit(&self, value: &Value, epoch: u64) -> Result<oneshot::Receiver<Result<Value>>> {
        ensure!(
            self.shared.outgoing.stream_current(epoch),
            "Browser command authority expired."
        );
        let mut state = self.state.lock().unwrap();
        ensure!(!state.closed, "Browser surfaces have stopped.");
        while state.tasks.try_join_next().is_some() {}
        state
            .running
            .retain(|_, endpoint| !endpoint.sender.is_closed());
        let surface = id(value, "surfaceId");
        let kind = value["type"].as_str().unwrap();
        let (done, result) = oneshot::channel();
        if let Some(endpoint) = state.running.get(surface) {
            endpoint
                .sender
                .try_send(Work::Command {
                    value: value.clone(),
                    epoch,
                    done,
                })
                .map_err(|_| anyhow!("Browser surface command queue is unavailable."))?;
        } else if kind == "surface.attach" {
            ensure!(
                value["configuration"]["kind"] == "browser",
                "Native desktop surfaces are unavailable."
            );
            ensure!(
                state.running.len() < LIMIT,
                "Worker Remote Surface limit of {LIMIT} sessions reached."
            );
            let (sender, receiver) = mpsc::channel(QUEUE);
            let shared = self.shared.clone();
            let stopped = self.stop.subscribe();
            let surface = surface.clone();
            let endpoint = Arc::new(Endpoint {
                sender,
                buffered: Buffered::default(),
                attachments: Mutex::default(),
            });
            state.tasks.spawn(serve(
                shared,
                surface.clone(),
                endpoint.clone(),
                receiver,
                stopped,
            ));
            let _ = endpoint.sender.try_send(Work::Command {
                value: value.clone(),
                epoch,
                done,
            });
            state.running.insert(surface, endpoint);
        } else if matches!(kind, "surface.suspend" | "surface.resume") {
            bail!("Remote Surface is not open on this worker.");
        } else {
            let _ = done.send(Ok(accepted()));
        }
        Ok(result)
    }

    pub fn receive(&self, frame: Frame, epoch: u64) {
        let header = frame.header();
        if header["channel"] != "control" {
            return;
        }
        let state = self.state.lock().unwrap();
        if let Some(endpoint) = state.running.get(id(header, "surfaceId")) {
            endpoint.receive(frame, FrameSource::Legacy(epoch));
        }
    }

    pub(crate) fn bind(
        &self,
        binding: &Value,
        wake: Arc<Notify>,
        deadline: i64,
    ) -> Result<Arc<Link>> {
        let resource = &binding["resource"];
        let surface = id(resource, "resourceId");
        let attachment = resource["attachmentId"]
            .as_js_string()
            .context("Browser grant has no attachment.")?;
        let endpoint = self
            .state
            .lock()
            .unwrap()
            .running
            .get(surface)
            .cloned()
            .context("Browser session is not open.")?;
        let route = endpoint
            .attachments
            .lock()
            .unwrap()
            .get(attachment)
            .and_then(Weak::upgrade)
            .context("Browser attachment is not running.")?;
        let mut carrier = route.link.lock().unwrap();
        let identity = &binding["identity"];
        ensure!(
            carrier.is_none()
                && self.shared.outgoing.stream_current(route.epoch)
                && identity["ownerId"].as_js_string() == Some(&route.owner)
                && identity["serverId"] == route.server,
            "Browser attachment cannot bind to this grant."
        );
        let link = Arc::new(Link::new(
            surface.clone(),
            attachment.clone(),
            Arc::downgrade(&endpoint),
            wake,
            deadline,
        ));
        *carrier = Some(link.clone());
        if endpoint
            .sender
            .try_send(Work::Refresh(attachment.clone()))
            .is_err()
        {
            carrier.take();
            bail!("Browser attachment command queue is unavailable.");
        }
        Ok(link)
    }

    pub async fn close(&self) {
        let mut tasks = {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            self.stop.send_replace(true);
            state.running.clear();
            std::mem::take(&mut state.tasks)
        };
        while tasks.join_next().await.is_some() {}
    }
}

impl Endpoint {
    fn receive(&self, frame: Frame, source: FrameSource) -> bool {
        let size = frame.bytes().len();
        self.buffered
            .bounded(frame, size, INPUT_BUFFER)
            .is_some_and(|frame| self.sender.try_send(Work::Frame { frame, source }).is_ok())
    }

    fn register(
        &self,
        attachment: JsString,
        epoch: u64,
        owner: JsString,
        server: Value,
    ) -> Arc<Route> {
        let route = Arc::new(Route {
            epoch,
            owner,
            server,
            link: Mutex::default(),
        });
        let mut attachments = self.attachments.lock().unwrap();
        attachments.retain(|_, route| route.strong_count() > 0);
        attachments.insert(attachment, Arc::downgrade(&route));
        route
    }
}

impl Route {
    fn alive(&self, outgoing: &Outbound) -> bool {
        match self.link.lock().unwrap().as_ref() {
            None => outgoing.stream_current(self.epoch),
            Some(link) => link.is_active(),
        }
    }

    fn receives(&self, source: &FrameSource, outgoing: &Outbound) -> bool {
        match (self.link.lock().unwrap().as_ref(), source) {
            (None, FrameSource::Legacy(epoch)) => {
                *epoch == self.epoch && outgoing.stream_current(*epoch)
            }
            (Some(bound), FrameSource::Link { link, channel }) => {
                channel.strong_count() > 0
                    && Weak::ptr_eq(link, &Arc::downgrade(bound))
                    && bound.is_active()
            }
            _ => false,
        }
    }

    fn emit(&self, frame: Frame, outgoing: &Outbound) -> bool {
        match self.link.lock().unwrap().as_ref() {
            None => outgoing.binary_for_epoch(frame.bytes(), Some(self.epoch)),
            Some(link) => link.emit(frame),
        }
    }

    fn closes_on(&self, epoch: u64) -> bool {
        epoch == self.epoch || self.link.lock().unwrap().is_some()
    }
}

impl Drop for Route {
    fn drop(&mut self) {
        if let Some(link) = self.link.get_mut().unwrap().take() {
            link.revoke();
        }
    }
}

async fn serve(
    shared: Arc<Shared>,
    surface: JsString,
    endpoint: Arc<Endpoint>,
    mut input: mpsc::Receiver<Work>,
    mut stopped: watch::Receiver<bool>,
) {
    let mut browser = None;
    tokio::select! {
        biased;
        _ = stopped.changed() => {},
        result = run(&shared, &surface, &endpoint, &mut input, &mut browser) => {
            if result.is_err() {
                shared.logs.event("warn","Browser surface closed",json!({
                    "event":"browser.surface.closed","status":"degraded",
                    "subsystem":"browser-surface","surfaceId":surface
                }));
            }
        },
    }
    if let Some(browser) = browser {
        browser.close().await;
    }
}

async fn run(
    shared: &Arc<Shared>,
    surface: &JsString,
    endpoint: &Arc<Endpoint>,
    input: &mut mpsc::Receiver<Work>,
    browser: &mut Option<session::Session>,
) -> Result<()> {
    let Some(Work::Command { value, epoch, done }) = input.recv().await else {
        return Ok(());
    };
    let opened = session::Session::open(
        shared.clone(),
        endpoint.clone(),
        surface.clone(),
        &value,
        epoch,
    )
    .await;
    let current = match opened {
        Ok(opened) => browser.insert(opened),
        Err(error) => {
            let _ = done.send(Err(error));
            return Ok(());
        }
    };
    let mut events = current.page().subscribe();
    let result = match current.initialize(&value["viewport"], epoch).await {
        Ok(()) => current.attach(&value, epoch).await,
        Err(error) => Err(error),
    };
    let attached = result.is_ok();
    let _ = done.send(result);
    if !attached {
        return Ok(());
    }

    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            next = input.recv() => match next {
                Some(Work::Command { value, epoch, done }) => {
                    let result = current.command(&value, epoch).await;
                    if value["type"] == "surface.close" && result.is_ok() {
                        if let Some(closing) = browser.take() {
                            closing.close().await;
                        }
                        let _ = done.send(result);
                        return Ok(());
                    }
                    let _ = done.send(result);
                }
                Some(Work::Frame { frame, source }) => { let _ = current.frame(&frame, &source).await; }
                Some(Work::Refresh(attachment)) => current.refresh(&attachment).await,
                None => return Ok(()),
            },
            event = events.next() => current.event(event?).await,
            _ = tick.tick() => {
                current.reconcile().await?;
            }
        }
    }
}

fn id<'a>(value: &'a Value, key: &str) -> &'a JsString {
    value[key]
        .as_js_string()
        .expect("validated surface binding")
}

fn accepted() -> Value {
    json!({"accepted":true})
}

pub(crate) fn epoch(request: &Value) -> Result<u64> {
    request["socketEpoch"]
        .as_u64()
        .context("Browser command has no connected socket.")
}
