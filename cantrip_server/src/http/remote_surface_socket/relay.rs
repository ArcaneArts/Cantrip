//! Legacy CTRS sequencing, accounting, quotas, and lossy frame/cursor pressure.
use super::transport::Peer;
use crate::{
    auth::service::AuthService,
    live::Socket as _,
    operations::logging::{self, LogCall},
    remote_surfaces::frame::{self, Frame},
    wire::value::json,
    workers::bridge::{OfflineSubscription, SurfaceFrameSubscription},
};
use anyhow::{Context, Result};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
struct State {
    closed: bool,
    client: HashMap<String, u64>,
    worker: HashMap<String, u64>,
    frames_client: u64,
    frames_worker: u64,
    bytes_client: u64,
    bytes_worker: u64,
    dropped: u64,
    reason: Option<&'static str>,
    frames: Option<SurfaceFrameSubscription>,
    offline: Option<OfflineSubscription>,
}
pub(super) struct Relay {
    service: Arc<AuthService>,
    peer: Arc<Peer>,
    owner: String,
    worker: String,
    surface: String,
    attachment: String,
    started: i64,
    state: Mutex<State>,
}
impl Relay {
    pub fn bind(
        service: Arc<AuthService>,
        peer: Arc<Peer>,
        owner: String,
        worker: String,
        surface: String,
        attachment: String,
    ) -> Arc<Self> {
        let relay = Arc::new(Self {
            service,
            peer,
            owner,
            worker,
            surface,
            attachment,
            started: crate::auth::now().timestamp_millis(),
            state: Mutex::new(State::default()),
        });
        let weak = Arc::downgrade(&relay);
        let frames = relay.service.workers.bridge.subscribe_surface_frames(
            &relay.worker,
            Arc::new(move |frame| {
                if let Some(relay) = weak.upgrade() {
                    relay.worker_frame(&frame)?;
                }
                Ok(())
            }),
        );
        let weak = Arc::downgrade(&relay);
        let offline = relay.service.workers.bridge.subscribe_worker_disconnect(
            &relay.worker,
            Arc::new(move || {
                if let Some(relay) = weak.upgrade() {
                    if relay.state.lock().unwrap().closed {
                        return;
                    }
                    relay.reject(
                        "worker_disconnected",
                        1013,
                        "Remote Surface worker disconnected",
                        true,
                    );
                }
            }),
        );
        {
            let mut state = relay.state.lock().unwrap();
            if !state.closed {
                state.frames = Some(frames);
                state.offline = Some(offline);
            }
        }
        logging::server_logger()(LogCall::event(
            "info",
            "Remote Surface relay active",
            json!({"event":"remote_surface.relay.active","subsystem":"remote-surface","operation":"relay","status":"started","attachmentId":relay.attachment,"surfaceId":relay.surface,"workerId":relay.worker}),
        ));
        relay
    }
    fn record(&self, ingress: bool, bytes: usize) {
        self.service
            .usage
            .record(&self.owner, "remote-surface-relay", ingress, bytes, 1, true);
    }
    fn consume(&self, bytes: usize) -> bool {
        self.service.workers.relay_quotas.consume_relay_at(
            &self.owner,
            &self.worker,
            bytes as u64,
            crate::auth::now().timestamp_millis(),
        )
    }
    fn reject(&self, reason: &'static str, code: u16, message: &str, immediate: bool) {
        self.state.lock().unwrap().reason = Some(reason);
        self.peer.close(code, message);
        if immediate {
            self.cleanup();
        }
    }
    fn worker_frame(&self, incoming: &Frame) -> Result<()> {
        // The Source relay encodes again, after its bridge decoded/validated.
        let frame = frame::create(incoming.header().clone(), incoming.payload())?;
        let header = frame.header();
        let mut state = self.state.lock().unwrap();
        if state.closed
            || header["surfaceId"] != self.surface.as_str()
            || header["attachmentId"] != self.attachment.as_str()
        {
            return Ok(());
        }
        self.record(true, frame.bytes().len());
        let channel = header["channel"]
            .as_str()
            .context("Surface frame channel")?;
        let sequence = header["sequence"]
            .as_u64()
            .context("Surface frame sequence")?;
        if state
            .worker
            .get(channel)
            .is_some_and(|last| sequence <= *last)
            || !self.peer.is_open()
        {
            return Ok(());
        }
        if !self.consume(frame.payload().len()) {
            drop(state);
            self.reject(
                "relay_quota_reached",
                1013,
                "Remote Surface relay bandwidth quota reached",
                true,
            );
            return Ok(());
        }
        if self.peer.buffered_amount() > 8 * 1024 * 1024 {
            if matches!(channel, "frame" | "cursor") {
                state.dropped += 1;
                return Ok(());
            }
            drop(state);
            self.reject(
                "client_backpressure",
                1013,
                "Remote Surface client is too slow",
                false,
            );
            return Ok(());
        }
        self.peer.binary(Arc::from(frame.bytes()))?;
        self.record(false, frame.bytes().len());
        state.frames_worker += 1;
        state.bytes_worker += frame.payload().len() as u64;
        state.worker.insert(channel.into(), sequence);
        Ok(())
    }
    pub fn message(&self, bytes: &[u8], binary: bool) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Ok(());
        }
        self.record(true, bytes.len());
        if !binary {
            drop(state);
            self.reject(
                "non_binary_frame",
                1003,
                "Remote Surface data must be binary",
                true,
            );
            return Ok(());
        }
        let frame = match frame::decode(Arc::from(bytes)) {
            Ok(frame) => frame,
            Err(_) => {
                drop(state);
                self.reject("invalid_frame", 1008, "Invalid Remote Surface frame", true);
                return Ok(());
            }
        };
        let header = frame.header();
        if header["surfaceId"] != self.surface.as_str()
            || header["attachmentId"] != self.attachment.as_str()
        {
            drop(state);
            self.reject(
                "binding_mismatch",
                1008,
                "Remote Surface binding mismatch",
                true,
            );
            return Ok(());
        }
        let channel = header["channel"]
            .as_str()
            .context("Surface frame channel")?;
        let sequence = header["sequence"]
            .as_u64()
            .context("Surface frame sequence")?;
        if state
            .client
            .get(channel)
            .is_some_and(|last| sequence <= *last)
        {
            return Ok(());
        }
        if !self.consume(frame.payload().len()) {
            drop(state);
            self.reject(
                "relay_quota_reached",
                1013,
                "Remote Surface relay bandwidth quota reached",
                true,
            );
            return Ok(());
        }
        if !self.service.workers.bridge.send_surface_frame(
            &self.worker,
            header.clone(),
            frame.payload(),
        ) {
            if matches!(channel, "frame" | "cursor") {
                state.dropped += 1;
                return Ok(());
            }
            drop(state);
            self.reject(
                "worker_unavailable_or_congested",
                1013,
                "Remote Surface worker is unavailable or congested",
                true,
            );
            return Ok(());
        }
        self.record(false, bytes.len());
        state.frames_client += 1;
        state.bytes_client += frame.payload().len() as u64;
        state.client.insert(channel.into(), sequence);
        Ok(())
    }
    pub fn cleanup(&self) {
        let (frames, offline, context) = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            state.closed = true;
            let context = json!({"event":"remote_surface.relay.closed","subsystem":"remote-surface","operation":"relay","status":"completed","reasonCode":state.reason.unwrap_or("client_closed"),"attachmentId":self.attachment,"surfaceId":self.surface,"workerId":self.worker,"durationMs":crate::auth::now().timestamp_millis()-self.started,"bytesFromClient":state.bytes_client,"bytesFromWorker":state.bytes_worker,"counts":json!({"framesFromClient":state.frames_client,"framesFromWorker":state.frames_worker,"droppedFrames":state.dropped})});
            (state.frames.take(), state.offline.take(), context)
        };
        drop(frames);
        drop(offline);
        logging::server_logger()(LogCall::event(
            "info",
            "Remote Surface relay closed",
            context,
        ));
    }
}
