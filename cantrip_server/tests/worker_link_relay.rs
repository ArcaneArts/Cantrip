use anyhow::Result;
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_server::{
    wire::Value,
    worker_links::{
        frame::{self, Frame},
        relay::{Connection, Options, Relay, Socket},
    },
    workers::bridge::{Continuity, Outgoing, Peer, WorkerBridge},
};
use indexmap::IndexMap;
use std::{
    path::PathBuf,
    process::Command,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
    },
    time::Duration,
};
fn json(v: impl serde::Serialize) -> Value {
    Value::from_serialize(&v)
}
fn text(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap().to_owned()
}
#[derive(Default)]
struct Trace {
    meter: Vec<Value>,
    quota: Vec<Value>,
    surfaces: Vec<Value>,
    active: usize,
    used: usize,
}
struct Permit {
    trace: Arc<Mutex<Trace>>,
    owner: Value,
    worker: Value,
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut t = self.trace.lock().unwrap();
        t.active -= 1;
        t.surfaces.push(Value::Array(vec![
            json("release"),
            self.owner.clone(),
            self.worker.clone(),
        ]));
    }
}
#[derive(Default)]
struct SocketState {
    sent: Vec<String>,
    closes: Vec<Value>,
    fail: bool,
    closed: Option<(Weak<Relay>, Weak<Connection>)>,
}
struct TestSocket {
    open: AtomicBool,
    buffered: AtomicUsize,
    state: Mutex<SocketState>,
}
impl TestSocket {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            open: AtomicBool::new(true),
            buffered: AtomicUsize::new(0),
            state: Mutex::new(SocketState::default()),
        })
    }
}
impl Socket for TestSocket {
    fn is_open(&self) -> bool {
        self.open.load(Ordering::Acquire)
    }
    fn buffered_amount(&self) -> usize {
        self.buffered.load(Ordering::Acquire)
    }
    fn send(&self, frame: Frame) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        anyhow::ensure!(!state.fail, "controlled send failure");
        state.sent.push(STANDARD.encode(frame.bytes()));
        Ok(())
    }
    fn close(&self, code: u16, reason: &str) {
        if !self.open.swap(false, Ordering::AcqRel) {
            return;
        }
        let callback = {
            let mut state = self.state.lock().unwrap();
            state
                .closes
                .push(json(serde_json::json!({"code":code,"reason":reason})));
            state.closed.clone()
        };
        if let Some((relay, c)) = callback
            && let (Some(relay), Some(c)) = (relay.upgrade(), c.upgrade())
        {
            relay.retire(&c);
        }
    }
}
fn number(v: &Value, key: &str, default: usize) -> usize {
    v[key].as_f64().map_or(default, |n| n as usize)
}
fn packet(action: &Value) -> Result<Frame> {
    let payload = action["payload"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_f64().unwrap() as u8)
        .collect::<Vec<_>>();
    Ok(frame::create(action["header"].clone(), &payload)?)
}
#[tokio::test]
async fn relay_matches_actual_sequence_queue_quota_and_retirement_behavior() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/worker-link-relay-oracle.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Actual relay oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let vectors: Value = serde_json::from_slice(&output.stdout)?;
    let mut total = 0;
    for case in vectors["cases"].as_array().unwrap() {
        let bridge = WorkerBridge::new(Duration::ZERO);
        let (peer, mut output) = Peer::new(Continuity {
            owner: "fixture".into(),
            credential: "fixture".into(),
            process_generation: "fixture".into(),
        });
        assert!(bridge.attach("fixture", peer.clone(), None));
        let clock = Arc::new(AtomicI64::new(0));
        let trace = Arc::new(Mutex::new(Trace::default()));
        let config = &case["options"];
        let lane = json(
            serde_json::json!({"maxChannels":64,"maxQueuedFrames":number(config,"queueFrames",8),"maxQueuedBytes":number(config,"queueBytes",65536),"maxBytesPerSecond":65536}),
        );
        let mut options = Options {
            lane_limits: Value::Object(
                ["events", "interactive", "stream", "realtime", "bulk"]
                    .into_iter()
                    .map(|k| (k.into(), lane.clone()))
                    .collect(),
            ),
            auto_drain: false,
            now: {
                let clock = clock.clone();
                Arc::new(move || clock.load(Ordering::Acquire))
            },
            ..Options::default()
        };
        options.acquire_remote_surface = Some({
            let trace = trace.clone();
            let limit = number(config, "surfaceLimit", 100);
            Arc::new(move |owner, worker| {
                let mut t = trace.lock().unwrap();
                anyhow::ensure!(t.active < limit, "controlled surface quota");
                t.active += 1;
                t.surfaces.push(Value::Array(vec![
                    json("acquire"),
                    owner.clone(),
                    worker.clone(),
                ]));
                Ok(Box::new(Permit {
                    trace: trace.clone(),
                    owner: owner.clone(),
                    worker: worker.clone(),
                }))
            })
        });
        options.consume_relay = Some({
            let trace = trace.clone();
            let budget = number(config, "budget", 1_000_000);
            Arc::new(move |owner, worker, bytes| {
                let mut t = trace.lock().unwrap();
                t.quota.push(Value::Array(vec![
                    owner.clone(),
                    worker.clone(),
                    json(bytes),
                ]));
                if t.used + bytes > budget {
                    return false;
                }
                t.used += bytes;
                true
            })
        });
        options.record = Some({
            let trace = trace.clone();
            Arc::new(move |owner, channel, ingress, bytes| {
                trace.lock().unwrap().meter.push(Value::object([
                    ("ownerId", owner.clone()),
                    (
                        "direction",
                        json(if ingress { "ingress" } else { "egress" }),
                    ),
                    ("channel", json(channel)),
                    ("bytes", json(bytes)),
                ]))
            })
        });
        let relay = Relay::new(bridge.clone(), options);
        let mut sockets = IndexMap::<String, (Arc<TestSocket>, Option<Arc<Connection>>)>::new();
        let mut selected = "a".to_owned();
        let mut sent = Vec::new();
        for (index, action) in case["actions"].as_array().unwrap().iter().enumerate() {
            let result: Result<()> = async {
                match action["op"].as_str().unwrap() {
                    "attach" => {
                        selected = text(action, "name");
                        let socket = TestSocket::new();
                        let mut session = action["session"].clone();
                        if let Some(route) = config.get("preferredRoute") {
                            session["preferredRoute"] = route.clone();
                        }
                        if config["relayDisabled"] == true {
                            session["routePolicy"]["enabled"] = json(["local"]);
                            session["preferredRoute"] = json("local");
                        }
                        let connection = relay.attach(session, socket.clone());
                        if let Some(c) = &connection {
                            socket.state.lock().unwrap().closed =
                                Some((Arc::downgrade(&relay), Arc::downgrade(c)));
                        }
                        sockets.insert(selected.clone(), (socket, connection));
                    }
                    "select" => selected = text(action, "name"),
                    "client" => {
                        let key = action["name"].as_str().unwrap_or(&selected);
                        if let Some(c) = &sockets[key].1 {
                            let bytes = if let Some(raw) = action["raw"].as_str() {
                                STANDARD.decode(raw)?
                            } else {
                                packet(action)?.bytes().to_vec()
                            };
                            relay.receive_client(c, bytes.into(), action["binary"] != false);
                        }
                    }
                    "worker" => {
                        let frame = packet(action)?;
                        bridge.receive_worker_link_frame(
                            "fixture",
                            &peer,
                            frame.bytes().to_vec().into(),
                        );
                    }
                    "buffer" => sockets[&selected]
                        .0
                        .buffered
                        .store(number(action, "bytes", 0), Ordering::Release),
                    "clock" => clock.store(number(action, "now", 0) as i64, Ordering::Release),
                    "tick" => {
                        if relay.stats()["queuedFrames"].as_f64().unwrap() > 0.0
                            && let Some(c) = &sockets[&selected].1
                        {
                            relay.drain(c);
                        }
                    }
                    "send-fails" => sockets[&selected].0.state.lock().unwrap().fail = true,
                    "offline" => bridge.disconnect("fixture", "controlled offline", 1000),
                    "revoke-owner" => relay.revoke_owner(&action["id"]),
                    "revoke-account" => relay.revoke_account(&action["id"]),
                    "revoke-session" => relay
                        .revoke_session(action["id"].as_str().unwrap(), "WorkerLink session ended"),
                    "close" => relay.close(),
                    _ => anyhow::bail!("Unknown relay case"),
                }
                Ok(())
            }
            .await;
            while let Ok(message) = output.try_recv() {
                if let Outgoing::Binary(mut frame) = message {
                    sent.push(json(serde_json::json!({"worker":"fixture","bytes":STANDARD.encode(frame.take().bytes())})));
                }
            }
            let snapshot = {
                let t = trace.lock().unwrap();
                Value::object([
                    ("stats", relay.stats()),
                    ("sent", Value::Array(sent.clone())),
                    (
                        "sockets",
                        Value::Object(
                            sockets
                                .iter()
                                .map(|(name, (s, _))| {
                                    let s = s.state.lock().unwrap();
                                    (
                                        name.clone().into(),
                                        json(serde_json::json!({"closes":s.closes,"sent":s.sent})),
                                    )
                                })
                                .collect(),
                        ),
                    ),
                    ("meter", json(&t.meter)),
                    ("quota", json(&t.quota)),
                    ("surfaces", json(&t.surfaces)),
                    ("active", json(t.active)),
                    ("used", json(t.used)),
                    (
                        "error",
                        result.err().map_or(Value::Null, |e| json(e.to_string())),
                    ),
                ])
            };
            assert_eq!(
                snapshot,
                case["observations"].as_array().unwrap()[index],
                "{} action {index}: {}",
                case["name"].stringify(),
                action.stringify()
            );
            total += 1;
        }
        relay.close();
        bridge.close();
    }
    println!(
        "{total} actual relay snapshots across {} scenarios matched",
        vectors["cases"].as_array().unwrap().len()
    );
    Ok(())
}
