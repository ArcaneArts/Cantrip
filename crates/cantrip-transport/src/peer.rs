//! Outgoing peer queue and close lifetime. Identity values are metadata;
//! callers perform enrollment, authentication, and continuity fencing.
use crate::output::{Buffered, Queued};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc, watch};
use uuid::Uuid;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Continuity {
    pub owner: String,
    pub credential: String,
    pub process_generation: String,
}
pub enum Outgoing {
    Text(Queued<String>),
    Binary(Queued<cantrip_framing::worker_link::Frame>),
    Tunnel(Queued<cantrip_framing::tunnel::Frame>),
    Surface(Queued<cantrip_framing::remote_surface::Frame>),
    Close(u16, String),
}
pub struct Peer {
    pub id: Uuid,
    pub identity: Continuity,
    pub continuity: Option<Continuity>,
    pub open: AtomicBool,
    pub output: mpsc::UnboundedSender<Outgoing>,
    pub closing: watch::Sender<Option<(u16, String)>>,
    output_order: Mutex<()>,
    close_started: Mutex<Option<tokio::time::Instant>>,
    buffered: Buffered,
}
impl Peer {
    pub fn new(identity: Continuity) -> (Arc<Self>, mpsc::UnboundedReceiver<Outgoing>) {
        Self::with_continuity(identity, true)
    }
    pub fn legacy(identity: Continuity) -> (Arc<Self>, mpsc::UnboundedReceiver<Outgoing>) {
        Self::with_continuity(identity, false)
    }
    fn with_continuity(
        identity: Continuity,
        asserted: bool,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<Outgoing>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Arc::new(Self {
                id: Uuid::new_v4(),
                continuity: asserted.then(|| identity.clone()),
                identity,
                open: AtomicBool::new(true),
                output: tx,
                closing: watch::channel(None).0,
                output_order: Mutex::new(()),
                close_started: Mutex::new(None),
                buffered: Buffered::default(),
            }),
            rx,
        )
    }
    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::Acquire) && !self.output.is_closed()
    }
    pub fn buffered_amount(&self) -> usize {
        self.buffered.bytes()
    }
    pub fn send_text(&self, text: String) -> bool {
        let _order = self.output_order.lock().unwrap();
        if !self.is_open() {
            return false;
        }
        let bytes = crate::output::framed_size(text.len());
        self.output
            .send(Outgoing::Text(self.buffered.reserve(text, bytes)))
            .is_ok()
    }
    pub fn send_frame(&self, frame: cantrip_framing::worker_link::Frame) -> bool {
        let _order = self.output_order.lock().unwrap();
        if !self.is_open() {
            return false;
        }
        let bytes = crate::output::framed_size(frame.bytes().len());
        let Some(queued) = self.buffered.bounded(frame, bytes, 8 * 1024 * 1024) else {
            return false;
        };
        self.output.send(Outgoing::Binary(queued)).is_ok()
    }
    pub fn close(&self, code: u16, reason: &str) {
        let _order = self.output_order.lock().unwrap();
        if self.open.swap(false, Ordering::AcqRel) {
            *self.close_started.lock().unwrap() = Some(tokio::time::Instant::now());
            self.closing.send_replace(Some((code, reason.into())));
            let _ = self.output.send(Outgoing::Close(code, reason.into()));
        }
    }
    /// 1005 represents an absent status locally; it must never be put on wire.
    pub fn close_empty(&self) {
        self.close(1005, "");
    }
    pub fn close_deadline(&self) -> Option<tokio::time::Instant> {
        self.close_started
            .lock()
            .unwrap()
            .map(|at| at + Duration::from_secs(30))
    }
}
impl Peer {
    pub fn send_surface_frame(&self, frame: cantrip_framing::remote_surface::Frame) -> bool {
        let _order = self.output_order.lock().unwrap();
        if !self.is_open() {
            return false;
        }
        let bytes = crate::output::framed_size(frame.bytes().len());
        self.output
            .send(Outgoing::Surface(self.buffered.reserve(frame, bytes)))
            .is_ok()
    }
}
impl Peer {
    pub fn send_tunnel_frame(&self, frame: cantrip_framing::tunnel::Frame) -> bool {
        let _order = self.output_order.lock().unwrap();
        if !self.is_open() {
            return false;
        }
        let bytes = crate::output::framed_size(frame.bytes().len());
        let Some(queued) = self.buffered.bounded(frame, bytes, 8 * 1024 * 1024) else {
            return false;
        };
        self.output.send(Outgoing::Tunnel(queued)).is_ok()
    }
}
