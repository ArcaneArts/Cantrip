//! Keep channel output and ownership tied to the carrier that opened it.
use crate::connection::Outbound;
use bytes::Bytes;
use cantrip_framing::worker_link::Frame;
use cantrip_transport::output::{Buffered, Queued, framed_size};
use cantrip_wire::JsString;
use std::sync::{
    Arc, Weak,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::mpsc;

const MAX_BUFFER: usize = 8 * 1024 * 1024;
const LOW_WATER: usize = 256 * 1024;

#[derive(Clone)]
pub(super) enum Carrier {
    Relay,
    Local(Weak<Local>),
}

impl Carrier {
    pub fn route(&self) -> &'static str {
        match self {
            Self::Relay => "relay",
            Self::Local(_) => "local",
        }
    }

    pub fn key(&self) -> Option<*const Local> {
        match self {
            Self::Relay => None,
            Self::Local(local) => Some(local.as_ptr()),
        }
    }

    pub fn offer(&self, outbound: &Outbound, frame: &Frame) -> Output {
        match self {
            Self::Relay if outbound.binary(frame.bytes()) => Output::Queued,
            Self::Relay => Output::Pending,
            Self::Local(local) => match local.upgrade() {
                Some(local) if local.active() => local.output.offer(frame.bytes()),
                _ => Output::Closed,
            },
        }
    }
}

pub(super) struct Local {
    pub session: JsString,
    pub output: SocketOutput,
    closed: AtomicBool,
}

impl Local {
    pub fn new(session: JsString, output: SocketOutput) -> Arc<Self> {
        Arc::new(Self {
            session,
            output,
            closed: AtomicBool::new(false),
        })
    }

    pub fn active(&self) -> bool {
        !self.closed.load(Ordering::Acquire)
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
    }
}

pub(super) enum Output {
    Queued,
    Pending,
    Closed,
}

pub(super) type SocketFrames = mpsc::UnboundedReceiver<Queued<Bytes>>;

pub(super) struct SocketOutput {
    buffer: Buffered,
    writer: mpsc::UnboundedSender<Queued<Bytes>>,
}

impl SocketOutput {
    pub fn channel() -> (Self, SocketFrames) {
        let (writer, frames) = mpsc::unbounded_channel();
        (
            Self {
                buffer: Buffered::default(),
                writer,
            },
            frames,
        )
    }

    pub fn offer(&self, bytes: &[u8]) -> Output {
        let Some(queued) = self.buffer.bounded(
            Bytes::copy_from_slice(bytes),
            framed_size(bytes.len()),
            MAX_BUFFER,
        ) else {
            return Output::Pending;
        };
        match self.writer.send(queued) {
            Ok(()) => Output::Queued,
            Err(_) => Output::Closed,
        }
    }

    pub fn writable(&self) -> bool {
        self.buffer.bytes() <= LOW_WATER
    }
}
