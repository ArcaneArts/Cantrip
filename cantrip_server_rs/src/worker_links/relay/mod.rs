//! Native relay sequencing, quotas and bounded per-lane output queues. The
//! transport owns its connection handle and retires it after actual IO cleanup.
mod channels;
mod lifecycle;
mod queue;
use super::{
    Clock,
    frame::{self, Frame},
};
use crate::{
    wire::{Value, value::json},
    workers::bridge::{FrameSubscription, OfflineSubscription, WorkerBridge},
};
use indexmap::IndexMap;
use std::{
    collections::{HashSet, VecDeque},
    sync::{Arc, Mutex},
};

pub trait Socket: Send + Sync {
    fn is_open(&self) -> bool;
    fn buffered_amount(&self) -> usize;
    fn send(&self, frame: Frame) -> anyhow::Result<()>;
    fn close(&self, code: u16, reason: &str);
}
pub type Permit = Box<dyn Send + Sync>;
pub type Acquire = Arc<dyn Fn(&Value, &Value) -> anyhow::Result<Permit> + Send + Sync>;
pub type Consume = Arc<dyn Fn(&Value, &Value, usize) -> bool + Send + Sync>;
pub type Recorder = Arc<dyn Fn(&Value, &'static str, bool, usize) + Send + Sync>;
pub struct Options {
    pub lane_limits: Value,
    pub acquire_remote_surface: Option<Acquire>,
    pub consume_relay: Option<Consume>,
    pub record: Option<Recorder>,
    pub now: Clock,
    pub auto_drain: bool,
}
impl Default for Options {
    fn default() -> Self {
        let lane = |channels, frames, bytes, rate| json!({"maxChannels":channels,"maxQueuedFrames":frames,"maxQueuedBytes":bytes,"maxBytesPerSecond":rate});
        Self {
            lane_limits: json!({"events":lane(64,256,4*1024*1024,16*1024*1024),"interactive":lane(64,128,2*1024*1024,16*1024*1024),"stream":lane(256,256,16*1024*1024,128*1024*1024),"realtime":lane(64,64,4*1024*1024,64*1024*1024),"bulk":lane(32,128,16*1024*1024,64*1024*1024)}),
            acquire_remote_surface: None,
            consume_relay: None,
            record: None,
            now: Arc::new(|| chrono::Utc::now().timestamp_millis()),
            auto_drain: true,
        }
    }
}
const LANES: [&str; 5] = ["interactive", "realtime", "events", "stream", "bulk"];
const MAX_BUFFERED: usize = 8 * 1024 * 1024;
struct Channel {
    bandwidth: &'static str,
    delivered: f64,
    client_sequence: f64,
    worker_sequence: f64,
    grant: String,
    header: Value,
}
type ChannelRef = Arc<Mutex<Channel>>;
struct Queued {
    bandwidth: &'static str,
    frame: Frame,
}
#[derive(Default)]
struct Lane {
    bytes: usize,
    frames: VecDeque<Queued>,
}
struct Surface {
    channels: HashSet<String>,
    _permit: Option<Permit>,
}
struct Bindings {
    _frames: FrameSubscription,
    _offline: OfflineSubscription,
}
struct ConnectionState {
    closed: bool,
    channels: IndexMap<String, ChannelRef>,
    closing: IndexMap<String, ChannelRef>,
    lanes: IndexMap<&'static str, Lane>,
    surfaces: IndexMap<String, Surface>,
    bytes: usize,
    frames: usize,
    stalled_at: Option<i64>,
    drain_scheduled: bool,
    timer: Option<tokio::task::AbortHandle>,
    bindings: Option<Bindings>,
}
pub struct Connection {
    session: Value,
    socket: Arc<dyn Socket>,
    operation: Mutex<()>,
    state: Mutex<ConnectionState>,
}
#[derive(Default)]
struct State {
    closed: bool,
    connections: IndexMap<String, Arc<Connection>>,
}
pub struct Relay {
    bridge: Arc<WorkerBridge>,
    options: Options,
    state: Mutex<State>,
    attachment: Mutex<()>,
}
fn id(value: &Value, field: &str) -> String {
    value[field]
        .as_str()
        .expect("validated WorkerLink UUID")
        .to_owned()
}
fn canonical(header: &Value) -> String {
    Value::Array(vec![header["channel"].clone(), header["lane"].clone()]).stringify()
}
fn bandwidth(header: &Value) -> &'static str {
    match header["grant"]["binding"]["resource"]["kind"]
        .as_str()
        .unwrap()
    {
        "terminal" => "terminal-relay",
        "browser" | "remote-desktop" => "remote-surface-relay",
        "project-share" => "project-share-relay",
        "tunnel" => "tunnel-relay",
        "observations" => "other",
        _ => unreachable!("validated grant kind"),
    }
}
impl Relay {
    pub fn new(bridge: Arc<WorkerBridge>, options: Options) -> Arc<Self> {
        Arc::new(Self {
            bridge,
            options,
            state: Mutex::new(State::default()),
            attachment: Mutex::new(()),
        })
    }
    fn current(&self, connection: &Arc<Connection>) -> bool {
        self.state
            .lock()
            .unwrap()
            .connections
            .get(connection.session["sessionId"].as_str().unwrap())
            .is_some_and(|c| Arc::ptr_eq(c, connection))
    }
    fn record(&self, c: &Connection, channel: &'static str, ingress: bool, bytes: usize) {
        if let Some(record) = &self.options.record {
            record(&c.session["identity"]["ownerId"], channel, ingress, bytes);
        }
    }
    fn consume(&self, c: &Connection, bytes: usize) -> bool {
        if bytes == 0
            || self.options.consume_relay.as_ref().is_none_or(|consume| {
                consume(
                    &c.session["identity"]["ownerId"],
                    &c.session["identity"]["workerId"],
                    bytes,
                )
            })
        {
            return true;
        }
        c.socket
            .close(1013, "WorkerLink relay bandwidth quota reached");
        false
    }
    pub fn stats(&self) -> Value {
        let state = self.state.lock().unwrap();
        let (mut channels, mut bytes, mut frames) = (0, 0, 0);
        let mut by_lane = IndexMap::from(LANES.map(|lane| (lane, 0usize)));
        for c in state.connections.values() {
            let c = c.state.lock().unwrap();
            channels += c.channels.len();
            bytes += c.bytes;
            frames += c.frames;
            for lane in LANES {
                by_lane[lane] += c.lanes[lane].frames.len();
            }
        }
        let by_lane = Value::Object(
            by_lane
                .into_iter()
                .map(|(lane, count)| (lane.into(), json!(count)))
                .collect(),
        );
        json!({"channels":channels,"connections":state.connections.len(),"queuedBytes":bytes,"queuedFrames":frames,"queuedFramesByLane":by_lane})
    }
}
