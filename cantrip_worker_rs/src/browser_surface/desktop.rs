//! Host and assigned Linux desktop capture on the authenticated surface transports.
mod input;

use super::{Callback, Endpoint, FrameSource, Route, Shared, Work, accepted, id};
use crate::{
    desktop_inventory::{
        Capture, ControlState, GuestControl, Inventory, MissingCaptureTarget, PortalCaptureConsent,
        Scope, seal_inventory,
    },
    http::checked,
    protected_content::{open_private_state, open_remote_surface, protect_remote_surface},
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use cantrip_framing::remote_surface::{self, Frame};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use image::{
    ImageDecoder,
    codecs::{jpeg::JpegEncoder, png::PngDecoder},
};
use input::{Update, Viewer};
use std::{
    collections::{HashMap, VecDeque},
    future::{Future, pending},
    io::Cursor,
    pin::Pin,
    sync::{Arc, Weak},
    time::Duration,
};
use tokio::{
    sync::{Semaphore, mpsc, watch},
    task::JoinSet,
    time::{Instant, MissedTickBehavior, sleep_until},
};

struct Session<'a> {
    shared: &'a Shared,
    endpoint: &'a Endpoint,
    surface: &'a JsString,
    owner: JsString,
    server: Value,
    project: Value,
    guest: Option<GuestSource>,
    controller: Option<Controller>,
    control_state: Option<ControlState>,
    desktop: Target,
    attachments: HashMap<JsString, Attachment>,
    fps: u32,
    tuner: Tuner,
    suspended: bool,
    status: &'static str,
    failure: Option<String>,
    observed: f64,
    dimensions: (u32, u32, u32),
    logical: (f64, f64),
    updates: mpsc::Sender<Update>,
    inputs: JoinSet<()>,
    inventories: JoinSet<InventoryRefresh>,
    icon_jobs: JoinSet<IconReply>,
    last_inventory: Inventory,
    restore_armed: bool,
    restoring: bool,
    restored_window: Option<Value>,
    restore_failure: Option<String>,
}

struct Attachment {
    route: Arc<Route>,
    viewport: Value,
    incoming: Option<u64>,
    outgoing: HashMap<&'static str, u64>,
    source: Option<FrameSource>,
    input: Option<Viewer>,
    closing: Option<watch::Receiver<bool>>,
    inventory_request: Option<u64>,
    icon_requests: VecDeque<(FrameSource, Value)>,
    resolving_icons: bool,
}

struct InventoryRefresh {
    attachment: JsString,
    route: Weak<Route>,
    source: FrameSource,
    sequence: u64,
    result: Result<Inventory>,
}

struct IconReply {
    attachment: JsString,
    route: Weak<Route>,
    source: FrameSource,
    icons: Vec<Value>,
}

const ICON_BATCHES_PER_VIEWER: usize = 32;

impl Attachment {
    fn stop_input(&mut self) -> bool {
        if let Some(input) = self.input.take() {
            self.closing = Some(input.closed.clone());
            true
        } else {
            false
        }
    }
}

#[derive(PartialEq)]
struct Target {
    revision: u64,
    value: Value,
}

struct Controller {
    attachment: JsString,
    lease: Arc<GuestControl>,
}

#[derive(Clone)]
struct GuestSource {
    source: Value,
    execution: Value,
    generation: String,
}

impl GuestSource {
    fn from_attachment(
        command: &Value,
        owner: &JsString,
        worker: &JsString,
    ) -> Result<Option<Self>> {
        let source = &command["configuration"]["osSource"];
        let execution = &command["osExecution"];
        if source.is_null() {
            ensure!(execution.is_null(), "Invalid Host desktop source.");
            return Ok(None);
        }
        let scope = &execution["scope"];
        ensure!(
            scope["ownerId"].as_js_string() == Some(owner)
                && scope["workerId"].as_js_string() == Some(worker)
                && scope["projectId"] == command["projectId"]
                && [
                    "bindingId",
                    "worktreeId",
                    "bindingGeneration",
                    "attachmentGeneration",
                    "runtimeGeneration"
                ]
                .iter()
                .all(|field| scope[*field] == source[*field]),
            "Linux desktop execution belongs to another owner, project or Worker."
        );
        let generation = source["desktopGeneration"]
            .as_str()
            .context("This Linux desktop has no captured generation. Open a new view.")?;
        Ok(Some(Self {
            source: source.clone(),
            execution: execution.clone(),
            generation: generation.to_owned(),
        }))
    }
}

struct Image {
    jpeg: Vec<u8>,
    width: u32,
    height: u32,
    encoded_width: u32,
    logical: (f64, f64),
}

static ENCODERS: Semaphore = Semaphore::const_new(2);

type WorkFrame =
    Pin<Box<dyn Future<Output = Result<(Arc<Capture>, Image, Option<Inventory>)>> + Send>>;

pub(super) async fn run(
    shared: &Shared,
    endpoint: &Endpoint,
    surface: &JsString,
    input: &mut mpsc::Receiver<Work>,
    opening: Value,
    epoch: u64,
    done: Callback,
) -> Result<()> {
    let (updates, mut changes) = mpsc::channel(16);
    let mut active = match Session::begin(shared, endpoint, surface, &opening, epoch, updates) {
        Ok(value) => value,
        Err(error) => {
            let _ = done.send(Err(error));
            return Ok(());
        }
    };
    let mut capture = if active.guest.is_some() {
        match active.open_capture(epoch).await {
            Ok(capture) => Some(Arc::new(capture)),
            Err(error) => {
                let _ = done.send(Err(error));
                return Ok(());
            }
        }
    } else {
        None
    };
    let _ = done.send(Ok(attached()));
    let mut work: Option<WorkFrame> = None;
    let mut awaiting_portal_retry = false;
    let mut due = Instant::now();
    let mut started = due;
    let mut losses = 0_u32;
    let mut observations = 0_u32;
    let mut window = due;
    let mut check = tokio::time::interval(Duration::from_millis(250));
    check.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            command = input.recv() => {
                match command {
                    None => break,
                    Some(Work::Command { value, epoch, done }) => {
                        let attaching = value["type"] == "surface.attach";
                        let mut result = active.command(&value, epoch);
                        if result.as_ref().is_ok_and(|effect| *effect != Effect::Keep) {
                            drop(work.take());
                            if std::mem::take(&mut active.restoring) {
                                let _ = active.publish_inventory_state(None, None, None);
                            }
                            if let Some(capture) = capture.take() {
                                release(capture).await;
                            }
                            losses = 0;
                            due = Instant::now();
                            awaiting_portal_retry = false;
                        }
                        if result.is_ok() && attaching && awaiting_portal_retry {
                            awaiting_portal_retry = false;
                            due = Instant::now();
                        }
                        if result.is_ok() && attaching && active.guest.is_some()
                            && !active.suspended && capture.is_none()
                        {
                            drop(work.take());
                            match active.open_capture(epoch).await {
                                Ok(opened) => capture = Some(Arc::new(opened)),
                                Err(error) => {
                                    active.attachments.remove(id(&value, "attachmentId"));
                                    result = Err(error);
                                }
                            }
                        }
                        let end = result.as_ref().is_ok_and(|effect| *effect == Effect::Close);
                        let response = result.map(|_| if attaching { attached() } else { accepted() });
                        let _ = done.send(response);
                        if end { break; }
                    }
                    Some(Work::Frame { frame, source }) => {
                        let was_armed = active.restore_armed;
                        let _ = active.control(&frame, &source, capture.as_ref());
                        if !was_armed && active.restore_armed {
                            due = Instant::now();
                            awaiting_portal_retry = false;
                        }
                    }
                    Some(Work::Refresh(attachment)) => {
                        active.publish(Some(&attachment));
                        active.publish_control(Some(&attachment));
                    }
                    Some(Work::AgentBorrow { done, .. }) => {
                        let _ = done.send(Err(anyhow!("This surface is a desktop.")));
                    }
                    Some(Work::AgentPresentation(_)) => {}
                }
            },
            Some(change) = changes.recv() => active.input_update(change),
            _ = active.inputs.join_next(), if !active.inputs.is_empty() => {}
            Some(Ok(refresh)) = active.inventories.join_next(), if !active.inventories.is_empty() => {
                active.finish_inventory(refresh, capture.as_deref());
            }
            Some(Ok(reply)) = active.icon_jobs.join_next(), if !active.icon_jobs.is_empty() => {
                active.finish_icons(reply);
                active.start_icon_jobs();
            }
            result = async {
                match &mut work {
                    Some(work) => work.await,
                    None => pending().await,
                }
            } => {
                work = None;
                active.authorize()?;
                let restoring = std::mem::take(&mut active.restoring);
                match result {
                    Ok((lease, image, inventory)) if active.visible() => {
                        if let Some(inventory) = inventory {
                            active.restored_window = Some(lease.selected_target()?);
                            active.last_inventory = inventory;
                        }
                        active.restore_failure = None;
                        let opening = capture.is_none();
                        active.logical = image.logical;
                        capture = Some(lease);
                        if opening {
                            let ready = capture.as_ref().unwrap();
                            let viewers: Vec<_> = active.attachments.keys().cloned().collect();
                            for viewer in viewers {
                                active.start_input(&viewer, ready);
                            }
                        }
                        let dimensions = (image.width, image.height, image.encoded_width);
                        if active.status != "ready" || active.dimensions != dimensions {
                            active.dimensions = dimensions;
                            active.status = "ready";
                            active.publish(None);
                        }
                        if restoring {
                            let _ = active.publish_inventory_state(None, capture.as_deref(), None);
                        }
                        let accepted = active.send(None, "frame", &image.jpeg);
                        active.tuner.record(image.jpeg.len(), active.fps, accepted);
                        observations += 1;
                        let elapsed = window.elapsed();
                        if elapsed >= Duration::from_secs(1) {
                            active.observed = (f64::from(observations) / elapsed.as_secs_f64()).min(240.0);
                            observations = 0;
                            window = Instant::now();
                            active.publish(None);
                        }
                        losses = 0;
                        due = started + Duration::from_secs_f64(1.0 / f64::from(active.fps));
                    }
                    Ok((lease, _, _)) => release(lease).await,
                    Err(error) if !restoring &&
                        error.is::<MissingCaptureTarget>() && active.restore_armed &&
                        active.guest.is_none() && active.desktop.value["kind"] == "window"
                    => {
                        if let Some(epoch) = active.stream_epoch().filter(|_| active.visible()) {
                            active.restore_armed = false;
                            active.restoring = true;
                            active.restore_failure = None;
                            active.reset_capture();
                            let _ = active.publish_inventory_state(None, None, None);
                            started = Instant::now();
                            work = Some(active.sample(epoch, None, true));
                        }
                    }
                    Err(error) if active.visible() => {
                        awaiting_portal_retry = error.is::<PortalCaptureConsent>();
                        active.retire_inputs();
                        if let Some(lease) = capture.take() {
                            release(lease).await;
                        }
                        losses = losses.saturating_add(1);
                        let failure: String = if restoring {
                            format!("{error:#}").chars().take(512).collect()
                        } else if error.is::<MissingCaptureTarget>() {
                            active.restore_failure.clone().unwrap_or_else(|| {
                                error.to_string().chars().take(512).collect()
                            })
                        } else {
                            error.to_string().chars().take(512).collect()
                        };
                        if restoring {
                            active.restore_failure = Some(failure.clone());
                            let _ = active.publish_inventory_state(None, None, Some(&failure));
                        }
                        if active.status != "error" || active.failure.as_ref() != Some(&failure) {
                            active.status = "error";
                            active.failure = Some(failure);
                            active.publish(None);
                        }
                        due = Instant::now() + Duration::from_millis((250 * (1 << (losses-1).min(5))).min(5000));
                    }
                    Err(_) => {}
                }
            },
            _ = check.tick() => {
                active.authorize()?;
                active.prune();
                let control = capture.as_ref().and_then(|capture| capture.control_state());
                if active.control_state != control {
                    active.control_state = control;
                    active.publish_control(None);
                }
                if !active.visible() {
                    drop(work.take());
                    active.restoring = false;
                    if let Some(capture) = capture.take() {
                        release(capture).await;
                    }
                }
            },
            _ = sleep_until(due), if work.is_none() && active.visible() && !awaiting_portal_retry => {
                let Some(epoch) = active.stream_epoch() else { continue };
                started = Instant::now();
                work = Some(active.sample(epoch, capture.clone(), false));
            },
        }
    }
    drop(work);
    active.attachments.clear();
    active.inputs.shutdown().await;
    active.inventories.shutdown().await;
    active.icon_jobs.shutdown().await;
    if let Some(capture) = capture {
        release(capture).await;
    }
    Ok(())
}

#[derive(PartialEq)]
enum Effect {
    Keep,
    Retire,
    Close,
}

impl<'a> Session<'a> {
    fn begin(
        shared: &'a Shared,
        endpoint: &'a Endpoint,
        surface: &'a JsString,
        incoming: &Value,
        epoch: u64,
        updates: mpsc::Sender<Update>,
    ) -> Result<Self> {
        let owner = shared
            .encryption
            .bound_component("surface-private-state", None)?;
        let target = private_target(shared, surface, &owner.owner_id, &owner.server_id, incoming)?;
        let guest =
            GuestSource::from_attachment(incoming, &owner.owner_id, shared.encryption.worker_id())?;
        ensure!(
            guest.is_none() || target.value["kind"] == "monitor",
            "Linux workspace viewing requires its assigned display."
        );
        let settings = &incoming["desktopStream"];
        let default_fps = if guest.is_some() { 15 } else { 30 };
        let mut active = Self {
            shared,
            endpoint,
            surface,
            owner: owner.owner_id,
            server: owner.server_id,
            project: incoming["projectId"].clone(),
            guest,
            controller: None,
            control_state: None,
            desktop: target,
            attachments: HashMap::new(),
            fps: settings["targetFps"].as_u64().unwrap_or(default_fps) as u32,
            tuner: Tuner::new(settings["quality"].as_str()),
            suspended: false,
            status: "launching",
            failure: None,
            observed: 0.0,
            dimensions: (1, 1, 1),
            logical: (1.0, 1.0),
            updates,
            inputs: JoinSet::new(),
            inventories: JoinSet::new(),
            icon_jobs: JoinSet::new(),
            last_inventory: Inventory::default(),
            restore_armed: true,
            restoring: false,
            restored_window: None,
            restore_failure: None,
        };
        active.attach(incoming, epoch)?;
        Ok(active)
    }

    fn authorize(&self) -> Result<()> {
        let key = self
            .shared
            .encryption
            .bound_component("surface-private-state", None)?;
        ensure!(
            key.owner_id == self.owner && key.server_id == self.server,
            "Desktop session authority changed."
        );
        Ok(())
    }

    fn visible(&self) -> bool {
        !self.suspended && self.stream_epoch().is_some()
    }

    fn stream_epoch(&self) -> Option<u64> {
        self.attachments
            .values()
            .find(|member| {
                member.route.alive(&self.shared.outgoing)
                    && self.shared.outgoing.stream_current(member.route.epoch)
            })
            .map(|member| member.route.epoch)
    }

    fn attach(&mut self, command: &Value, epoch: u64) -> Result<()> {
        ensure!(
            command["projectId"] == self.project,
            "Desktop attachment belongs to another project."
        );
        self.prune();
        let attachment = id(command, "attachmentId").clone();
        ensure!(
            self.attachments.len() < 4 || self.attachments.contains_key(&attachment),
            "Remote Surface already has four active attachments."
        );
        self.attachments
            .entry(attachment.clone())
            .and_modify(|member| member.viewport = command["viewport"].clone())
            .or_insert_with(|| Attachment {
                viewport: command["viewport"].clone(),
                route: self.endpoint.register(
                    attachment.clone(),
                    epoch,
                    self.owner.clone(),
                    self.server.clone(),
                ),
                incoming: None,
                outgoing: HashMap::new(),
                source: None,
                input: None,
                closing: None,
                inventory_request: None,
                icon_requests: VecDeque::new(),
                resolving_icons: false,
            });
        self.publish(Some(&attachment));
        Ok(())
    }

    fn command(&mut self, command: &Value, epoch: u64) -> Result<Effect> {
        ensure!(
            self.shared.outgoing.stream_current(epoch),
            "Desktop command authority expired."
        );
        let kind = command["type"].as_str().unwrap();
        if kind == "surface.close" {
            self.retire_inputs();
            return Ok(Effect::Close);
        }
        if kind != "surface.detach" {
            self.authorize()?;
        }
        match kind {
            "surface.attach" | "surface.configure" => {
                let source = &command["configuration"]["osSource"];
                ensure!(
                    self.guest
                        .as_ref()
                        .map_or(source.is_null(), |guest| guest.source == *source),
                    "A Linux desktop viewer cannot be retargeted."
                );
                if kind == "surface.attach" {
                    ensure!(
                        command["projectId"] == self.project,
                        "Desktop attachment belongs to another project."
                    );
                    let execution = &command["osExecution"];
                    ensure!(
                        self.guest
                            .as_ref()
                            .map_or(execution.is_null(), |guest| guest.execution == *execution),
                        "Desktop attachment belongs to another execution context."
                    );
                }
                let next = private_target(
                    self.shared,
                    self.surface,
                    &self.owner,
                    &self.server,
                    command,
                )?;
                ensure!(
                    self.guest.is_none() || next.value["kind"] == "monitor",
                    "Linux workspace viewing requires its assigned display."
                );
                ensure!(
                    next.revision >= self.desktop.revision
                        && (next.revision != self.desktop.revision || self.desktop == next),
                    "Desktop configuration revision is stale."
                );
                let changed = next.value != self.desktop.value;
                if kind == "surface.attach" {
                    self.attach(command, epoch)?;
                }
                self.desktop = next;
                if changed {
                    self.restore_armed = true;
                    self.restored_window = None;
                    self.restore_failure = None;
                    self.retire_inputs();
                    self.reset_capture();
                    return Ok(Effect::Retire);
                }
            }
            "surface.detach" => {
                let attachment = id(command, "attachmentId");
                if self
                    .attachments
                    .get(attachment)
                    .is_some_and(|member| member.route.closes_on(epoch))
                {
                    self.attachments.remove(attachment);
                    self.release_controller(attachment);
                    self.input_assets();
                }
                if !self.visible() {
                    return Ok(Effect::Retire);
                }
            }
            "surface.suspend" => {
                self.retire_inputs();
                self.suspended = true;
                self.publish(None);
                return Ok(Effect::Retire);
            }
            "surface.resume" if self.suspended => {
                self.suspended = false;
                self.reset_capture();
                return Ok(Effect::Retire);
            }
            "surface.resume" => {}
            _ => bail!("Unknown desktop surface command."),
        }
        Ok(Effect::Keep)
    }

    fn reset_capture(&mut self) {
        self.status = "launching";
        self.publish(None);
    }

    fn open_capture(&self, epoch: u64) -> cantrip_history::projection::Work<Capture> {
        let scope = Scope::new(
            epoch,
            self.owner.clone(),
            self.server.clone(),
            self.surface.clone(),
        );
        let target = self
            .restored_window
            .as_ref()
            .unwrap_or(&self.desktop.value)
            .clone();
        if let Some(guest) = self.guest.clone() {
            let previews = self.shared.guest_capture.clone();
            Box::pin(async move {
                previews
                    .context("The Linux desktop capture service is unavailable.")?
                    .open_guest_capture(scope, &guest.execution, guest.generation, target)
                    .await
            })
        } else {
            let client = self.shared.capture.clone();
            Box::pin(async move {
                client
                    .context("The Host desktop capture service is unavailable.")?
                    .open(scope, target)
                    .await
            })
        }
    }

    fn restore_capture(
        &self,
        epoch: u64,
    ) -> cantrip_history::projection::Work<(Capture, Inventory)> {
        let scope = Scope::new(
            epoch,
            self.owner.clone(),
            self.server.clone(),
            self.surface.clone(),
        );
        let target = self.desktop.value.clone();
        let client = self.shared.capture.clone();
        let outgoing = self.shared.outgoing.clone();
        let encryption = self.shared.encryption.clone();
        let routes = self
            .attachments
            .values()
            .filter(|member| member.route.epoch == epoch)
            .map(|member| Arc::downgrade(&member.route))
            .collect::<Vec<_>>();
        Box::pin(async move {
            let authorize = || {
                scope.authorize(&encryption, &outgoing)?;
                ensure!(
                    routes
                        .iter()
                        .any(|route| route.upgrade().is_some_and(|r| r.alive(&outgoing))),
                    "The desktop attachment expired before launch."
                );
                Ok(())
            };
            client
                .context("The Host desktop capture service is unavailable.")?
                .restore_window(scope.clone(), target, authorize)
                .await
        })
    }

    fn sample(&self, epoch: u64, capture: Option<Arc<Capture>>, restoring: bool) -> WorkFrame {
        let restore = restoring.then(|| self.restore_capture(epoch));
        let opening = (capture.is_none() && restore.is_none()).then(|| self.open_capture(epoch));
        let width = self
            .attachments
            .values()
            .filter(|member| member.route.alive(&self.shared.outgoing))
            .map(|member| {
                (member.viewport["width"].as_f64().unwrap()
                    * member.viewport["devicePixelRatio"].as_f64().unwrap())
                .round() as u32
            })
            .fold(640, u32::max)
            .min(1920);
        let width = (f64::from(width) * self.tuner.scale).round().max(480.0) as u32;
        let quality = self.tuner.quality;
        Box::pin(async move {
            let (capture, inventory) = if let Some(restore) = restore {
                let (capture, inventory) = restore.await?;
                (Arc::new(capture), Some(inventory))
            } else if let Some(opening) = opening {
                (Arc::new(opening.await?), None)
            } else {
                (capture.expect("retained desktop capture"), None)
            };
            let frame = capture.frame().await?;
            let permit = ENCODERS.acquire().await?;
            let image = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                encode(frame, width, quality)
            })
            .await??;
            Ok((capture, image, inventory))
        })
    }

    fn control(
        &mut self,
        frame: &Frame,
        source: &FrameSource,
        capture: Option<&Arc<Capture>>,
    ) -> Result<()> {
        self.authorize()?;
        let header = frame.header();
        let attachment = id(header, "attachmentId");
        let member = self
            .attachments
            .get_mut(attachment)
            .context("Desktop attachment is not active.")?;
        let sequence = header["sequence"].as_u64().unwrap();
        ensure!(
            member.route.receives(source, &self.shared.outgoing)
                && member.incoming.is_none_or(|previous| sequence > previous),
            "Desktop control sequence expired."
        );
        let clear = open_remote_surface(
            &self.shared.encryption,
            &stream(
                &self.server,
                self.surface,
                attachment,
                "client-to-worker",
                "control",
                sequence,
            ),
            frame.payload(),
        )?;
        let message = parse_json_text(std::str::from_utf8(&clear)?)
            .map_err(|_| anyhow!("Invalid desktop control JSON."))?;
        let kind = message["type"].as_str();
        let data = match kind {
            Some("viewport") => checked("remoteSurfaceViewportSchema", &message["viewport"])?,
            Some("stream-feedback") => checked("remoteDesktopStreamFeedbackSchema", &message)?,
            Some("input-cancel") => checked("remoteDesktopViewerInputCancelSchema", &message)?,
            Some("desktop-control") => checked("remoteDesktopViewerControlSchema", &message)?,
            Some("pointer") => checked("remoteDesktopViewerPointerSchema", &message)?,
            Some("key") => checked("remoteDesktopViewerKeySchema", &message)?,
            Some("clipboard") => checked("remoteDesktopViewerClipboardSchema", &message)?,
            Some("refresh-targets") => Value::Null,
            Some("request-target-icons") => {
                checked("remoteDesktopViewerTargetIconsSchema", &message)?
            }
            _ => bail!("Desktop control is unavailable."),
        };
        ensure!(
            member.route.receives(source, &self.shared.outgoing),
            "Desktop control authority expired."
        );
        member.incoming = Some(sequence);
        match kind {
            Some("viewport") => {
                member.viewport = data;
                let fresh = member
                    .source
                    .as_ref()
                    .is_none_or(|old| !member.route.receives(old, &self.shared.outgoing));
                if fresh {
                    member.stop_input();
                    member.source = Some(source.clone());
                    self.release_controller(attachment);
                    self.publish(Some(attachment));
                    self.publish_control(Some(attachment));
                    if let Some(capture) = capture {
                        self.start_input(attachment, capture);
                    }
                }
            }
            Some("desktop-control") => {
                if let Err(error) = self.guest_control(attachment, &data, capture) {
                    let epoch = self.attachments[attachment]
                        .input
                        .as_ref()
                        .map(|input| input.epoch.clone());
                    self.input_state(Some(attachment), epoch.as_deref(), Some(&error.to_string()));
                    self.publish_control(Some(attachment));
                }
            }
            Some("stream-feedback") => self.tuner.feedback(&data, self.fps),
            Some("refresh-targets") => {
                if self.guest.is_none() && capture.is_none() && !self.restoring {
                    self.restore_armed = true;
                    self.restore_failure = None;
                }
                self.refresh_inventory(attachment, source, sequence, capture.map(Arc::as_ref))?;
            }
            Some("request-target-icons") => {
                ensure!(
                    member.icon_requests.len() < ICON_BATCHES_PER_VIEWER,
                    "Desktop icon requests are busy."
                );
                member
                    .icon_requests
                    .push_back((source.clone(), data["keys"].clone()));
                self.start_icon_jobs();
            }
            Some("input-cancel") => {
                if member
                    .input
                    .as_ref()
                    .is_some_and(|input| data["inputEpoch"] == input.epoch)
                {
                    self.stop_input(attachment, None);
                    if let Some(capture) = capture {
                        self.start_input(attachment, capture);
                    }
                }
            }
            _ => self.viewer_input(attachment, data, clear.len(), source)?,
        }
        Ok(())
    }

    fn start_icon_jobs(&mut self) {
        for (attachment, member) in &mut self.attachments {
            if self.icon_jobs.len() >= 4 {
                break;
            }
            if member.resolving_icons {
                continue;
            }
            let route = &member.route;
            let Some((source, keys)) = std::iter::from_fn(|| member.icon_requests.pop_front())
                .find(|(source, _)| route.receives(source, &self.shared.outgoing))
            else {
                continue;
            };
            member.resolving_icons = true;
            let attachment = attachment.clone();
            let route = Arc::downgrade(&member.route);
            let scope = Scope::new(
                member.route.epoch,
                self.owner.clone(),
                self.server.clone(),
                self.surface.clone(),
            );
            // The assigned guest shares one monitor and has no Host icon list.
            let captures = if self.guest.is_none() {
                self.shared.capture.clone()
            } else {
                None
            };
            let store = self.shared.icons.clone();
            self.icon_jobs.spawn(async move {
                let inventory = match captures {
                    Some(captures) => captures.inventory(scope).await.unwrap_or_default(),
                    None => Inventory::default(),
                };
                let icons = store.resolve(&inventory, &keys).await;
                IconReply {
                    attachment,
                    route,
                    source,
                    icons,
                }
            });
        }
    }

    fn finish_icons(&mut self, reply: IconReply) {
        let Some(member) = self.attachments.get_mut(&reply.attachment) else {
            return;
        };
        if !Weak::ptr_eq(&reply.route, &Arc::downgrade(&member.route)) {
            return;
        }
        member.resolving_icons = false;
        if member.route.receives(&reply.source, &self.shared.outgoing) {
            self.send_message(
                Some(&reply.attachment),
                &json!({"type":"desktop-target-icons","icons":reply.icons}),
            );
        }
    }

    fn refresh_inventory(
        &mut self,
        attachment: &JsString,
        source: &FrameSource,
        sequence: u64,
        capture: Option<&Capture>,
    ) -> Result<()> {
        if self.guest.is_some() {
            let result = capture
                .context("The assigned Linux desktop is unavailable.")
                .and_then(Capture::inventory);
            return self.publish_inventory(attachment, result, capture);
        }

        let member = self.attachments.get_mut(attachment).unwrap();
        if member.inventory_request.is_some() {
            return Ok(());
        }
        ensure!(
            self.inventories.len() < 4,
            "Desktop target inventory is busy."
        );
        let client = self
            .shared
            .capture
            .clone()
            .context("Host desktop capture is unavailable.")?;
        let scope = Scope::new(
            member.route.epoch,
            self.owner.clone(),
            self.server.clone(),
            self.surface.clone(),
        );
        let route = Arc::downgrade(&member.route);
        let attachment = attachment.clone();
        let source = source.clone();
        member.inventory_request = Some(sequence);
        self.inventories.spawn(async move {
            let result = client.inventory(scope).await;
            InventoryRefresh {
                attachment,
                route,
                source,
                sequence,
                result,
            }
        });
        Ok(())
    }

    fn finish_inventory(&mut self, refresh: InventoryRefresh, capture: Option<&Capture>) {
        let Some(member) = self.attachments.get_mut(&refresh.attachment) else {
            return;
        };
        if !Weak::ptr_eq(&refresh.route, &Arc::downgrade(&member.route))
            || member.inventory_request != Some(refresh.sequence)
        {
            return;
        }
        member.inventory_request = None;
        if member
            .route
            .receives(&refresh.source, &self.shared.outgoing)
        {
            let _ = self.publish_inventory(&refresh.attachment, refresh.result, capture);
        }
    }

    fn publish_inventory(
        &mut self,
        attachment: &JsString,
        result: Result<Inventory>,
        capture: Option<&Capture>,
    ) -> Result<()> {
        let message = match result {
            Ok(inventory) => {
                self.last_inventory = inventory;
                None
            }
            Err(error) => {
                let message = format!("Could not refresh desktop targets: {error}");
                Some(message.chars().take(512).collect::<String>())
            }
        };
        let message = message
            .as_deref()
            .or(self.restore_failure.as_deref())
            .map(str::to_owned);
        self.publish_inventory_state(Some(attachment), capture, message.as_deref())
    }

    fn publish_inventory_state(
        &mut self,
        attachment: Option<&JsString>,
        capture: Option<&Capture>,
        message: Option<&str>,
    ) -> Result<()> {
        let identity = self
            .shared
            .encryption
            .bound_component("surface-private-state", None)?;
        ensure!(
            identity.owner_id == self.owner && identity.server_id == self.server,
            "Desktop session authority changed."
        );
        let mut content = self.last_inventory.content();
        content["requested"] = self.desktop.value.clone();
        content["active"] = capture
            .map(Capture::selected_target)
            .transpose()?
            .unwrap_or(Value::Null);
        content["message"] = json!(message);
        if self.restoring {
            content["launchingApplication"] = self.desktop.value["application"].clone();
        }
        let operation: JsString = uuid::Uuid::new_v4().to_string().into();
        let protected = seal_inventory(&identity, self.surface, &operation, &content)?;
        self.send_message(
            attachment,
            &json!({
                "type":"desktop-targets","operationId":operation,"stateProtection":protected,
                "monitorCount":self.last_inventory.monitors.len(),
                "windowCount":self.last_inventory.windows.len()
            }),
        );
        Ok(())
    }

    fn guest_control(
        &mut self,
        attachment: &JsString,
        message: &Value,
        capture: Option<&Arc<Capture>>,
    ) -> Result<()> {
        ensure!(
            self.guest.is_some() && !self.suspended,
            "Guest desktop control is unavailable."
        );
        if message["operation"] == "return" {
            ensure!(
                self.controller.as_ref().is_some_and(|controller| {
                    controller.attachment == *attachment
                        && message["leaseId"] == controller.lease.id.to_string()
                }),
                "The human control lease changed. No input was sent."
            );
            self.stop_input(
                attachment,
                Some("Viewing only. Take control to use this desktop."),
            );
            self.release_controller(attachment);
            return Ok(());
        }
        if let Some(controller) = &self.controller {
            ensure!(
                controller.attachment == *attachment,
                "Another viewer owns this desktop's control lease."
            );
            self.publish_control(Some(attachment));
            return Ok(());
        }
        let capture = capture.context("The assigned Linux display is not ready.")?;
        ensure!(
            self.attachments[attachment]
                .source
                .as_ref()
                .is_some_and(|source| self.attachments[attachment]
                    .route
                    .receives(source, &self.shared.outgoing))
                && self.status == "ready",
            "The assigned Linux display is not ready."
        );
        self.controller = Some(Controller {
            attachment: attachment.clone(),
            lease: Arc::new(capture.guest_control()?),
        });
        self.start_input(attachment, capture);
        Ok(())
    }

    fn release_controller(&mut self, attachment: &JsString) {
        if self
            .controller
            .as_ref()
            .is_some_and(|controller| controller.attachment == *attachment)
        {
            self.controller.take();
        }
    }

    fn publish_control(&mut self, only: Option<&JsString>) {
        if self.guest.is_none() {
            return;
        }
        let targets: Vec<_> = self
            .attachments
            .keys()
            .filter(|id| only.is_none_or(|only| *id == only))
            .cloned()
            .collect();
        for attachment in targets {
            let (mode, lease) = match &self.control_state {
                None => ("agent", None),
                Some(state) => (
                    if state.switching {
                        "switching"
                    } else {
                        "human"
                    },
                    self.controller
                        .as_ref()
                        .filter(|current| {
                            current.lease.id == state.id && current.attachment == attachment
                        })
                        .map(|_| state.id.to_string()),
                ),
            };
            self.send_message(Some(&attachment), &json!({
                "type":"desktop-control","mode":mode,"isController":lease.is_some(),"leaseId":lease
            }));
        }
    }

    fn start_input(&mut self, attachment: &JsString, capture: &Arc<Capture>) {
        let member = self.attachments.get_mut(attachment).unwrap();
        let Some(source) = member.source.clone() else {
            return;
        };
        if self.suspended
            || member.input.is_some()
            || !member.route.receives(&source, &self.shared.outgoing)
        {
            return;
        }
        let control = self
            .controller
            .as_ref()
            .filter(|controller| controller.attachment == *attachment)
            .map(|controller| controller.lease.clone());
        if !capture.supports_host_input() && control.is_none() {
            self.input_state(
                Some(attachment),
                None,
                Some(if self.guest.is_some() {
                    "Viewing only. Take control to use this desktop."
                } else {
                    "Select a window for independent input. Display sharing is view-only."
                }),
            );
            return;
        }
        let route = Arc::downgrade(&member.route);
        let outgoing = self.shared.outgoing.clone();
        let allowed = Arc::new(move || {
            route.upgrade().is_some_and(|route| {
                outgoing.stream_current(route.epoch) && route.receives(&source, &outgoing)
            })
        });
        member.input = Some(Viewer::start(
            &mut self.inputs,
            self.updates.clone(),
            capture.clone(),
            self.shared.encryption.worker_id().clone(),
            attachment.clone(),
            input::Authority { allowed, control },
            member.closing.take(),
        ));
    }

    fn input_update(&mut self, change: Update) {
        let Some(member) = self.attachments.get_mut(&change.attachment) else {
            return;
        };
        let Some(input) = member
            .input
            .as_mut()
            .filter(|input| input.epoch == change.epoch)
        else {
            return;
        };
        if change.sprite.is_some() || change.clipboard.is_some() {
            if member
                .source
                .as_ref()
                .is_none_or(|source| !member.route.receives(source, &self.shared.outgoing))
            {
                self.stop_input(&change.attachment, None);
                self.release_controller(&change.attachment);
                return;
            }
        }
        if let Some(text) = change.clipboard {
            if let Ok(message) = checked(
                "remoteDesktopServerMessageSchema",
                &json!({"type":"desktop-clipboard","text":text}),
            ) {
                self.send(
                    Some(&change.attachment),
                    "clipboard",
                    message.stringify().as_bytes(),
                );
            }
        } else if let Some(sprite) = change.sprite {
            input.sprite = Some(sprite);
            self.input_state(Some(&change.attachment), Some(&change.epoch), None);
            self.input_assets();
        } else {
            self.stop_input(&change.attachment, change.message.as_deref());
            self.release_controller(&change.attachment);
        }
    }

    fn stop_input(&mut self, attachment: &JsString, message: Option<&str>) {
        if self
            .attachments
            .get_mut(attachment)
            .is_some_and(Attachment::stop_input)
        {
            self.input_state(Some(attachment), None, message);
            self.input_assets();
        }
    }

    fn retire_inputs(&mut self) {
        self.controller.take();
        let mut changed = false;
        for member in self.attachments.values_mut() {
            changed |= member.stop_input();
        }
        if changed {
            self.input_assets();
            self.input_state(None, None, None);
        }
    }

    fn prune(&mut self) {
        let before = self.attachments.len();
        self.attachments
            .retain(|_, member| member.route.alive(&self.shared.outgoing));
        let mut changed = self.attachments.len() != before;
        for member in self.attachments.values_mut() {
            if member.source.as_ref().is_some_and(|source| {
                !member.route.receives(source, &self.shared.outgoing)
                    || !self.shared.outgoing.stream_current(member.route.epoch)
            }) {
                member.source.take();
                changed |= member.stop_input();
            }
        }
        if changed {
            self.input_assets();
        }
        if self.controller.as_ref().is_some_and(|controller| {
            self.attachments
                .get(&controller.attachment)
                .is_none_or(|member| member.source.is_none())
        }) {
            self.controller.take();
        }
    }

    fn viewer_input(
        &mut self,
        attachment: &JsString,
        value: Value,
        bytes: usize,
        source: &FrameSource,
    ) -> Result<()> {
        ensure!(!self.suspended, "Desktop input is suspended.");
        let member = self.attachments.get_mut(attachment).unwrap();
        ensure!(
            member
                .source
                .as_ref()
                .is_some_and(|bound| member.route.receives(bound, &self.shared.outgoing))
                && member.route.receives(source, &self.shared.outgoing),
            "Desktop input route expired."
        );
        let viewer = member
            .input
            .as_mut()
            .filter(|viewer| viewer.sprite.is_some())
            .context("Desktop input is unavailable.")?;
        let sequence = value["inputSequence"]
            .as_u64()
            .filter(|sequence| *sequence > viewer.sequence && value["inputEpoch"] == viewer.epoch)
            .context("Desktop input epoch or sequence expired.")?;
        viewer.sequence = sequence;
        let (width, height, _) = self.dimensions;
        let click = value["event"] == "down";
        let position = (value["type"] == "pointer").then(|| {
            (
                (value["x"].as_f64().unwrap() / f64::from(width)).min(1.0),
                (value["y"].as_f64().unwrap() / f64::from(height)).min(1.0),
            )
        });
        if !viewer.enqueue(input::Command {
            value,
            bytes,
            pixels: (width, height),
            logical: self.logical,
        }) {
            self.stop_input(attachment, Some(input::FAILED));
            self.release_controller(attachment);
            return Ok(());
        }
        if let Some((x, y)) = position {
            viewer.position = position;
            let id = viewer.epoch.clone();
            self.send_message(
                None,
                &json!({"type":"desktop-cursor","id":id,"x":x,"y":y,"click":click}),
            );
        }
        Ok(())
    }

    fn input_state(
        &mut self,
        recipient: Option<&JsString>,
        epoch: Option<&str>,
        message: Option<&str>,
    ) {
        self.send_message(
            recipient,
            &json!({"type":"desktop-input","epoch":epoch,"message":message}),
        );
    }

    fn input_assets(&mut self) {
        let participants = self
            .attachments
            .values()
            .filter_map(|member| {
                let viewer = member.input.as_ref()?;
                Some(json!({"id":viewer.epoch,"sprite":viewer.sprite.as_ref()?}))
            })
            .collect::<Vec<_>>();
        self.send_message(
            None,
            &json!({"type":"desktop-cursor-assets","participants":participants}),
        );
        let positions = self
            .attachments
            .values()
            .filter_map(|member| {
                let viewer = member.input.as_ref()?;
                let (x, y) = viewer.position?;
                Some(json!({"type":"desktop-cursor","id":viewer.epoch,"x":x,"y":y,"click":false}))
            })
            .collect::<Vec<_>>();
        for position in positions {
            self.send_message(None, &position);
        }
    }

    fn send_message(&mut self, only: Option<&JsString>, message: &Value) {
        if let Ok(value) = checked("remoteDesktopServerMessageSchema", message) {
            self.send(only, "control", value.stringify().as_bytes());
        }
    }

    fn publish(&mut self, only: Option<&JsString>) {
        let status = if self.suspended {
            "suspended"
        } else {
            self.status
        };
        let (width, height, encoded_width) = self.dimensions;
        let message = if status == "error" {
            self.failure.as_deref()
        } else {
            None
        };
        let value = json!({
            "type":"desktop-state","width":width,"height":height,"status":status,"message":message,
            "stream":json!({"backend":"native","targetFps":self.fps,"observedFps":self.observed,"quality":self.tuner.quality,"encodedWidth":encoded_width})
        });
        self.send_message(only, &value);
    }

    fn send(&mut self, only: Option<&JsString>, channel: &'static str, bytes: &[u8]) -> bool {
        if self.authorize().is_err() {
            return false;
        }
        let mut accepted = true;
        for (attachment, member) in &mut self.attachments {
            if only.is_some_and(|id| id != attachment) || !member.route.alive(&self.shared.outgoing)
            {
                continue;
            }
            let sequence = member.outgoing.entry(channel).or_default();
            let result = protect_remote_surface(&self.shared.encryption,
                &stream(&self.server, self.surface, attachment, "worker-to-client", channel, *sequence),
                bytes).and_then(|payload| remote_surface::create(json!({
                    "protocolVersion":1,"surfaceId":self.surface,"attachmentId":attachment,"sequence":*sequence,"channel":channel,
                }), &payload));
            if let Ok(frame) = result
                && self
                    .shared
                    .encryption
                    .bound_identity()
                    .is_ok_and(|(owner, server)| owner == self.owner && server == self.server)
                && member.route.emit(frame, &self.shared.outgoing)
            {
                *sequence += 1;
            } else {
                accepted = false;
            }
        }
        accepted
    }
}

fn private_target(
    shared: &Shared,
    surface: &JsString,
    owner: &JsString,
    server: &Value,
    command: &Value,
) -> Result<Target> {
    ensure!(
        command["configuration"]["kind"] == "desktop" && command["serverId"] == *server,
        "Invalid desktop source or authority."
    );
    let resource = command["stateResource"]
        .as_str()
        .filter(|value| matches!(*value, "remote-desktop-row" | "remote-desktop-surface"))
        .context("Desktop state resource is invalid.")?;
    let opened = open_private_state(
        &shared.encryption,
        owner,
        &json!({"serverId":server,"resource":resource,"resourceId":surface,"operationId":Value::Null,"recordKind":"remote-desktop-state"}),
        &command["stateProtection"],
    )?;
    let revision = command["stateRevision"]
        .as_u64()
        .filter(|&revision| opened["revision"].as_u64() == Some(revision))
        .context("Desktop state revision is stale.")?;
    Ok(Target {
        revision,
        value: opened["target"].clone(),
    })
}

fn stream(
    server: &Value,
    surface: &JsString,
    attachment: &JsString,
    direction: &str,
    channel: &str,
    sequence: u64,
) -> Value {
    json!({"serverId":server,"surfaceKind":"desktop","surfaceId":surface,"attachmentId":attachment,
        "direction":direction,"channel":channel,"sequence":sequence})
}

async fn release(capture: Arc<Capture>) {
    if let Some(capture) = Arc::into_inner(capture) {
        capture.close().await;
    }
}

#[derive(Clone, Copy)]
struct Tuner {
    quality: u8,
    scale: f64,
    lowest: u8,
    highest: u8,
    min_scale: f64,
    target_bps: f64,
    average_bps: f64,
}

impl Tuner {
    fn new(profile: Option<&str>) -> Self {
        let (quality, lowest, highest, min_scale, target_bps) = match profile {
            Some("data-saver") => (40, 24, 52, 0.4, 4_000_000.0),
            Some("balanced") => (58, 34, 70, 0.6, 10_000_000.0),
            Some("sharp") => (78, 52, 86, 0.8, 30_000_000.0),
            _ => (62, 28, 78, 0.55, 16_000_000.0),
        };
        Self {
            quality,
            lowest,
            highest,
            min_scale,
            target_bps,
            scale: 1.0,
            average_bps: 0.0,
        }
    }
    fn record(&mut self, bytes: usize, fps: u32, accepted: bool) {
        let instantaneous = bytes as f64 * 8.0 * f64::from(fps);
        self.average_bps = if self.average_bps > 0.0 {
            self.average_bps * 0.8 + instantaneous * 0.2
        } else {
            instantaneous
        };
        if !accepted {
            self.decrease(8, 0.12);
        } else if self.average_bps > self.target_bps * 1.12 {
            self.decrease(3, 0.05);
        } else if self.average_bps < self.target_bps * 0.68 {
            self.increase(2, 0.03);
        }
    }

    fn feedback(&mut self, feedback: &Value, fps: u32) {
        let value = |key| feedback[key].as_f64().expect("validated stream feedback");
        let expected = (value("intervalMs") / 1000.0 * f64::from(fps)).max(1.0);
        let received = value("receivedFrames");
        let rendered = value("renderedFrames");
        let delivery = received / expected;
        let render = if received > 0.0 {
            rendered / received
        } else {
            0.0
        };
        let decode = value("averageDecodeMs");
        let budget = 1000.0 / f64::from(fps);
        if delivery < 0.65
            || render < 0.75
            || value("droppedFrames") > rendered * 0.25
            || decode > budget
        {
            self.decrease(6, 0.1);
        } else if delivery > 0.85 && render > 0.95 && decode < budget * 0.65 {
            self.increase(1, 0.02);
        }
    }

    fn increase(&mut self, quality: u8, scale: f64) {
        if self.scale < 1.0 {
            self.scale = (self.scale + scale).min(1.0);
        } else {
            self.quality = (self.quality + quality).min(self.highest);
        }
    }

    fn decrease(&mut self, quality: u8, scale: f64) {
        if self.quality > self.lowest {
            self.quality = self.quality.saturating_sub(quality).max(self.lowest);
        } else {
            self.scale = (self.scale - scale).max(self.min_scale);
        }
    }
}

fn attached() -> Value {
    json!({"accepted":true,"transport":"websocket"})
}

fn encode(
    frame: crate::desktop_inventory::Frame,
    requested_width: u32,
    quality: u8,
) -> Result<Image> {
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(32 * 1024 * 1024);
    limits.max_image_width = Some(frame.width);
    limits.max_image_height = Some(frame.height);
    let png = PngDecoder::with_limits(Cursor::new(frame.png), limits)?;
    ensure!(
        png.dimensions() == (frame.width, frame.height),
        "Desktop PNG dimensions changed."
    );
    let decoded = image::DynamicImage::from_decoder(png)?;
    let image = if frame.width > requested_width {
        let height = (u64::from(frame.height) * u64::from(requested_width))
            .div_ceil(u64::from(frame.width)) as u32;
        decoded.resize_exact(
            requested_width,
            height.max(1),
            image::imageops::FilterType::Triangle,
        )
    } else {
        decoded
    };
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, quality).encode_image(&image.to_rgb8())?;
    Ok(Image {
        jpeg,
        width: frame.width,
        height: frame.height,
        encoded_width: image.width(),
        logical: frame.logical,
    })
}
