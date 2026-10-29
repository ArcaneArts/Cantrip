use super::broker::{Handle as Route, Registration, Side};
use super::*;
pub(super) struct Endpoint {
    pub socket: Arc<dyn Socket>,
    authorization: Value,
    record: Option<Record>,
    active: AtomicBool,
    disconnected: AtomicBool,
    frame: Mutex<Option<Route>>,
    disconnect: Mutex<Option<Route>>,
}
pub fn channel(authorization: &Value) -> &'static str {
    if authorization["destination"]["kind"] == "worker-adapter"
        && authorization["destination"]["adapter"] == "project-share"
    {
        "project-share-relay"
    } else {
        "tunnel-relay"
    }
}
impl Endpoint {
    pub fn new(socket: Arc<dyn Socket>, authorization: Value, record: Option<Record>) -> Arc<Self> {
        Arc::new(Self {
            socket,
            authorization,
            record,
            active: AtomicBool::new(false),
            disconnected: AtomicBool::new(false),
            frame: Mutex::new(None),
            disconnect: Mutex::new(None),
        })
    }
    fn record(&self, ingress: bool, bytes: usize) {
        if let Some(record) = &self.record {
            record(
                self.authorization["ownerId"]
                    .as_str()
                    .expect("tunnel owner"),
                channel(&self.authorization),
                ingress,
                bytes,
            );
        }
    }
    fn send(&self, header: &Value, payload: &[u8]) -> bool {
        if !self.active.load(Ordering::Acquire)
            || self.disconnected.load(Ordering::Acquire)
            || self.socket.state() != 1
            || self.socket.buffered_amount() > 8 * 1024 * 1024
        {
            return false;
        }
        let Ok(frame) = frame::create(header.clone(), payload) else {
            return false;
        };
        let bytes = frame.bytes().len();
        if self.socket.send_binary(frame).is_err() {
            return false;
        }
        self.record(false, bytes);
        true
    }
    pub fn register(
        self: &Arc<Self>,
        broker: &Arc<Broker>,
        bridge: &Arc<WorkerBridge>,
        diagnostic: Option<Value>,
    ) -> Result<Route> {
        let a = &self.authorization;
        let worker = text(&a["destination"], "workerId")?;
        let endpoint_id = format!("worker:{worker}");
        let source = crate::wire::JsString::new(
            [
                "desktop:".encode_utf16().collect::<Vec<_>>(),
                a["clientId"]
                    .as_js_string()
                    .context("Tunnel client")?
                    .units()
                    .to_vec(),
                ":".encode_utf16().collect::<Vec<_>>(),
                a["attachmentId"]
                    .as_js_string()
                    .context("Tunnel attachment")?
                    .units()
                    .to_vec(),
            ]
            .concat(),
        );
        let weak = Arc::downgrade(self);
        let (weak_bridge, worker_send, weak_endpoint) =
            (Arc::downgrade(bridge), worker.clone(), Arc::downgrade(self));
        let target = json!({"kind":"protected-tunnel","targetKind":if a["destination"]["kind"]=="worker-tcp" {"tcp"} else {"project-share"},"recordId":a["tunnelId"],"protectedRecord":a["protectedRecord"]});
        let route = broker.register(Registration {
            tunnel: a["tunnelId"].clone(),
            attachment: a["attachmentId"].clone(),
            source: json!(source),
            destination: json!(endpoint_id),
            target,
            owner: Some(a["ownerId"].clone()),
            worker: Some(json!(worker)),
            diagnostic,
            send_source: Arc::new(move |header, payload| {
                weak.upgrade().is_some_and(|e| e.send(header, payload))
            }),
            send_destination: Arc::new(move |header, payload| {
                let sent = weak_bridge
                    .upgrade()
                    .is_some_and(|b| b.send_tunnel_frame(&worker_send, header.clone(), payload));
                if sent
                    && let (Some(endpoint), Ok(frame)) = (
                        weak_endpoint.upgrade(),
                        frame::create(header.clone(), payload),
                    )
                {
                    endpoint.record(false, frame.bytes().len());
                }
                sent
            }),
        })?;
        *self.frame.lock().unwrap() = Some(route.clone());
        let weak = Arc::downgrade(self);
        route.retain(move || {
            if let Some(endpoint) = weak.upgrade() {
                endpoint.frame.lock().unwrap().take();
            }
        });
        let (weak, receiver, attachment) = (
            Arc::downgrade(self),
            route.clone(),
            a["attachmentId"].clone(),
        );
        let subscription = bridge.subscribe_tunnel_frames(
            &worker,
            Arc::new(move |frame| {
                let header = frame.header();
                if (header["sourceEndpointId"] == endpoint_id
                    || header["destinationEndpointId"] == endpoint_id)
                    && let Some(endpoint) = weak.upgrade()
                    && (endpoint.record.is_none() || header["attachmentId"] == attachment)
                {
                    let encoded = frame::create(header.clone(), frame.payload())?;
                    endpoint.record(true, encoded.bytes().len());
                    receiver.receive(Side::Destination, header, frame.payload());
                }
                Ok(())
            }),
        );
        route.retain(move || drop(subscription));
        *self.disconnect.lock().unwrap() = Some(route.clone());
        let weak = Arc::downgrade(self);
        route.retain(move || {
            if let Some(endpoint) = weak.upgrade() {
                endpoint.disconnect.lock().unwrap().take();
            }
        });
        let receiver = route.clone();
        let subscription =
            bridge.subscribe_worker_offline(&worker, Arc::new(move || receiver.disconnect()));
        route.retain(move || drop(subscription));
        Ok(route)
    }
    pub fn activate(&self) -> bool {
        if self.disconnected.load(Ordering::Acquire) || self.socket.state() != 1 {
            return false;
        }
        self.active.store(true, Ordering::Release);
        true
    }
    pub fn receive(&self, bytes: &[u8], binary: bool) {
        if !binary
            || !self.active.load(Ordering::Acquire)
            || self.disconnected.load(Ordering::Acquire)
        {
            return;
        }
        self.record(true, bytes.len());
        match frame::decode(bytes.to_vec().into()) {
            Ok(frame) => {
                let route = self.frame.lock().unwrap().clone();
                if let Some(route) = route {
                    route.receive(Side::Source, frame.header(), frame.payload());
                }
            }
            Err(_) => self.socket.close(1003, "Invalid tunnel frame"),
        }
    }
    pub fn close(&self, code: u16, reason: &str) {
        if matches!(self.socket.state(), 0 | 1) {
            self.socket.close(code, reason);
        }
        self.disconnect();
    }
    pub fn disconnect(&self) {
        if self.disconnected.swap(true, Ordering::AcqRel) {
            return;
        }
        let route = self.disconnect.lock().unwrap().clone();
        if let Some(route) = route {
            route.disconnect();
        }
        self.disconnect.lock().unwrap().take();
        self.frame.lock().unwrap().take();
    }
}
