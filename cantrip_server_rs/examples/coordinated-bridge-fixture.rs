//! Controlled sockets/owner lookups around the native bridge, with real Redis.
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_server::{
    coordination::{Options as RedisOptions, RedisCoordinator},
    wire::{Value, parse_json_text},
    workers::{
        bridge::{CommandError, Continuity, EventHandler, Outgoing, Peer},
        coordinated::{CoordinatedBridge, Options, RequestOptions},
        transport::{CoordinatedTransport, WorkerTransport},
    },
};
use futures::FutureExt;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt},
    sync::{mpsc, watch},
    task::AbortHandle,
};
macro_rules! j{({$($key:literal:$value:expr),*$(,)?})=>{Value::object([$(( $key,Value::from_serialize(&$value))),*])};}
#[path = "support/coordinator_control.rs"]
mod coordinator_control;
type Events = Arc<Mutex<Vec<Value>>>;
fn text(r: &Value, key: &str) -> String {
    r[key].as_str().expect("fixture string").into()
}
fn record(events: &Events, value: Value) {
    events.lock().unwrap().push(value);
}
#[derive(Default)]
struct Control {
    coordination: Mutex<HashMap<String, Arc<coordinator_control::Gate>>>,
    owners: Mutex<HashMap<String, Option<String>>>,
    owner_gates: Mutex<HashMap<String, watch::Sender<bool>>>,
    event_gates: Mutex<HashMap<String, watch::Sender<bool>>>,
}
#[derive(Clone)]
struct Socket {
    worker: String,
    peer: Arc<Peer>,
    writer: AbortHandle,
}
struct Driver {
    bridge: Arc<CoordinatedBridge>,
    transport: Arc<dyn WorkerTransport>,
    coordinator: Arc<RedisCoordinator>,
    control: Arc<Control>,
    events: Events,
    peers: Mutex<HashMap<String, Socket>>,
    subscriptions: Mutex<Vec<Box<dyn Send + Sync>>>,
}
fn gate(map: &Mutex<HashMap<String, watch::Sender<bool>>>, name: String) {
    map.lock().unwrap().insert(name, watch::channel(false).0);
}
fn release(map: &Mutex<HashMap<String, watch::Sender<bool>>>, name: &str) {
    if let Some(gate) = map.lock().unwrap().remove(name) {
        gate.send_replace(true);
    }
}
async fn wait(map: &Mutex<HashMap<String, watch::Sender<bool>>>, name: &str) {
    let gate = map.lock().unwrap().get(name).map(|g| g.subscribe());
    if let Some(mut gate) = gate {
        let _ = gate.wait_for(|released| *released).await;
    }
}
fn failure(error: &CommandError, worker: &str, command: &str) -> Value {
    let class = if error.unavailable {
        "WorkerUnavailableError"
    } else if error.encoding_error.is_some() {
        "ZodError"
    } else if error.request_id.is_some() {
        "WorkerCommandError"
    } else {
        "Error"
    };
    let message = match error.encoding_error.as_deref() {
        Some(cantrip_server::wire::ValidationError::Invalid(issues)) => {
            Value::String(Value::Array(issues.clone()).stringify_pretty().into())
        }
        _ => Value::String(error.message.clone()),
    };
    let mut out =
        j!({"name":if error.unavailable{"Error"}else{class},"class":class,"message":message});
    if !error.unavailable
        && let Some(id) = &error.request_id
    {
        out["requestId"] = j!({"id":id})["id"].clone();
        out["operation"] = Value::String(command.into());
        out["workerId"] = Value::String(worker.into());
        out["code"] = Value::from_serialize(&error.code);
        if let Some(inference) = &error.inference {
            out["inference"] = (**inference).clone();
        }
    }
    out
}
impl Driver {
    async fn new(r: &Value) -> Result<Arc<Self>> {
        let c = &r["options"];
        let mut options = RedisOptions::new(text(c, "url"), text(c, "instanceId"));
        if let Some(p) = c["keyPrefix"].as_str() {
            options.key_prefix = p.into();
        }
        if let Some(t) = c["presenceTtlMs"].as_u64() {
            options.presence_ttl_ms = t;
        }
        if let Some(n) = c["maximumInstances"].as_u64() {
            options.maximum_instances = n;
        }
        let coordinator = RedisCoordinator::new(options)?;
        coordinator.start().await?;
        let events: Events = Arc::default();
        let control: Arc<Control> = Arc::default();
        let observed = events.clone();
        let controls = control.clone();
        let mut options = Options::new(
            coordinator_control::Controlled::new(
                coordinator.clone(),
                events.clone(),
                control.clone(),
            ),
            Arc::new(move |worker| {
                let events = observed.clone();
                let control = controls.clone();
                Box::pin(async move {
                    record(&events, j!({"kind":"owner-lookup","workerId":worker}));
                    wait(&control.owner_gates, &worker).await;
                    Ok(control
                        .owners
                        .lock()
                        .unwrap()
                        .get(&worker)
                        .cloned()
                        .unwrap_or_else(|| Some("owner".into())))
                })
            }),
        );
        options.logger = Arc::new(|_| {});
        options.reconnect_grace =
            Duration::from_secs_f64(r["graceMs"].as_f64().unwrap_or(15000.0) / 1000.0);
        let bridge = CoordinatedBridge::new(options);
        let observed = events.clone();
        coordinator.subscribe(Arc::new(move |message| {
            if message["kind"] == "fixture-barrier" {
                record(&observed, j!({"kind":"barrier","name":message["name"]}));
            }
            Box::pin(async { Ok(()) })
        }));
        Ok(Arc::new(Self {
            transport: CoordinatedTransport::new(bridge.clone()),
            bridge,
            coordinator,
            control,
            events,
            peers: Mutex::default(),
            subscriptions: Mutex::default(),
        }))
    }
    fn socket(&self, r: &Value) -> Socket {
        self.peers
            .lock()
            .unwrap()
            .get(&text(r, "peer"))
            .expect("fixture peer")
            .clone()
    }
    async fn dispatch(self: Arc<Self>, r: Value) -> Result<Value> {
        match r["op"].as_str().unwrap_or(""){
            "attach"|"abandonAttach"=>{
                let worker=text(&r,"workerId");let name=text(&r,"peer");let c=&r["continuity"];
                let identity=Continuity{owner:c["ownerId"].as_str().or(r["ownerId"].as_str()).unwrap_or("owner").into(),credential:c["credentialId"].as_str().unwrap_or("legacy").into(),process_generation:c["workerProcessGeneration"].as_str().unwrap_or("legacy").into()};
                let (peer,mut output)=if c.is_null(){Peer::legacy(identity)}else{Peer::new(identity)};
                if r["open"]==false{peer.open.store(false,Ordering::Release);}
                let events=self.events.clone();let w=worker.clone();let p=peer.clone();let n=name.clone();let weak=Arc::downgrade(&self.bridge);
                let writer=tokio::spawn(async move{
                    while let Some(frame)=output.recv().await{
                        let mut event=j!({"kind":"worker-output","peer":n,"workerId":w});
                        match frame{
                            Outgoing::Text(mut q)=>event["text"]=Value::String(q.take().into()),
                            Outgoing::Binary(mut q)=>event["bytes"]=Value::String(STANDARD.encode(q.take().bytes()).into()),
                            Outgoing::Tunnel(mut q)=>event["bytes"]=Value::String(STANDARD.encode(q.take().bytes()).into()),
                            Outgoing::Surface(mut q)=>event["bytes"]=Value::String(STANDARD.encode(q.take().bytes()).into()),
                            Outgoing::Close(code,reason)=>{record(&events,j!({"kind":"worker-close","peer":n,"workerId":w,"code":code,"reason":reason}));if let Some(b)=weak.upgrade(){b.local.interrupted(&w,&p);}break;},
                        }
                        record(&events,event);
                    }
                });
                self.peers.lock().unwrap().insert(name,Socket{worker:worker.clone(),peer:peer.clone(),writer:writer.abort_handle()});
                let attaching=self.transport.attach_worker(worker,peer,r["ownerId"].as_str().map(str::to_owned),r["ready"].as_str().map(str::to_owned));
                if r["op"]=="abandonAttach"{drop(attaching);Ok(Value::Null)}else{Ok(Value::Bool(attaching.await?))}
            },
            "interrupt"=>{let socket=self.socket(&r);socket.peer.open.store(false,Ordering::Release);socket.writer.abort();self.bridge.local.interrupted(&socket.worker,&socket.peer);Ok(Value::Null)},
            "receive"=>{
                let socket=self.socket(&r);
                if let Some(bytes)=r["bytes"].as_str(){let bytes:Arc<[u8]>=STANDARD.decode(bytes)?.into();
                    if cantrip_server::tunnels::frame::is_frame(&bytes){self.bridge.local.receive_tunnel_frame(&socket.worker,&socket.peer,bytes);}
                    else if cantrip_server::worker_links::frame::is_frame(&bytes){self.bridge.local.receive_worker_link_frame(&socket.worker,&socket.peer,bytes);}
                    else{self.bridge.local.receive_surface_frame(&socket.worker,&socket.peer,bytes);}
                }else{self.bridge.local.receive(&socket.worker,&socket.peer,&r["message"].stringify());}Ok(Value::Null)
            },
            "begin"|"delegateBegin"=>{
                let worker=text(&r,"workerId");let name=text(&r,"name");let command=r["command"].clone();let kind=command["type"].as_str().unwrap_or("").to_owned();let input=&r["options"];
                let mut options=RequestOptions{owner:input["ownerId"].as_str().map(str::to_owned),forward_inference:input["forwardInferenceTiming"].as_bool()==Some(true),..Default::default()};
                if let Some(timeout)=input.get("timeoutMs"){options.timeout=if timeout.is_null(){None}else{Some(Duration::from_secs_f64(timeout.as_f64().unwrap()/1000.0))};}
                let events=self.events.clone();let controls=self.control.clone();let n=name.clone();let fail=r["failEvent"]==true;
                let handler:EventHandler=Arc::new(move|event|{
                    let events=events.clone();let control=controls.clone();let n=n.clone();Box::pin(async move{
                        record(&events,j!({"kind":"command-event","name":n,"event":event}));
                        if fail{return Err(CommandError{message:"Controlled event handler failed.".into(),code:None,unavailable:false,request_id:None,encoding_error:None,inference:None});}
                        wait(&control.event_gates,&n).await;Ok(())
                    })
                });options.on_event=Some(handler);
                let events=self.events.clone();let n=name.clone();options.on_inference=Some(Arc::new(move|event|{
                    let mut out=j!({"kind":"inference","name":n});if let Value::Object(fields)=&event && let Value::Object(out)=&mut out{out.extend(fields.iter().map(|(k,v)|(k.clone(),v.clone())));}record(&events,out);
                }));
                let result=if r["op"]=="delegateBegin"{self.transport.clone().request(options.owner.unwrap_or_else(|| "owner".into()),worker.clone(),command,options.timeout,options.on_event)}else{self.bridge.request(&worker,command,options)};let events=self.events.clone();
                tokio::spawn(async move{
                    let mut event=j!({"kind":"completion","name":name});match result.await{Ok(value)=>{event["ok"]=Value::Bool(true);if let Some(value)=value{event["result"]=value;}},Err(error)=>{event["ok"]=Value::Bool(false);event["error"]=failure(&error,&worker,&kind);}}record(&events,event);
                });Ok(Value::Null)
            },
            "subscribe"=>{
                let worker=text(&r,"workerId");let mut tokens:Vec<Box<dyn Send+Sync>>=Vec::new();
                let events=self.events.clone();let w=worker.clone();tokens.push(Box::new(self.transport.subscribe_worker_disconnect(&worker,Arc::new(move||record(&events,j!({"kind":"disconnect","workerId":w}))))));
                let events=self.events.clone();let w=worker.clone();tokens.push(Box::new(self.transport.subscribe_worker_offline(&worker,Arc::new(move||record(&events,j!({"kind":"offline","workerId":w}))))));
                let events=self.events.clone();let w=worker.clone();tokens.push(Box::new(self.transport.subscribe_notifications(&worker,Arc::new(move|value|{record(&events,j!({"kind":"notification","workerId":w,"value":value.as_ref()}));Box::pin(async{Ok(())})}))));
                let events=self.events.clone();let w=worker.clone();tokens.push(Box::new(self.transport.subscribe_surface_frames(&worker,Arc::new(move|frame|{record(&events,j!({"kind":"frame","workerId":w,"transport":"surface","header":frame.header(),"payloadBase64":STANDARD.encode(frame.payload())}));Ok(())}))));
                let events=self.events.clone();let w=worker.clone();tokens.push(Box::new(self.transport.subscribe_tunnel_frames(&worker,Arc::new(move|frame|{record(&events,j!({"kind":"frame","workerId":w,"transport":"tunnel","header":frame.header(),"payloadBase64":STANDARD.encode(frame.payload())}));Ok(())}))));
                let events=self.events.clone();let w=worker.clone();tokens.push(Box::new(self.transport.subscribe_worker_link_frames(&worker,Arc::new(move|frame|{record(&events,j!({"kind":"frame","workerId":w,"transport":"worker-link","header":frame.header(),"payloadBase64":STANDARD.encode(frame.payload()),"bytes":STANDARD.encode(frame.bytes())}));Ok(())}))));
                self.subscriptions.lock().unwrap().extend(tokens);Ok(Value::Null)
            },
            "sendFrame"=>{let worker=text(&r,"workerId");let payload=STANDARD.decode(text(&r,"payloadBase64"))?;let h=r["header"].clone();let frame=if let Some(raw)=r["frameBytes"].as_str(){Some(cantrip_server::worker_links::frame::decode(STANDARD.decode(raw)?.into()).map_err(anyhow::Error::from)?)}else{None};Ok(Value::Bool(match r["transport"].as_str(){Some("surface")=>self.transport.send_surface_frame(&worker,h,&payload),Some("tunnel")=>self.transport.send_tunnel_frame(&worker,h,&payload),_=>self.transport.send_worker_link_frame(&worker,match frame{Some(f)=>f,None=>cantrip_server::worker_links::frame::create(h,&payload).map_err(anyhow::Error::from)?})}))},
            "disconnect"=>{self.transport.disconnect(&text(&r,"workerId"),r["reason"].as_str().unwrap_or("Worker credential was revoked"),r["code"].as_u64().unwrap_or(1008) as u16);Ok(Value::Null)},
            "connected"=>Ok(Value::Bool(self.transport.is_connected(&text(&r,"workerId")))),
            "identity"=>Ok(self.transport.connection_identity(&text(&r,"workerId")).map(|c|j!({"ownerId":c.owner,"credentialId":c.credential,"workerProcessGeneration":c.process_generation})).unwrap_or(Value::Null)),
            "presence"=>Ok(self.coordinator.find_worker(&text(&r,"workerId").into()).await?.unwrap_or(Value::Null)),
            "stats"=>Ok(Value::from_serialize(&self.transport.stats())),
            "barrier"=>{self.coordinator.publish(j!({"kind":"fixture-barrier","targetInstanceId":r["target"],"name":r["name"]}),None).await?;Ok(Value::Null)},
            "coordinationStats"=>Ok(self.coordinator.stats()),
            "events"=>Ok(Value::Array(std::mem::take(&mut *self.events.lock().unwrap()))),
            "setOwner"=>{self.control.owners.lock().unwrap().insert(text(&r,"workerId"),r["ownerId"].as_str().map(str::to_owned));Ok(Value::Null)},
            "gateOwner"=>{gate(&self.control.owner_gates,text(&r,"workerId"));Ok(Value::Null)},
            "gateCoord"=>{coordinator_control::gate(&self.control,format!("{}:{}",text(&r,"operation"),r["workerId"].as_str().unwrap_or("")),r["after"]==true,r["once"]!=false);Ok(Value::Null)},
            "releaseCoord"=>{coordinator_control::release(&self.control,&format!("{}:{}",text(&r,"operation"),r["workerId"].as_str().unwrap_or("")));Ok(Value::Null)},
            "releaseOwner"=>{release(&self.control.owner_gates,&text(&r,"workerId"));Ok(Value::Null)},
            "gateEvent"=>{gate(&self.control.event_gates,text(&r,"name"));Ok(Value::Null)},
            "releaseEvent"=>{release(&self.control.event_gates,&text(&r,"name"));Ok(Value::Null)},
            "closeBridge"=>{self.transport.shutdown().await?;Ok(Value::Null)},
            "close"=>{self.transport.shutdown().await?;self.coordinator.close().await?;for p in self.peers.lock().unwrap().values(){p.writer.abort();}Ok(Value::Null)},
            _=>bail!("Unknown fixture operation"),
        }
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let first = lines.next_line().await?.context("fixture init")?;
    let request = parse_json_text(&first).map_err(|_| anyhow::anyhow!("fixture init JSON"))?;
    let driver = Driver::new(&request).await?;
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let output = tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        while let Some(value) = rx.recv().await {
            out.write_all(value.stringify().as_bytes()).await?;
            out.write_all(b"\n").await?;
            out.flush().await?;
        }
        Ok::<_, std::io::Error>(())
    });
    tx.send(j!({"id":request["id"],"result":Value::Null}))?;
    while let Some(line) = lines.next_line().await? {
        let request = parse_json_text(&line).map_err(|_| anyhow::anyhow!("fixture RPC JSON"))?;
        let d = driver.clone();
        let tx = tx.clone();
        let id = request["id"].clone();
        let mut response = Box::pin(async move {
            let result = d.dispatch(request).await;
            for _ in 0..8 {
                tokio::task::yield_now().await;
            }
            let response = match result {
                Ok(value) => j!({"id":id,"result":value}),
                Err(error) => j!({"id":id,"error":error.to_string()}),
            };
            let _ = tx.send(response);
        });
        if response.as_mut().now_or_never().is_none() {
            tokio::spawn(response);
        }
    }
    driver.transport.shutdown().await?;
    driver.coordinator.close().await?;
    drop(tx);
    output.await??;
    Ok(())
}
