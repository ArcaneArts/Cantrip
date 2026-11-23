use anyhow::{Context, Result};
use cantrip_server::{
    operations::{
        log_records,
        logging::{Emitter, Logger},
    },
    wire::Value,
    workers::bridge::{
        CommandError, Continuity, EventHandler, OfflineSubscription, Outgoing, Peer, WorkerBridge,
    },
};
use serde_json::{Value as Json, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, Ordering::SeqCst},
    },
    time::Duration,
};
use tokio::sync::{mpsc, watch};

const BASE: i64 = 1_793_059_200_123;
type Receivers = HashMap<String, Option<mpsc::UnboundedReceiver<Outgoing>>>;
struct Probe {
    clock: AtomicI64,
    active: Mutex<Option<String>>,
    aliases: Mutex<HashMap<String, String>>,
    records: Mutex<Vec<Value>>,
    trace: Mutex<Vec<Json>>,
    receivers: Mutex<Receivers>,
    fail_send: Mutex<HashMap<String, String>>,
    outcomes: Mutex<BTreeMap<String, Json>>,
}
impl Probe {
    fn new(initial: i64) -> Arc<Self> {
        Arc::new(Self {
            clock: AtomicI64::new(initial),
            active: Mutex::new(None),
            aliases: Mutex::default(),
            records: Mutex::default(),
            trace: Mutex::default(),
            receivers: Mutex::default(),
            fail_send: Mutex::default(),
            outcomes: Mutex::default(),
        })
    }
    fn alias(&self, id: &str) -> String {
        assert_eq!(uuid::Uuid::parse_str(id).unwrap().get_version_num(), 4);
        let mut aliases = self.aliases.lock().unwrap();
        aliases
            .entry(id.into())
            .or_insert_with(|| self.active.lock().unwrap().clone().expect("request origin"))
            .clone()
    }
    fn canonical(&self, value: &mut Json) {
        match value {
            Json::Array(values) => {
                for value in values {
                    self.canonical(value)
                }
            }
            Json::Object(values) => {
                for (key, value) in values {
                    if key == "requestId"
                        && let Some(id) = value.as_str()
                    {
                        *value = json!(self.alias(id));
                        continue;
                    }
                    self.canonical(value);
                }
            }
            _ => {}
        }
    }
    fn logger(self: &Arc<Self>) -> Logger {
        let clock = self.clone();
        let output = self.clone();
        let emitter = Emitter::new(
            "server".into(),
            Arc::new(move || clock.clock.load(SeqCst) as f64),
            Arc::new(move |record| {
                if let Some(id) = record["context"]["requestId"].as_str() {
                    output.alias(id);
                }
                let event = record["context"]["event"].as_str().unwrap();
                output.trace.lock().unwrap().push(json!({"log":event}));
                if event == "worker.command.dispatched" {
                    let worker = record["context"]["workerId"].as_str().unwrap();
                    if let Some(socket) = output.fail_send.lock().unwrap().remove(worker) {
                        output
                            .receivers
                            .lock()
                            .unwrap()
                            .get_mut(&socket)
                            .unwrap()
                            .take();
                    }
                }
                output.records.lock().unwrap().push(record);
            }),
        );
        Arc::new(move |call| emitter.dispatch(call).unwrap())
    }
}
struct Request {
    worker: String,
    socket: Option<String>,
    id: Option<String>,
}
struct Engine {
    probe: Arc<Probe>,
    bridge: Arc<WorkerBridge>,
    sockets: HashMap<String, (String, Arc<Peer>)>,
    requests: HashMap<String, Request>,
    gates: HashMap<String, watch::Sender<bool>>,
    subscriptions: HashMap<String, Vec<OfflineSubscription>>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl Engine {
    fn new(scenario: &Json) -> Self {
        let probe = Probe::new(scenario["initial"].as_i64().unwrap_or(BASE));
        let clock = probe.clone();
        let bridge = WorkerBridge::with_usage_logger_and_clock(
            Duration::from_millis(scenario["grace"].as_u64().unwrap_or(15000)),
            None,
            probe.logger(),
            Arc::new(move || clock.clock.load(SeqCst) as f64),
        );
        Self {
            probe,
            bridge,
            sockets: HashMap::new(),
            requests: HashMap::new(),
            gates: HashMap::new(),
            subscriptions: HashMap::new(),
            tasks: Vec::new(),
        }
    }
    async fn flush(&self) {
        for _ in 0..64 {
            tokio::task::yield_now().await;
        }
    }
    async fn step(&mut self, step: &Json) -> Result<Json> {
        let worker = step["worker"].as_str().unwrap_or("worker");
        match step["op"].as_str().unwrap() {
            "attach" => {
                let socket = step["socket"].as_str().unwrap();
                let identity = Continuity {
                    owner: "owner".into(),
                    credential: step["credential"].as_str().unwrap_or("credential").into(),
                    process_generation: step["generation"].as_str().unwrap_or("process").into(),
                };
                let (peer, rx) = if step["legacy"] == true {
                    Peer::legacy(identity)
                } else {
                    Peer::new(identity)
                };
                self.probe
                    .receivers
                    .lock()
                    .unwrap()
                    .insert(socket.into(), Some(rx));
                self.sockets
                    .insert(socket.into(), (worker.into(), peer.clone()));
                if !self.subscriptions.contains_key(worker) {
                    let mut subscriptions = Vec::new();
                    let probe = self.probe.clone();
                    let name = worker.to_owned();
                    subscriptions.push(self.bridge.subscribe_worker_disconnect(
                        worker,
                        Arc::new(move || {
                            probe.trace.lock().unwrap().push(json!({"disconnect":name}))
                        }),
                    ));
                    let probe = self.probe.clone();
                    let name = worker.to_owned();
                    subscriptions.push(self.bridge.subscribe_worker_offline(
                        worker,
                        Arc::new(move || probe.trace.lock().unwrap().push(json!({"offline":name}))),
                    ));
                    self.subscriptions.insert(worker.into(), subscriptions);
                }
                assert!(self.bridge.attach(worker, peer, Some("ready".into())));
            }
            "request" => {
                let name = step["name"].as_str().unwrap().to_owned();
                *self.probe.active.lock().unwrap() = Some(name.clone());
                self.requests.insert(
                    name.clone(),
                    Request {
                        worker: worker.into(),
                        socket: None,
                        id: None,
                    },
                );
                self.probe
                    .outcomes
                    .lock()
                    .unwrap()
                    .insert(name.clone(), json!({"pending":true}));
                let (gate, receiver) = watch::channel(false);
                self.gates.insert(name.clone(), gate);
                let handler = step["handler"].as_str().map(|kind| {
                    let kind = kind.to_owned();
                    let name = name.clone();
                    let probe = self.probe.clone();
                    Arc::new(move |event: Value| {
                        let kind = kind.clone();
                        let name = name.clone();
                        let probe = probe.clone();
                        let mut gate = receiver.clone();
                        Box::pin(async move {
                            probe
                                .trace
                                .lock()
                                .unwrap()
                                .push(json!({"handler":name,"event":event}));
                            if kind.starts_with("hold") {
                                gate.wait_for(|released| *released).await.unwrap();
                            }
                            if kind.ends_with("fail") {
                                return Err(CommandError {
                                    message: "controlled-event-failure".into(),
                                    code: None,
                                    unavailable: false,
                                    request_id: None,
                                    encoding_error: None,
                                    inference: None,
                                });
                            }
                            probe.trace.lock().unwrap().push(json!({"handled":name}));
                            Ok(())
                        })
                            as std::pin::Pin<
                                Box<
                                    dyn std::future::Future<Output = Result<(), CommandError>>
                                        + Send,
                                >,
                            >
                    }) as EventHandler
                });
                let bridge = self.bridge.clone();
                let probe = self.probe.clone();
                let worker = worker.to_owned();
                let command = Value::from_serialize(&step["command"]);
                let timeout = step["timeoutMs"].as_u64().map(Duration::from_millis);
                self.tasks.push(tokio::spawn(async move{
                    let outcome=match bridge.request(&worker,command,timeout,handler).await{
                        Ok(value)=>{let mut result=json!({"ok":true});if let Some(value)=value{result["result"]=serde_json::to_value(value).unwrap();}result},
                        Err(error) if error.encoding_error.is_some()=>json!({"encoding":true}),
                        Err(error)=>json!({"error":error.message,"code":error.code,"unavailable":error.unavailable}),
                    };
                    probe.outcomes.lock().unwrap().insert(name,outcome);
                }));
            }
            "response" | "event" => {
                let request = &self.requests[step["name"].as_str().unwrap()];
                if let Some(id) = &request.id {
                    let name = step["socket"]
                        .as_str()
                        .unwrap_or_else(|| request.socket.as_deref().unwrap());
                    let (_, peer) = &self.sockets[name];
                    let envelope = if step["op"] == "event" {
                        json!({"kind":"event","requestId":id,"event":step["event"]})
                    } else if step["ok"] == false {
                        let mut error = json!({"message":"controlled-worker-failure"});
                        if step.get("code").is_some() {
                            error["code"] = step["code"].clone();
                        }
                        json!({"kind":"response","requestId":id,"ok":false,"error":error})
                    } else {
                        let mut response = json!({"kind":"response","requestId":id,"ok":true});
                        if step["missing"] != true {
                            response["result"] = step
                                .get("result")
                                .cloned()
                                .unwrap_or_else(|| json!({"fixture":true}));
                        }
                        response
                    };
                    self.bridge
                        .receive(&request.worker, peer, &serde_json::to_string(&envelope)?);
                }
            }
            "invalid" => {
                let (worker, peer) = &self.sockets[step["socket"].as_str().unwrap()];
                self.bridge
                    .receive(worker, peer, step["text"].as_str().unwrap());
            }
            "binary" => {
                let (worker, peer) = &self.sockets[step["socket"].as_str().unwrap()];
                self.bridge
                    .receive_worker_link_frame(worker, peer, Arc::from(b"CWLK".as_slice()));
            }
            "interrupt" => {
                let (worker, peer) = &self.sockets[step["socket"].as_str().unwrap()];
                self.bridge.interrupted(worker, peer);
            }
            "disconnect" => self.bridge.disconnect(
                worker,
                "controlled-revocation",
                step["code"].as_u64().unwrap() as u16,
            ),
            "fail-send" => {
                let socket = step["socket"].as_str().unwrap();
                let (worker, _) = &self.sockets[socket];
                self.probe
                    .fail_send
                    .lock()
                    .unwrap()
                    .insert(worker.clone(), socket.into());
            }
            "release" => {
                self.gates[step["name"].as_str().unwrap()].send_replace(true);
            }
            "advance" => {
                let ms = step["ms"].as_u64().unwrap();
                let wall = step["wall"]
                    .as_i64()
                    .unwrap_or_else(|| self.probe.clock.load(SeqCst) + ms as i64);
                self.probe.clock.store(wall, SeqCst);
                tokio::time::advance(Duration::from_millis(ms)).await;
            }
            "close" => self.bridge.close(),
            other => anyhow::bail!("Unknown bridge operation {other}"),
        }
        self.flush().await;
        let mut wire = BTreeMap::<String, Vec<Json>>::new();
        for (name, rx) in self.probe.receivers.lock().unwrap().iter_mut() {
            let Some(rx) = rx else { continue };
            while let Ok(message) = rx.try_recv() {
                let value = match message {
                    Outgoing::Text(mut text) => {
                        let text = text.take();
                        let value: Json =
                            serde_json::from_str(&text).unwrap_or_else(|_| json!(text));
                        if value["kind"] == "request" {
                            let id = value["requestId"].as_str().unwrap();
                            let alias = self.probe.alias(id);
                            let request = self.requests.get_mut(&alias).unwrap();
                            request.id = Some(id.into());
                            request.socket = Some(name.clone());
                            json!({"packet":value,"encoded":text.replacen(id, &alias, 1)})
                        } else {
                            value
                        }
                    }
                    Outgoing::Close(code, reason) => json!({"close":code,"reason":reason}),
                    _ => anyhow::bail!("Unexpected outgoing binary frame"),
                };
                wire.entry(name.clone()).or_default().push(value);
            }
        }
        let records = std::mem::take(&mut *self.probe.records.lock().unwrap());
        let persisted = records
            .iter()
            .map(log_records::minimize)
            .collect::<Vec<_>>();
        let mut snapshot = json!({"stats":self.bridge.stats(),"records":records,"persisted":persisted,"trace":std::mem::take(&mut*self.probe.trace.lock().unwrap()),"wire":wire,"outcomes":*self.probe.outcomes.lock().unwrap()});
        self.probe.canonical(&mut snapshot);
        *self.probe.active.lock().unwrap() = None;
        Ok(snapshot)
    }
}

#[tokio::test(start_paused = true)]
async fn reference_bridge_matches_packets_state_callbacks_and_full_minimized_diagnostics()
-> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/worker-bridge-diagnostics-oracle.mjs",
        ])
        .current_dir(root)
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Reference bridge: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let corpus: Json = serde_json::from_slice(&output.stdout)?;
    for scenario in corpus["cases"].as_array().context("bridge cases")? {
        let mut engine = Engine::new(scenario);
        for (index, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let actual = engine.step(step).await?;
            assert_eq!(
                actual, scenario["snapshots"][index],
                "{} step{index} {step}",
                scenario["name"]
            );
        }
        for task in engine.tasks {
            assert!(
                task.is_finished(),
                "caller settled before scenario teardown"
            );
            task.await?;
        }
    }
    Ok(())
}
