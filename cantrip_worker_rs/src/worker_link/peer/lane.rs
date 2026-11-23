use super::super::{Coordinator, carrier::Output};
use super::PeerRoute;
use anyhow::{Context, Result, ensure};
use bytes::BytesMut;
use cantrip_framing::worker_link::{self as wire, Frame};
use cantrip_transport::output::{Buffered, Queued};
use cantrip_wire::Value;
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Notify, mpsc},
    time::{Instant, MissedTickBehavior, interval},
};
use webrtc::data_channel::{DataChannel, DataChannelEvent, RTCDataChannelState};

pub(super) const CONTROL: &str = "cantrip-worker-link-v1:control";
const PREFIX: &str = "cantrip-worker-link-v1:lane:";
pub(super) const LANES: [&str; 5] = ["events", "interactive", "stream", "realtime", "bulk"];
const READY: u8 = (1 << LANES.len()) - 1;
pub(super) const MAX_MESSAGE: usize = 8 + wire::MAX_HEADER_BYTES + wire::MAX_PAYLOAD_BYTES;
pub(super) type Queue = mpsc::Receiver<Queued<BytesMut>>;

pub(in crate::worker_link) struct PeerCarrier {
    session: Value,
    route: PeerRoute,
    authenticated: AtomicBool,
    closed: AtomicBool,
    open: AtomicU8,
    message_limit: AtomicUsize,
    pub(super) changed: Notify,
    lanes: [Lane; LANES.len()],
}

struct Lane {
    queued: Buffered,
    sender: mpsc::Sender<Queued<BytesMut>>,
    limit: usize,
    max_rate: usize,
    rate: Mutex<(Instant, usize)>,
    blocked: AtomicBool,
}

pub(in crate::worker_link) fn index(label: &str) -> Option<usize> {
    LANES.iter().position(|&lane| lane == label)
}

pub(super) fn from_label(label: &str) -> Option<usize> {
    label.strip_prefix(PREFIX).and_then(index)
}

impl PeerCarrier {
    pub(super) fn new(
        session: Value,
        config: &Value,
        route: PeerRoute,
    ) -> (Arc<Self>, [Option<Queue>; LANES.len()]) {
        let mut queues = std::array::from_fn(|_| None);
        let lanes = std::array::from_fn(|i| {
            let limits = &config["laneLimits"][LANES[i]];
            let (sender, receiver) =
                mpsc::channel(limits["maxQueuedFrames"].as_u64().unwrap() as usize);
            queues[i] = Some(receiver);
            Lane {
                sender,
                queued: Buffered::default(),
                limit: limits["maxQueuedBytes"].as_u64().unwrap() as usize,
                max_rate: limits["maxBytesPerSecond"].as_u64().unwrap() as usize,
                rate: Mutex::new((Instant::now(), 0)),
                blocked: AtomicBool::new(false),
            }
        });
        let carrier = Self {
            session,
            route,
            authenticated: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            open: AtomicU8::new(0),
            message_limit: AtomicUsize::new(MAX_MESSAGE),
            changed: Notify::new(),
            lanes,
        };
        (Arc::new(carrier), queues)
    }

    pub fn route(&self) -> PeerRoute {
        self.route
    }

    pub(super) fn authenticated(&self) -> bool {
        self.authenticated.load(Ordering::Acquire)
    }

    pub(super) fn authenticate(&self) {
        self.authenticated.store(true, Ordering::Release);
    }

    pub(super) fn set_message_limit(&self, bytes: u32) {
        let limit = if bytes == 0 {
            MAX_MESSAGE
        } else {
            MAX_MESSAGE.min(bytes as usize)
        };
        self.message_limit.store(limit, Ordering::Release);
    }

    pub fn message_limit(&self, lane: usize) -> usize {
        let output = &self.lanes[lane];
        self.message_limit
            .load(Ordering::Acquire)
            .min(output.limit)
            .min(output.max_rate)
    }

    pub(super) fn ready(&self) -> bool {
        self.authenticated() && self.open.load(Ordering::Acquire) == READY
    }

    pub(super) fn close(&self) {
        self.closed.store(true, Ordering::Release);
    }

    pub fn permits(&self, header: &Value) -> bool {
        self.authenticated()
            && !self.closed.load(Ordering::Acquire)
            && header["sessionId"] == self.session["sessionId"]
            && header["routeGeneration"] == self.session["routeGeneration"]
            && header["effectiveRoute"] == self.session["route"]
    }

    pub fn offer(&self, frame: &Frame) -> Output {
        if !self.permits(frame.header()) {
            return Output::Closed;
        }
        let lane =
            index(frame.header()["lane"].as_str().unwrap()).expect("validated WorkerLink lane");
        if frame.bytes().len() > self.message_limit(lane) {
            return Output::Closed;
        }
        let output = &self.lanes[lane];
        if self.open.load(Ordering::Acquire) & (1 << lane) == 0 {
            output.blocked.store(true, Ordering::Release);
            return Output::Pending;
        }
        output.offer(frame)
    }

    pub(super) async fn run_lane(
        self: Arc<Self>,
        lane: usize,
        channel: Arc<dyn DataChannel>,
        mut queue: Queue,
        gateway: Weak<Coordinator>,
    ) -> Result<()> {
        let output = &self.lanes[lane];
        if channel.ready_state().await? == RTCDataChannelState::Open {
            self.open_lane(lane);
        }
        let mut retained = VecDeque::<(usize, Queued<BytesMut>)>::new();
        let mut retained_bytes = 0usize;
        let mut tick = interval(Duration::from_millis(20));
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                message = channel.poll() => match message {
                    Some(DataChannelEvent::OnOpen) => self.open_lane(lane),
                    Some(DataChannelEvent::OnMessage(message)) => {
                        ensure!(!message.is_string && message.data.len() <= MAX_MESSAGE, "Invalid WorkerLink peer frame.");
                        let frame = wire::decode(message.data.as_ref().into())?;
                        ensure!(self.permits(frame.header()) && frame.header()["lane"] == LANES[lane], "WorkerLink peer frame authority is stale.");
                        let gateway = gateway.upgrade().context("WorkerLink gateway stopped.")?;
                        gateway.handle_peer_frame(&self, &frame);
                    }
                    Some(DataChannelEvent::OnClose | DataChannelEvent::OnClosing) | None => return Ok(()),
                    _ => {}
                },
                next = queue.recv() => {
                    let Some(mut pending) = next else { return Ok(()) };
                    let bytes = pending.take();
                    let len = bytes.len();
                    channel.send(bytes).await?;
                    retained_bytes += len;
                    retained.push_back((len, pending));
                }
                _ = tick.tick() => {
                    if !retained.is_empty() {
                        let outstanding = channel.outstanding_bytes().await?;
                        while retained.front().is_some_and(|(len, _)| *len <= retained_bytes.saturating_sub(outstanding)) {
                            retained_bytes -= retained.pop_front().expect("acknowledged data-channel output").0;
                        }
                    }
                    if output.blocked.swap(false, Ordering::AcqRel)
                        && let Some(gateway) = gateway.upgrade()
                    {
                        gateway.local_writable();
                    }
                }
            }
        }
    }

    fn open_lane(&self, lane: usize) {
        self.open.fetch_or(1 << lane, Ordering::AcqRel);
        self.changed.notify_one();
    }
}

impl Lane {
    fn offer(&self, frame: &Frame) -> Output {
        let bytes = frame.bytes();
        if self.sender.is_closed() {
            return Output::Closed;
        }
        let mut rate = self.rate.lock().unwrap();
        if rate.0.elapsed() >= Duration::from_secs(1) {
            *rate = (Instant::now(), 0);
        }
        if self.queued.bytes() + bytes.len() <= self.limit
            && rate.1 + bytes.len() <= self.max_rate
            && let Ok(slot) = self.sender.try_reserve()
        {
            slot.send(self.queued.reserve(BytesMut::from(bytes), bytes.len()));
            rate.1 += bytes.len();
            return Output::Queued;
        }
        self.blocked.store(true, Ordering::Release);
        Output::Pending
    }
}
