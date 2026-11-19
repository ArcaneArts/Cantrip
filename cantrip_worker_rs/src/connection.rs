//! Worker-owned control socket. Resource execution and data planes are separate
//! adapters; opening TCP never grants command readiness or execution authority.
use crate::{
    config::Config,
    http::checked,
    logging::{self, Logs},
    worker_link::Coordinator,
};
use anyhow::{Result, anyhow};
use cantrip_framing::tunnel;
use cantrip_wire::{Value, parse_json_text, value::json};
use futures::{SinkExt, StreamExt};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::Duration,
};
use tokio::{
    sync::{Notify, mpsc, watch},
    time::Instant,
};
use tokio_tungstenite::tungstenite::{
    self, Message,
    client::IntoClientRequest,
    protocol::{CloseFrame, frame::coding::CloseCode},
};

const PROTOCOLS: &str =
    "cantrip-worker-legacy, cantrip-worker-auth-ready-v1, cantrip-worker-auth-ready-v2";
const MAX_PENDING: usize = 8 * 1024 * 1024;
const MAX_BUFFERED_NOTIFICATION_BYTES: usize = 1024 * 1024;
#[derive(Debug, PartialEq, Eq)]
pub enum Negotiation {
    Other,
    Pending,
    Ready(Option<String>),
    Close(&'static str),
}
#[derive(Default)]
pub struct Handshake {
    pub ready: bool,
    pub protocol_pending: bool,
    pending: Option<Option<String>>,
}
impl Handshake {
    pub fn opened(protocol: Option<&str>) -> Self {
        Self {
            ready: protocol == Some("cantrip-worker-legacy"),
            protocol_pending: matches!(
                protocol,
                Some("cantrip-worker-auth-ready-v1" | "cantrip-worker-auth-ready-v2")
            ),
            pending: None,
        }
    }
    pub fn envelope(&mut self, value: &Value, generation: &str) -> Negotiation {
        if value["kind"] != "connection" {
            return Negotiation::Other;
        }
        let Ok(value) = checked("workerConnectionEnvelopeSchema", value) else {
            return Negotiation::Close("Invalid worker connection envelope");
        };
        if value["connectionGeneration"] != generation {
            return Negotiation::Close("Worker connection generation mismatch");
        }
        let issuer = if value["protocolVersion"] == 2 {
            value["serverControlPlaneGeneration"]
                .as_str()
                .map(str::to_owned)
        } else {
            None
        };
        if value["state"] == "pending" {
            self.pending = Some(issuer);
            if !self.ready {
                self.protocol_pending = true;
            }
            return Negotiation::Pending;
        }
        if !self.protocol_pending || self.pending.as_ref() != Some(&issuer) {
            return Negotiation::Close("Worker connection became ready before pending");
        }
        self.ready = true;
        self.protocol_pending = false;
        Negotiation::Ready(issuer)
    }
    pub fn legacy_request(&mut self) -> bool {
        if self.protocol_pending {
            return false;
        }
        self.ready = true;
        true
    }
}

/// The original capped exponential reconnect jitter, separated for fixtures.
pub fn reconnect_delay(base_ms: u64, failed_attempts: u32, random: f64) -> Duration {
    let ceiling =
        (base_ms as f64 * 2_f64.powi(failed_attempts.saturating_sub(1).min(4) as i32)).min(15000.);
    Duration::from_millis(
        (ceiling * (0.75 + random.clamp(0., 1.) * 0.25))
            .floor()
            .max(1.) as u64,
    )
}
struct Frame {
    encoded: Message,
    terminal: bool,
}
struct Queue {
    frames: VecDeque<Frame>,
    bytes: usize,
    in_flight: usize,
    ready: bool,
    closed: bool,
}
pub struct Outbound {
    queue: Mutex<Queue>,
    wake: Notify,
    binary_capacity: Notify,
    observations: OnceLock<Weak<Coordinator>>,
    stream_epoch: watch::Sender<u64>,
}
impl Default for Outbound {
    fn default() -> Self {
        Self {
            queue: Mutex::new(Queue {
                frames: VecDeque::new(),
                bytes: 0,
                in_flight: 0,
                ready: false,
                closed: false,
            }),
            wake: Notify::new(),
            binary_capacity: Notify::new(),
            observations: OnceLock::new(),
            stream_epoch: watch::channel(0).0,
        }
    }
}
impl Outbound {
    /// Observations are retried by their producer while disconnected or
    /// congested. They must not be treated as accepted offline responses.
    pub fn notification(&self, notification: Value) -> Result<bool> {
        if let Some(gateway) = self.observations.get().and_then(Weak::upgrade) {
            gateway.publish_notification(&notification);
        }
        let notification =
            crate::git::worktrees::observations::notification::for_server(&notification);
        let encoded = checked(
            "workerServerEnvelopeSchema",
            &json!({"kind":"notification","notification":notification}),
        )?
        .stringify();
        let mut queue = self.queue.lock().unwrap();
        if queue.closed
            || !queue.ready
            || queue.bytes + queue.in_flight > MAX_BUFFERED_NOTIFICATION_BYTES
        {
            return Ok(false);
        }
        queue.bytes += encoded.len();
        queue.frames.push_back(Frame {
            encoded: Message::Text(encoded.into()),
            terminal: false,
        });
        drop(queue);
        self.wake.notify_one();
        Ok(true)
    }
    pub fn send(&self, envelope: Value) -> Result<bool> {
        let encoded = checked("workerServerEnvelopeSchema", &envelope)?.stringify();
        let mut queue = self.queue.lock().unwrap();
        if queue.closed {
            return Ok(false);
        }
        if !queue.ready {
            while queue.bytes + encoded.len() > MAX_PENDING {
                let Some(old) = queue.frames.pop_front() else {
                    break;
                };
                queue.bytes -= old.encoded.len();
            }
            if encoded.len() > MAX_PENDING {
                return Ok(false);
            }
        }
        queue.bytes += encoded.len();
        queue.frames.push_back(Frame {
            encoded: Message::Text(encoded.into()),
            terminal: false,
        });
        drop(queue);
        self.wake.notify_one();
        Ok(true)
    }
    pub(crate) fn observe_with(&self, gateway: &Arc<Coordinator>) {
        assert!(self.observations.set(Arc::downgrade(gateway)).is_ok());
    }

    pub(crate) async fn binary_writable(&self) {
        self.binary_capacity.notified().await;
    }

    pub(crate) fn worker_link(&self, frame: cantrip_framing::worker_link::Frame) -> bool {
        self.binary(frame.bytes())
    }

    pub(crate) fn binary(&self, bytes: &[u8]) -> bool {
        let mut queue = self.queue.lock().unwrap();
        if queue.closed || !queue.ready || queue.bytes + queue.in_flight + bytes.len() > MAX_PENDING
        {
            return false;
        }
        queue.bytes += bytes.len();
        queue.frames.push_back(Frame {
            encoded: Message::Binary(bytes.to_vec().into()),
            terminal: true,
        });
        drop(queue);
        self.wake.notify_one();
        true
    }

    pub fn stream_epoch(&self) -> watch::Receiver<u64> {
        self.stream_epoch.subscribe()
    }
    /// Terminal views belong to their connected control socket. Keep their
    /// output bounded and never queue it for a replacement socket.
    pub fn terminal_event(&self, epoch: u64, envelope: Value) -> Result<bool> {
        let encoded = checked("workerServerEnvelopeSchema", &envelope)?.stringify();
        let mut queue = self.queue.lock().unwrap();
        if queue.closed
            || !queue.ready
            || *self.stream_epoch.borrow() != epoch
            || queue.bytes + queue.in_flight + encoded.len() > MAX_PENDING
        {
            return Ok(false);
        }
        queue.bytes += encoded.len();
        queue.frames.push_back(Frame {
            encoded: Message::Text(encoded.into()),
            terminal: true,
        });
        drop(queue);
        self.wake.notify_one();
        Ok(true)
    }
    fn ready(&self, ready: bool) {
        let mut queue = self.queue.lock().unwrap();
        if queue.ready && !ready {
            self.stream_epoch.send_modify(|epoch| *epoch += 1);
            queue.frames.retain(|frame| !frame.terminal);
            queue.bytes = queue.frames.iter().map(|frame| frame.encoded.len()).sum();
        }
        queue.ready = ready;
    }
    fn take(&self) -> Option<Frame> {
        let mut queue = self.queue.lock().unwrap();
        let value = queue.frames.pop_front()?;
        queue.bytes -= value.encoded.len();
        queue.in_flight += value.encoded.len();
        Some(value)
    }
    fn sent(&self, length: usize) {
        let mut queue = self.queue.lock().unwrap();
        queue.in_flight = queue.in_flight.saturating_sub(length);
        self.binary_capacity.notify_one();
    }
    fn restore(&self, value: Frame) {
        let mut queue = self.queue.lock().unwrap();
        queue.in_flight = queue.in_flight.saturating_sub(value.encoded.len());
        if value.terminal {
            return;
        }
        queue.bytes += value.encoded.len();
        queue.frames.push_front(value);
        while queue.bytes > MAX_PENDING {
            let old = queue.frames.pop_front().unwrap();
            queue.bytes -= old.encoded.len();
        }
    }
    pub fn close(&self) {
        let mut q = self.queue.lock().unwrap();
        q.closed = true;
        q.frames.clear();
        q.bytes = 0;
        q.in_flight = 0;
        self.wake.notify_one();
    }
}

pub struct Connection {
    pub configuration: Arc<Mutex<Config>>,
    pub logs: Arc<Logs>,
    pub outgoing: Arc<Outbound>,
    pub requests: mpsc::UnboundedSender<Value>,
    pub stop: watch::Receiver<bool>,
    pub generation: String,
    pub on_ready: Arc<dyn Fn() + Send + Sync>,
    pub(crate) worker_link: Arc<Coordinator>,
}
impl Connection {
    pub async fn run(mut self) -> Result<()> {
        let worker = self.configuration.lock().unwrap().worker_id.clone();
        self.logs.event(
            "info",
            "Worker command channel starting",
            json!({"event":"worker.connection.starting","workerId":worker}),
        );
        let mut attempts = 0_u32;
        let mut omit_protocols = false;
        let mut issuer = None;
        let mut sequence = String::new();
        let mut last_error = None;
        loop {
            if *self.stop.borrow() {
                break;
            }
            attempts = attempts.saturating_add(1);
            let request = {
                let config = self.configuration.lock().unwrap();
                let mut url = url::Url::parse(&config.server_url)?;
                let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
                url.set_scheme(scheme)
                    .map_err(|_| anyhow!("Invalid worker socket URL"))?;
                url.set_path("/api/internal/workers/connect");
                url.set_fragment(None);
                url.query_pairs_mut()
                    .clear()
                    .append_pair("workerId", &config.worker_id.lossy())
                    .append_pair("connectionGeneration", &self.generation);
                let mut request = url.as_str().into_client_request()?;
                request
                    .headers_mut()
                    .insert("authorization", format!("Bearer {}", config.token).parse()?);
                if !omit_protocols {
                    request
                        .headers_mut()
                        .insert("sec-websocket-protocol", PROTOCOLS.parse()?);
                }
                request
            };
            omit_protocols = false;
            let connected = tokio::select! {
                _=self.stop.changed()=>break,
                result=tokio_tungstenite::connect_async_with_config(request,Some(tungstenite::protocol::WebSocketConfig::default().max_message_size(Some(100*1024*1024)).max_frame_size(Some(100*1024*1024))),true)=>result,
            };
            match connected {
                Ok((mut socket, response)) => {
                    last_error = None;
                    let protocol = response
                        .headers()
                        .get("sec-websocket-protocol")
                        .and_then(|v| v.to_str().ok());
                    let mut handshake = Handshake::opened(protocol);
                    let mut ready_deadline = handshake
                        .protocol_pending
                        .then(|| Instant::now() + Duration::from_secs(15));
                    let mut next_ping = Instant::now() + Duration::from_secs(20);
                    let mut pong: Option<(Vec<u8>, Instant)> = None;
                    if handshake.ready {
                        self.connected(&worker, attempts, "legacy-subprotocol");
                        attempts = 0;
                        if issuer.take().is_some() {
                            sequence.clear();
                        }
                    }
                    let mut rejected = false;
                    loop {
                        if *self.stop.borrow() {
                            close_socket(&mut socket, CloseCode::Normal, "Worker stopping").await;
                            break;
                        }
                        if handshake.ready
                            && let Some(frame) = self.outgoing.take()
                        {
                            if !matches!(
                                tokio::time::timeout(
                                    Duration::from_secs(10),
                                    socket.send(frame.encoded.clone())
                                )
                                .await,
                                Ok(Ok(()))
                            ) {
                                self.outgoing.ready(false);
                                self.outgoing.restore(frame);
                                break;
                            }
                            self.outgoing.sent(frame.encoded.len());
                            continue;
                        }
                        let mut deadline = if handshake.ready {
                            next_ping
                        } else {
                            Instant::now() + Duration::from_secs(86400)
                        };
                        if let Some(at) = ready_deadline {
                            deadline = deadline.min(at);
                        }
                        if let Some((_, at)) = &pong {
                            deadline = deadline.min(*at);
                        }
                        tokio::select! {
                            _=self.stop.changed()=>{},
                            _=self.outgoing.wake.notified(),if handshake.ready=>{},
                            _=tokio::time::sleep_until(deadline)=>{
                                let now=Instant::now();
                                if ready_deadline.is_some_and(|at|at<=now) {close_socket(&mut socket,CloseCode::Again,"Worker connection did not become ready").await;break;}
                                if pong.as_ref().is_some_and(|(_,at)|*at<=now) {break;}
                                if next_ping<=now && handshake.ready {
                                    next_ping=now+Duration::from_secs(20);
                                    if pong.is_none() {
                                        let mut nonce=vec![0;16];getrandom::fill(&mut nonce).map_err(|e|anyhow!("{e}"))?;
                                        if !matches!(tokio::time::timeout(Duration::from_secs(10),socket.send(Message::Ping(nonce.clone().into()))).await,Ok(Ok(()))) {break;}
                                        pong=Some((nonce,Instant::now()+Duration::from_secs(10)));
                                    }
                                }
                            },
                            frame=socket.next()=>match frame {
                                Some(Ok(Message::Text(text)))=>{
                                    let Ok(value)=parse_json_text(&text) else {self.invalid(&worker);continue;};
                                    match handshake.envelope(&value,&self.generation) {
                                        Negotiation::Close(reason)=>{close_socket(&mut socket,CloseCode::Protocol,reason).await;break;},
                                        Negotiation::Pending=>{if !handshake.ready && ready_deadline.is_none() {ready_deadline=Some(Instant::now()+Duration::from_secs(15));}continue;},
                                        Negotiation::Ready(new_issuer)=>{
                                            if issuer!=new_issuer {sequence.clear();issuer=new_issuer;}
                                            ready_deadline=None;next_ping=Instant::now()+Duration::from_secs(20);self.connected(&worker,attempts,"protocol");attempts=0;continue;
                                        },
                                        Negotiation::Other=>{},
                                    }
                                    let Ok(mut request)=checked("workerRequestEnvelopeSchema",&value) else {self.invalid(&worker);continue;};
                                    if !handshake.ready {
                                        if !handshake.legacy_request() {continue;}
                                        if issuer.take().is_some(){sequence.clear();}
                                        self.connected(&worker,attempts,"legacy-request");attempts=0;
                                    }
                                    if issuer.is_some() && let Some(next)=request["inferenceSequence"].as_str() {
                                        if next.len()<sequence.len() || (next.len()==sequence.len() && next<=sequence.as_str()) {continue;}
                                        sequence=next.into();
                                    }
                                    request["socketEpoch"] = json!(*self.outgoing.stream_epoch.borrow());
                                    let _=self.requests.send(request);
                                },
                                Some(Ok(Message::Pong(value)))=>{if pong.as_ref().is_some_and(|(nonce,_)|nonce.as_slice()==value.as_ref()) {pong=None;}},
                                Some(Ok(Message::Ping(_)))=>{if !matches!(tokio::time::timeout(Duration::from_secs(10),socket.flush()).await,Ok(Ok(()))){break;}},
                                Some(Ok(Message::Close(frame)))=>{rejected=frame.is_some_and(|frame|frame.code==CloseCode::Policy);break;},
                                Some(Ok(Message::Binary(bytes))) if handshake.ready && tunnel::is_frame(&bytes)=>{
                                    match tunnel::decode(Arc::from(bytes.as_ref())) {
                                        Ok(frame) => self.worker_link.handle_tunnel_frame(frame),
                                        Err(_) => self.invalid(&worker),
                                    }
                                },
                                Some(Ok(Message::Binary(bytes))) if handshake.ready && cantrip_framing::worker_link::is_frame(&bytes)=>{
                                    match cantrip_framing::worker_link::decode(Arc::from(bytes.as_ref())) {
                                        Ok(frame) => self.worker_link.handle_frame(&frame),
                                        Err(_) => self.invalid(&worker),
                                    }
                                },
                                Some(Ok(Message::Binary(_)))=>{self.logs.event("warn","Worker data-plane adapter is not yet available",json!({"event":"worker.transport.frame-unavailable","workerId":worker}));},
                                Some(Err(_))|None=>break,
                                _=>{},
                            }
                        }
                    }
                    self.outgoing.ready(false);
                    self.worker_link.disconnected();
                    if rejected {
                        self.authentication_rejected(&worker, None);
                        self.outgoing.close();
                        return Ok(());
                    }
                }
                Err(tungstenite::Error::Http(response))
                    if [401, 403].contains(&response.status().as_u16()) =>
                {
                    self.authentication_rejected(&worker, Some(response.status().as_u16()));
                    self.outgoing.close();
                    return Ok(());
                }
                Err(error) => {
                    if matches!(
                        error,
                        tungstenite::Error::Protocol(
                            tungstenite::error::ProtocolError::SecWebSocketSubProtocolError(
                                tungstenite::error::SubProtocolError::NoSubProtocol
                            )
                        )
                    ) {
                        omit_protocols = true;
                    }
                    let message = error.to_string();
                    if last_error.as_ref() != Some(&message) {
                        last_error = Some(message);
                        self.logs.repeated(format!("worker-connection-error:{}",worker.lossy()),"warn","Worker command channel unavailable",json!({"event":"worker.connection.failed","workerId":worker,"error":logging::error(&anyhow!(error))}));
                    }
                }
            }
            if *self.stop.borrow() {
                break;
            }
            let mut random = [0; 8];
            getrandom::fill(&mut random).map_err(|e| anyhow!("{e}"))?;
            let delay = reconnect_delay(
                1000,
                attempts,
                u64::from_le_bytes(random) as f64 / u64::MAX as f64,
            );
            self.logs.event("warn","Worker command channel disconnected",json!({"event":"worker.connection.disconnected","workerId":worker,"reconnectDelayMs":delay.as_millis() as u64}));
            tokio::select! {_=self.stop.changed()=>break,_=tokio::time::sleep(delay)=>{}};
        }
        self.outgoing.close();
        self.logs.event(
            "info",
            "Worker command channel stopped",
            json!({"event":"worker.connection.stopped","workerId":worker}),
        );
        Ok(())
    }
    fn connected(&self, worker: &cantrip_wire::JsString, attempt: u32, negotiation: &str) {
        self.outgoing.ready(true);
        self.worker_link.connected();
        (self.on_ready)();
        self.logs.event("info","Worker command channel connected",json!({"event":"worker.connection.connected","subsystem":"worker-connection","operation":"connect","status":"completed","workerId":worker,"attempt":attempt,"negotiation":negotiation}));
    }
    fn invalid(&self, worker: &cantrip_wire::JsString) {
        self.logs.event("warn","Worker command envelope was rejected",json!({"event":"worker.command.rejected","workerId":worker,"reasonCode":"invalid-envelope"}));
    }
    fn authentication_rejected(&self, worker: &cantrip_wire::JsString, status: Option<u16>) {
        self.worker_link.revoke_all();
        let mut context = json!({"event":"worker.connection.authentication-rejected","subsystem":"worker-connection","operation":"authenticate","workerId":worker,"reasonCode":"authentication-rejected","status":"rejected"});
        context[if status.is_some() {
            "httpStatus"
        } else {
            "closeCode"
        }] = json!(status.unwrap_or(1008));
        self.logs.event("warn","Command channel authentication rejected; update or re-enroll this worker, then restart it",context);
    }
}
async fn close_socket(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    code: CloseCode,
    reason: &'static str,
) {
    let _ = tokio::time::timeout(
        Duration::from_secs(1),
        socket.close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })),
    )
    .await;
}

#[cfg(test)]
mod observation_tests {
    use super::*;
    fn notification() -> Value {
        json!({"type":"worktree.filesystem.changed","sourcePath":"/repo","worktreePath":"/repo","changes":vec![json!({"path":"private","kind":"added"})]})
    }
    #[test]
    fn observations_require_readiness_and_strip_private_file_activity() {
        let outgoing = Outbound::default();
        assert!(!outgoing.notification(notification()).unwrap());
        assert!(outgoing.take().is_none());
        outgoing.ready(true);
        assert!(outgoing.notification(notification()).unwrap());
        let frame = parse_json_text(outgoing.take().unwrap().encoded.to_text().unwrap()).unwrap();
        assert!(frame["notification"].get("changes").is_none());
        outgoing.close();
        assert!(!outgoing.notification(notification()).unwrap());
    }
    #[test]
    fn observations_reject_congestion_without_discarding_accepted_responses() {
        let outgoing = Outbound::default();
        outgoing.ready(true);
        assert!(outgoing.send(json!({"kind":"response","requestId":"fixture-response","ok":true,"result":"x".repeat(MAX_BUFFERED_NOTIFICATION_BYTES+1)})).unwrap());
        assert!(!outgoing.notification(notification()).unwrap());
        let writing = outgoing.take().unwrap();
        assert!(
            !outgoing.notification(notification()).unwrap(),
            "in-flight bytes still exert backpressure"
        );
        outgoing.sent(writing.encoded.len());
        assert!(outgoing.notification(notification()).unwrap());
    }

    #[test]
    fn terminal_frames_expire_with_their_socket_but_command_responses_survive() {
        let outgoing = Outbound::default();
        let mut epoch = outgoing.stream_epoch();
        let terminal =
            json!({"kind":"event","requestId":"terminal","event":json!({"type":"terminal.ready"})});
        let response =
            json!({"kind":"response","requestId":"fixture-response","ok":true,"result":true});
        let first = *epoch.borrow_and_update();
        outgoing.ready(true);
        assert!(outgoing.terminal_event(first, terminal.clone()).unwrap());
        let in_flight = outgoing.take().unwrap();
        assert!(outgoing.terminal_event(first, terminal.clone()).unwrap());
        assert!(outgoing.send(response).unwrap());
        outgoing.ready(false);
        outgoing.restore(in_flight);
        assert!(epoch.has_changed().unwrap());
        outgoing.ready(true);
        assert!(!outgoing.terminal_event(first, terminal.clone()).unwrap());
        let frame = outgoing.take().unwrap();
        assert!(
            frame
                .encoded
                .to_text()
                .unwrap()
                .contains("fixture-response")
        );
        assert!(outgoing.take().is_none());
        let next = *epoch.borrow_and_update();
        assert!(outgoing.terminal_event(next, terminal).unwrap());
    }
}
