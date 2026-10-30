//! Development-only adapter: drive the actual native hub with deterministic IO/time.
use anyhow::{Result, bail};
use cantrip_server::{
    live::{ConnectionContext, Frame, Hub, Options, Socket},
    wire::Value,
};
use indexmap::IndexMap;
use std::{
    io::{self, BufRead, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::task::JoinHandle;
use uuid::Uuid;

fn value(input: impl serde::Serialize) -> Value {
    Value::from_serialize(&input)
}
#[derive(Default)]
struct Probe {
    open: AtomicBool,
    buffered: AtomicUsize,
    fail: AtomicBool,
    sent: Mutex<Vec<Value>>,
    closed: Mutex<Option<Value>>,
    active: AtomicI64,
}
impl Socket for Probe {
    fn is_open(&self) -> bool {
        self.open.load(Ordering::Acquire)
    }
    fn buffered_amount(&self) -> usize {
        self.buffered.load(Ordering::Acquire)
    }
    fn send(&self, text: Arc<str>) -> Result<()> {
        if self.fail.load(Ordering::Acquire) {
            bail!("Controlled socket send failure");
        }
        self.sent.lock().unwrap().push(serde_json::from_str(&text)?);
        Ok(())
    }
    fn close(&self, code: u16, reason: &str) {
        if self.open.swap(false, Ordering::AcqRel) {
            *self.closed.lock().unwrap() =
                Some(value(serde_json::json!({"code":code,"reason":reason})));
        }
    }
}
async fn settle() {
    for _ in 0..4 {
        tokio::task::yield_now().await;
    }
}
async fn run(input: Value) -> Result<Value> {
    let now = Arc::new(AtomicI64::new(1792886400000));
    let usage = Arc::new(Mutex::new(Vec::<Value>::new()));
    let external = Arc::new(Mutex::new(Vec::<Value>::new()));
    let external_fail = Arc::new(AtomicBool::new(false));
    let options = &input["options"];
    let mut config = Options {
        epoch: "oracle-epoch".into(),
        now: {
            let now = now.clone();
            Arc::new(move || now.load(Ordering::Acquire))
        },
        ..Options::default()
    };
    for (key, target) in [
        ("maxBufferedBytes", &mut config.max_buffered_bytes),
        ("maxInboundBytes", &mut config.max_inbound_bytes),
        ("maxReplayEvents", &mut config.max_replay_events),
        ("maxReplayBytes", &mut config.max_replay_bytes),
    ] {
        if let Some(n) = options[key].as_u64() {
            *target = n as usize;
        }
    }
    if let Some(n) = options["heartbeatIntervalMs"].as_u64() {
        config.heartbeat_interval_ms = n;
    }
    config.record_usage = Some({
        let usage = usage.clone();
        Arc::new(move |owner, ingress, bytes, notify| {
            usage.lock().unwrap().push(value(
                serde_json::json!({"owner":owner,"ingress":ingress,"bytes":bytes,"notify":notify}),
            ))
        })
    });
    if input["external"].as_bool() == Some(true) {
        config.publish_external = Some({
            let external = external.clone();
            let fail = external_fail.clone();
            Arc::new(move |publication| {
                external.lock().unwrap().push(publication);
                let fail = fail.load(Ordering::Acquire);
                Box::pin(async move {
                    if fail {
                        bail!("Controlled external publication failure")
                    };
                    Ok(())
                })
            })
        });
    }
    let hub = Hub::new(config)?;
    let mut sockets = IndexMap::<String, (Arc<Probe>, Option<Uuid>)>::new();
    let mut pending = IndexMap::<String, JoinHandle<Result<Value>>>::new();
    let mut controls = IndexMap::<String, Value>::new();
    let mut snapshots = Vec::new();
    for op in input["steps"].as_array().unwrap() {
        let kind = op["op"].as_str().unwrap();
        let id = op["socket"].as_str().unwrap_or("one");
        let mut result = Value::Null;
        match kind {
            "attach" => {
                let probe = Arc::new(Probe::default());
                probe.open.store(true, Ordering::Release);
                probe.active.store(1, Ordering::Release);
                let active = probe.clone();
                let connection = hub.attach(
                    probe.clone(),
                    ConnectionContext {
                        owner: op["owner"].as_str().unwrap_or("owner-one").into(),
                        session: op["session"].as_str().map(Into::into),
                        authorize: Arc::new(|scope| {
                            Box::pin(async move {
                                Ok(scope["projectId"] != "denied" && scope["chatId"] != "denied")
                            })
                        }),
                        active: Some(Arc::new(move || {
                            let active = active.active.load(Ordering::Acquire);
                            Box::pin(async move {
                                if active == 2 {
                                    bail!("Controlled session lookup failure")
                                };
                                Ok(active == 1)
                            })
                        })),
                    },
                );
                sockets.insert(id.into(), (probe, connection));
            }
            "frame" | "ack" => {
                let (_, connection) = sockets.get(id).unwrap();
                let raw = if kind == "ack" {
                    let source = op["requestSocket"].as_str().unwrap_or(id);
                    let sent = sockets[source].0.sent.lock().unwrap();
                    let request = sent
                        .iter()
                        .rev()
                        .find(|m| m["type"] == "client-control-request")
                        .unwrap();
                    let mut ack = value(
                        serde_json::json!({"type":"client-control-ack","status":op["status"].as_str().unwrap_or("applied")}),
                    );
                    ack["correlationId"] = request["correlationId"].clone();
                    ack.stringify()
                } else {
                    op["raw"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| op["message"].stringify())
                };
                if let Some(connection) = connection {
                    hub.frame(
                        *connection,
                        if op["binary"].as_bool() == Some(true) {
                            Frame::Binary(raw.into_bytes())
                        } else {
                            Frame::Text(raw)
                        },
                    )
                    .await;
                }
            }
            "publish" | "publish-confirmed" => {
                let published = if kind == "publish" {
                    hub.publish(op["publication"].clone())
                } else {
                    hub.publish_confirmed(op["publication"].clone()).await
                };
                result = match published {
                    Ok(v) => v,
                    Err(e) => value(serde_json::json!({"error":e.to_string()})),
                };
            }
            "external" => {
                result = hub
                    .receive_external(&op["publication"])
                    .unwrap_or(Value::Null)
            }
            "external-fail" => {
                external_fail.store(op["value"].as_bool().unwrap(), Ordering::Release)
            }
            "active" => sockets[id].0.active.store(
                if op["value"] == "error" {
                    2
                } else if op["value"].as_bool() == Some(true) {
                    1
                } else {
                    0
                },
                Ordering::Release,
            ),
            "buffer" => sockets[id]
                .0
                .buffered
                .store(op["bytes"].as_u64().unwrap() as usize, Ordering::Release),
            "send-fail" => sockets[id].0.fail.store(true, Ordering::Release),
            "closed-state" => sockets[id].0.open.store(false, Ordering::Release),
            "disconnect" => {
                let (socket, connection) = &sockets[id];
                socket.close(1006, "Controlled network loss");
                if let Some(connection) = connection {
                    hub.disconnect(*connection);
                }
            }
            "revoke-session" => result = value(hub.revoke_session(op["session"].as_str().unwrap())),
            "revoke-owner" => result = value(hub.revoke_owner(op["owner"].as_str().unwrap())),
            "control" => {
                let label = op["label"].as_str().unwrap().to_owned();
                let owner = op["owner"].as_str().unwrap_or("owner-one").to_owned();
                let command = op["command"].clone();
                let timeout = op["timeoutMs"].as_i64().unwrap_or(5000);
                let hub = hub.clone();
                controls.insert(label.clone(), Value::Null);
                pending.insert(
                    label,
                    tokio::spawn(
                        async move { hub.request_control(&owner, command, timeout).await },
                    ),
                );
            }
            "advance" => {
                let ms = op["ms"].as_u64().unwrap();
                now.fetch_add(ms as i64, Ordering::AcqRel);
                tokio::time::advance(Duration::from_millis(ms)).await;
            }
            "close" => hub.close(),
            _ => bail!("Unknown oracle operation {kind}"),
        }
        if kind == "close" {
            // close() settles every pending control synchronously. Await the
            // actual receivers, rather than guessing a Tokio scheduler budget.
            for (key, task) in std::mem::take(&mut pending) {
                controls.insert(key, task.await??);
            }
        }
        settle().await;
        let finished = pending
            .iter()
            .filter(|(_, t)| t.is_finished())
            .map(|(k, _)| k.clone())
            .collect::<Vec<_>>();
        for key in finished {
            let task = pending.shift_remove(&key).unwrap();
            controls.insert(key, task.await??);
        }
        let mut observed = IndexMap::new();
        for (id, (probe, _)) in &sockets {
            let mut snapshot = value(serde_json::json!({"open":probe.is_open()}));
            snapshot["sent"] = Value::Array(probe.sent.lock().unwrap().clone());
            snapshot["closed"] = probe.closed.lock().unwrap().clone().unwrap_or(Value::Null);
            observed.insert(id.clone().into(), snapshot);
        }
        let mut snapshot = value(serde_json::json!({"result":null,"stats":hub.stats()}));
        snapshot["result"] = result;
        snapshot["sockets"] = Value::Object(observed);
        snapshot["usage"] = Value::Array(usage.lock().unwrap().clone());
        snapshot["external"] = Value::Array(external.lock().unwrap().clone());
        snapshot["controls"] = Value::Object(
            controls
                .iter()
                .map(|(k, v)| (k.clone().into(), v.clone()))
                .collect(),
        );
        snapshots.push(snapshot);
    }
    hub.close();
    for (_, task) in pending {
        task.abort();
    }
    settle().await;
    Ok(Value::Array(snapshots))
}
#[tokio::main(flavor = "current_thread", start_paused = true)]
async fn main() -> Result<()> {
    let input = io::stdin();
    let mut output = io::stdout().lock();
    for line in input.lock().lines() {
        let case: Value = serde_json::from_str(&line?)?;
        let result = run(case).await?;
        writeln!(output, "{}", result.stringify())?;
        output.flush()?;
    }
    Ok(())
}
