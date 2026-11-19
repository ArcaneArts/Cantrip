//! Host desktop capture carried by the existing authenticated surface routing.
use super::{Callback, Endpoint, FrameSource, Route, Shared, Work, accepted, id};
use crate::{
    desktop_inventory::{Capture, Scope},
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
use std::{
    collections::HashMap,
    future::{Future, pending},
    io::Cursor,
    pin::Pin,
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{Semaphore, mpsc},
    time::{Instant, MissedTickBehavior, sleep_until},
};

struct Session<'a> {
    shared: &'a Shared,
    endpoint: &'a Endpoint,
    surface: &'a JsString,
    owner: JsString,
    server: Value,
    project: Value,
    desktop: Target,
    attachments: HashMap<JsString, Attachment>,
    fps: u32,
    tuner: Tuner,
    suspended: bool,
    status: &'static str,
    failure: Option<String>,
    observed: f64,
    dimensions: (u32, u32, u32),
}

struct Attachment {
    route: Arc<Route>,
    viewport: Value,
    incoming: Option<u64>,
    outgoing: HashMap<&'static str, u64>,
}

#[derive(PartialEq)]
struct Target {
    revision: u64,
    value: Value,
}

struct Image {
    jpeg: Vec<u8>,
    width: u32,
    height: u32,
    encoded_width: u32,
}

static ENCODERS: Semaphore = Semaphore::const_new(2);

type WorkFrame = Pin<Box<dyn Future<Output = Result<(Arc<Capture>, Image)>> + Send>>;

pub(super) async fn run(
    shared: &Shared,
    endpoint: &Endpoint,
    surface: &JsString,
    input: &mut mpsc::Receiver<Work>,
    opening: Value,
    epoch: u64,
    done: Callback,
) -> Result<()> {
    let mut active = match Session::begin(shared, endpoint, surface, &opening, epoch) {
        Ok(value) => value,
        Err(error) => {
            let _ = done.send(Err(error));
            return Ok(());
        }
    };
    let _ = done.send(Ok(attached()));

    let mut capture: Option<Arc<Capture>> = None;
    let mut work: Option<WorkFrame> = None;
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
                        let result = active.command(&value, epoch);
                        if result.as_ref().is_ok_and(|effect| *effect != Effect::Keep) {
                            drop(work.take());
                            if let Some(capture) = capture.take() {
                                release(capture).await;
                            }
                            losses = 0;
                            due = Instant::now();
                        }
                        let end = result.as_ref().is_ok_and(|effect| *effect == Effect::Close);
                        let response = result.map(|_| if value["type"] == "surface.attach" { attached() } else { accepted() });
                        let _ = done.send(response);
                        if end { break; }
                    }
                    Some(Work::Frame { frame, source }) => { let _ = active.control(&frame, &source); }
                    Some(Work::Refresh(attachment)) => active.publish(Some(&attachment)),
                    Some(Work::AgentBorrow { done, .. }) => {
                        let _ = done.send(Err(anyhow!("This surface is a desktop.")));
                    }
                    Some(Work::AgentPresentation(_)) => {}
                }
            },
            result = async {
                match &mut work {
                    Some(work) => work.await,
                    None => pending().await,
                }
            } => {
                work = None;
                active.authorize()?;
                match result {
                    Ok((lease, image)) if active.visible() => {
                        capture = Some(lease);
                        let dimensions = (image.width, image.height, image.encoded_width);
                        if active.status != "ready" || active.dimensions != dimensions {
                            active.dimensions = dimensions;
                            active.status = "ready";
                            active.publish(None);
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
                    Ok((lease, _)) => release(lease).await,
                    Err(error) if active.visible() => {
                        if let Some(lease) = capture.take() {
                            release(lease).await;
                        }
                        losses = losses.saturating_add(1);
                        if active.status != "error" {
                            active.status = "error";
                            active.failure = Some(error.to_string().chars().take(512).collect());
                            active.publish(None);
                        }
                        due = Instant::now() + Duration::from_millis((250 * (1 << (losses-1).min(5))).min(5000));
                    }
                    Err(_) => {}
                }
            },
            _ = check.tick() => {
                active.authorize()?;
                active.attachments.retain(|_, member| member.route.alive(&active.shared.outgoing));
                if !active.visible() {
                    drop(work.take());
                    if let Some(capture) = capture.take() {
                        release(capture).await;
                    }
                }
            },
            _ = sleep_until(due), if work.is_none() && active.visible() => {
                let Some(epoch) = active.stream_epoch() else { continue };
                started = Instant::now();
                work = Some(active.sample(epoch, capture.clone()));
            },
        }
    }
    drop(work);
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
    ) -> Result<Self> {
        let owner = shared
            .encryption
            .bound_component("surface-private-state", None)?;
        let target = private_target(shared, surface, &owner.owner_id, &owner.server_id, incoming)?;
        let settings = &incoming["desktopStream"];
        let mut active = Self {
            shared,
            endpoint,
            surface,
            owner: owner.owner_id,
            server: owner.server_id,
            project: incoming["projectId"].clone(),
            desktop: target,
            attachments: HashMap::new(),
            fps: settings["targetFps"].as_u64().unwrap_or(30) as u32,
            tuner: Tuner::new(settings["quality"].as_str()),
            suspended: false,
            status: "launching",
            failure: None,
            observed: 0.0,
            dimensions: (1, 1, 1),
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
        self.attachments
            .retain(|_, member| member.route.alive(&self.shared.outgoing));
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
            return Ok(Effect::Close);
        }
        if kind != "surface.detach" {
            self.authorize()?;
        }
        match kind {
            "surface.attach" | "surface.configure" => {
                if kind == "surface.attach" {
                    ensure!(
                        command["projectId"] == self.project,
                        "Desktop attachment belongs to another project."
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
                }
                if !self.visible() {
                    return Ok(Effect::Retire);
                }
            }
            "surface.suspend" => {
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

    fn sample(&self, epoch: u64, capture: Option<Arc<Capture>>) -> WorkFrame {
        let client = self
            .shared
            .capture
            .as_ref()
            .expect("desktop capture service")
            .clone();
        let scope = Scope::new(
            epoch,
            self.owner.clone(),
            self.server.clone(),
            self.surface.clone(),
        );
        let target = self.desktop.value.clone();
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
            let capture = match capture {
                Some(capture) => capture,
                None => Arc::new(client.open(scope, target).await?),
            };
            let frame = capture.frame().await?;
            let permit = ENCODERS.acquire().await?;
            let image = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                encode(frame, width, quality)
            })
            .await??;
            Ok((capture, image))
        })
    }

    fn control(&mut self, frame: &Frame, source: &FrameSource) -> Result<()> {
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
            _ => bail!("Desktop control is unavailable."),
        };
        ensure!(
            member.route.receives(source, &self.shared.outgoing),
            "Desktop control authority expired."
        );
        member.incoming = Some(sequence);
        if kind == Some("viewport") {
            member.viewport = data;
        } else {
            self.tuner.feedback(&data, self.fps);
        }
        Ok(())
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
        if let Ok(value) = checked("remoteDesktopServerMessageSchema", &value) {
            self.send(only, "control", value.stringify().as_bytes());
        }
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
        command["configuration"]["kind"] == "desktop"
            && command["configuration"]["osSource"].is_null()
            && command["osExecution"].is_null()
            && command["serverId"] == *server,
        "Invalid Host desktop source or authority."
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
    })
}
