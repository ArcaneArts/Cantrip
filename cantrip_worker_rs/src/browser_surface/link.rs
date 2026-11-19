//! The WorkerLink binding and bounded output for one browser attachment.
use super::{Endpoint, FrameSource};
use cantrip_framing::{
    remote_surface::{self, Frame},
    worker_link::{self, Assembler, Chunk},
};
use cantrip_wire::JsString;
use chrono::Utc;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::Notify;

const MAX_INTERACTIVE_FRAMES: usize = 128;
const MAX_INTERACTIVE_BYTES: usize = 4 * 1024 * 1024;

type LaneResult<T> = Result<T, &'static str>;

pub(crate) struct Link {
    surface: JsString,
    attachment: JsString,
    endpoint: Weak<Endpoint>,
    wake: Arc<Notify>,
    state: Mutex<State>,
}

struct State {
    deadline: i64,
    closed: Option<&'static str>,
    lanes: [Queue; 2],
}

#[derive(Default)]
struct Queue {
    open: bool,
    next_frame: u32,
    bytes: usize,
    frames: VecDeque<Pending>,
}

struct Pending {
    id: u32,
    frame: Frame,
    offset: usize,
}

#[derive(Clone, Copy)]
pub(crate) enum Kind {
    Interactive = 0,
    Realtime = 1,
}

pub(crate) struct Lane {
    link: Arc<Link>,
    kind: Kind,
    active: Arc<()>,
    inbound: Option<Assembler>,
}

impl Link {
    pub(super) fn new(
        surface: JsString,
        attachment: JsString,
        endpoint: Weak<Endpoint>,
        wake: Arc<Notify>,
        deadline: i64,
    ) -> Self {
        Self {
            surface,
            attachment,
            endpoint,
            wake,
            state: Mutex::new(State {
                deadline,
                closed: None,
                lanes: Default::default(),
            }),
        }
    }

    pub(crate) fn renew(&self, deadline: i64) {
        self.state.lock().unwrap().deadline = deadline;
    }

    pub(crate) fn revoke(&self) {
        self.state.lock().unwrap().stop("revoked");
        self.wake.notify_one();
    }

    pub(crate) fn is_active(&self) -> bool {
        self.state.lock().unwrap().failure().is_none()
    }

    pub(crate) fn open(self: &Arc<Self>, kind: Kind) -> LaneResult<Lane> {
        let mut state = self.state.lock().unwrap();
        if state.failure().is_some() || state.lanes[kind as usize].open {
            return Err("resource-unavailable");
        }
        state.lanes[kind as usize].open = true;
        Ok(Lane {
            link: self.clone(),
            kind,
            active: Arc::new(()),
            inbound: matches!(kind, Kind::Interactive).then(|| Assembler::new(false)),
        })
    }

    pub(super) fn emit(&self, frame: Frame) -> bool {
        let kind = match frame.header()["channel"].as_str() {
            Some("control" | "clipboard") => Kind::Interactive,
            Some("frame" | "cursor") => Kind::Realtime,
            _ => return false,
        };
        let mut state = self.state.lock().unwrap();
        if state.failure().is_some() {
            return false;
        }
        let queue = &mut state.lanes[kind as usize];
        let bytes = frame.bytes().len();
        let admitted = match kind {
            Kind::Interactive
                if queue.frames.len() >= MAX_INTERACTIVE_FRAMES
                    || queue.bytes + bytes > MAX_INTERACTIVE_BYTES =>
            {
                state.stop("congested");
                false
            }
            Kind::Interactive => {
                queue.push(frame);
                true
            }
            Kind::Realtime => {
                // Across credit returns retain the partially sent frame and
                // only the newest successor. Realtime must not delay input.
                let keep = usize::from(queue.frames.front().is_some_and(|frame| frame.offset > 0));
                while queue.frames.len() > keep {
                    queue.bytes -= queue.frames.pop_back().unwrap().frame.bytes().len();
                }
                queue.push(frame);
                true
            }
        };
        drop(state);
        self.wake.notify_one();
        admitted
    }
}

impl Lane {
    pub(crate) fn failure(&self) -> Option<&'static str> {
        self.link.state.lock().unwrap().failure()
    }

    pub(crate) fn receive(&mut self, bytes: &[u8]) -> LaneResult<()> {
        let assembler = self.inbound.as_mut().ok_or("protocol-error")?;
        let Some(bytes) = assembler.push(bytes).map_err(|_| "protocol-error")? else {
            return Ok(());
        };
        let frame = remote_surface::decode(Arc::from(bytes)).map_err(|_| "protocol-error")?;
        let header = frame.header();
        if header["channel"] != "control"
            || header["surfaceId"].as_js_string() != Some(&self.link.surface)
            || header["attachmentId"].as_js_string() != Some(&self.link.attachment)
        {
            return Err("protocol-error");
        }
        let endpoint = self
            .link
            .endpoint
            .upgrade()
            .ok_or("endpoint-disconnected")?;
        endpoint
            .receive(
                frame,
                FrameSource::Link {
                    link: Arc::downgrade(&self.link),
                    channel: Arc::downgrade(&self.active),
                },
            )
            .then_some(())
            .ok_or("congested")
    }

    pub(crate) fn offer_chunk(&self, bytes: usize, offer: impl FnOnce(Vec<u8>) -> bool) -> bool {
        let size = bytes
            .saturating_sub(worker_link::REMOTE_CHUNK_HEADER_BYTES)
            .min(worker_link::REMOTE_CHUNK_PAYLOAD_BYTES);
        if size == 0 {
            return false;
        }
        let mut state = self.link.state.lock().unwrap();
        if state.failure().is_some() {
            return false;
        }
        let queue = &mut state.lanes[self.kind as usize];
        let Some(front) = queue.frames.front_mut() else {
            return false;
        };
        let frame = front.frame.bytes();
        let end = (front.offset + size).min(frame.len());
        let payload = worker_link::encode_chunk(&Chunk {
            frame_id: u64::from(front.id),
            frame_length: frame.len() as u64,
            offset: front.offset as u64,
            payload: &frame[front.offset..end],
        })
        .expect("bounded remote surface frame");
        if !offer(payload) {
            return false;
        }
        front.offset = end;
        if end == frame.len() {
            queue.bytes -= queue.frames.pop_front().unwrap().frame.bytes().len();
        }
        true
    }
}

impl Drop for Lane {
    fn drop(&mut self) {
        let mut state = self.link.state.lock().unwrap();
        let queue = &mut state.lanes[self.kind as usize];
        queue.open = false;
        if let Some(pending) = queue.frames.front_mut() {
            pending.offset = 0;
        }
    }
}

impl State {
    fn failure(&self) -> Option<&'static str> {
        self.closed.or_else(|| {
            (self.deadline <= Utc::now().timestamp_millis()).then_some("lifetime-expired")
        })
    }

    fn stop(&mut self, code: &'static str) {
        self.closed.get_or_insert(code);
        for queue in &mut self.lanes {
            queue.frames.clear();
            queue.bytes = 0;
        }
    }
}

impl Queue {
    fn push(&mut self, frame: Frame) {
        let id = self.next_frame;
        self.next_frame = id.wrapping_add(1);
        self.bytes += frame.bytes().len();
        self.frames.push_back(Pending {
            id,
            frame,
            offset: 0,
        });
    }
}
