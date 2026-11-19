use anyhow::{Context, Result, anyhow, ensure};
use cantrip_transport::output::{Buffered, Queued};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use futures::{SinkExt, StreamExt};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::TcpStream,
    sync::{Semaphore, broadcast, mpsc, oneshot, watch},
    time::timeout,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message, Utf8Bytes, protocol::WebSocketConfig},
};
use url::Url;

const MESSAGE_LIMIT: usize = 16 * 1024 * 1024;
const EVENT_BUFFER: usize = 8 * 1024 * 1024;
const REQUEST_LIMIT: usize = 64;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const CLOSED: &str = "Chromium debugging connection closed.";
const MAX_ID: u64 = (1 << 53) - 1;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Clone)]
pub struct Client {
    state: Arc<State>,
    writer: mpsc::Sender<Outgoing>,
}

struct State {
    last_id: AtomicU64,
    requests: Semaphore,
    write_buffer: Arc<Semaphore>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    events: broadcast::Sender<Event>,
    stop: watch::Sender<bool>,
}

struct Outgoing {
    id: u64,
    text: Utf8Bytes,
    _buffer: tokio::sync::OwnedSemaphorePermit,
}

struct Pending<'a> {
    id: u64,
    pending: &'a Mutex<HashMap<u64, oneshot::Sender<Value>>>,
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.id);
    }
}

#[derive(Clone)]
pub struct Event(Arc<Queued<Value>>);

impl Event {
    pub fn method(&self) -> &str {
        self.0["method"].as_str().expect("validated Chromium event")
    }

    pub fn params(&self) -> &Value {
        &self.0["params"]
    }

    pub fn session_id(&self) -> Option<&JsString> {
        self.0["sessionId"].as_js_string()
    }
}

pub struct Subscription {
    session: Option<JsString>,
    events: broadcast::Receiver<Event>,
    stop: watch::Receiver<bool>,
}

impl Subscription {
    pub async fn next(&mut self) -> Result<Event> {
        if *self.stop.borrow() {
            return Err(anyhow!(CLOSED));
        }
        loop {
            let event = tokio::select! {
                biased;
                _ = self.stop.changed() => return Err(anyhow!(CLOSED)),
                event = self.events.recv() => event.context("Chromium event delivery interrupted.")?,
            };
            if event.session_id() == self.session.as_ref() {
                return Ok(event);
            }
        }
    }
}

pub(super) fn loopback_endpoint(address: &str) -> Result<Url> {
    let url = Url::parse(address).context("Invalid Chromium debugging endpoint.")?;
    ensure!(
        url.scheme() == "ws"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some_and(|port| port != 0)
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url
                .path()
                .strip_prefix("/devtools/browser/")
                .is_some_and(|tail| uuid::Uuid::parse_str(tail).is_ok()),
        "Chromium did not publish a private browser debugging endpoint."
    );
    Ok(url)
}

impl Client {
    pub(super) async fn connect(url: Url) -> Result<Self> {
        let config = WebSocketConfig::default()
            .max_message_size(Some(MESSAGE_LIMIT))
            .max_frame_size(Some(MESSAGE_LIMIT))
            .max_write_buffer_size(MESSAGE_LIMIT + 256 * 1024);
        let (socket, _) = timeout(
            CONNECT_TIMEOUT,
            connect_async_with_config(url.as_str(), Some(config), false),
        )
        .await
        .context("Timed out connecting to Chromium CDP.")??;
        let (writer, writes) = mpsc::channel(REQUEST_LIMIT);
        let (events, _) = broadcast::channel(32);
        let (stop, done) = watch::channel(false);
        let state = Arc::new(State {
            last_id: AtomicU64::new(0),
            requests: Semaphore::new(REQUEST_LIMIT),
            write_buffer: Arc::new(Semaphore::new(MESSAGE_LIMIT)),
            pending: Mutex::new(HashMap::new()),
            events,
            stop,
        });
        tokio::spawn(state.clone().drive(socket, writes, done));
        Ok(Self { state, writer })
    }

    pub fn subscribe(&self, session: Option<&JsString>) -> Subscription {
        Subscription {
            session: session.cloned(),
            events: self.state.events.subscribe(),
            stop: self.state.stop.subscribe(),
        }
    }

    pub fn close(&self) {
        self.state.stop.send_if_modified(|done| {
            let open = !*done;
            *done = true;
            open
        });
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        session: Option<&JsString>,
    ) -> Result<Value> {
        timeout(REQUEST_TIMEOUT, self.send(method, params, session))
            .await
            .with_context(|| format!("Chromium command {method} timed out."))?
    }

    async fn send(&self, method: &str, params: Value, session: Option<&JsString>) -> Result<Value> {
        let _request = self.state.requests.acquire().await.context(CLOSED)?;
        ensure!(!*self.state.stop.borrow(), CLOSED);
        let id = self
            .state
            .last_id
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| {
                (id < MAX_ID).then_some(id + 1)
            })
            .map_err(|_| anyhow!("Chromium command IDs exhausted."))?
            + 1;
        let mut value = json!({"id":id,"method":method,"params":params});
        if let Some(session) = session {
            value["sessionId"] = json!(session);
        }
        let text = value.stringify();
        ensure!(
            text.len() <= MESSAGE_LIMIT,
            "Chromium command is too large."
        );
        let buffer = self
            .state
            .write_buffer
            .clone()
            .try_acquire_many_owned(text.len() as u32)
            .context("Chromium command queue is full.")?;
        let (callback, result) = oneshot::channel();
        self.state.pending.lock().unwrap().insert(id, callback);
        let _pending = Pending {
            id,
            pending: &self.state.pending,
        };
        self.writer
            .send(Outgoing {
                id,
                text: text.into(),
                _buffer: buffer,
            })
            .await
            .map_err(|_| anyhow!(CLOSED))?;
        let result = result.await.context(CLOSED)?;
        if let Some(error) = result.get("error") {
            // Protocol error text may include a private page address.
            let code = error["code"].as_i64().unwrap_or_default();
            return Err(anyhow!("Chromium command {method} failed (CDP {code})."));
        }
        Ok(result.get("result").cloned().unwrap_or(Value::Null))
    }
}

impl State {
    async fn drive(
        self: Arc<Self>,
        mut socket: Socket,
        mut outgoing: mpsc::Receiver<Outgoing>,
        mut done: watch::Receiver<bool>,
    ) {
        let buffer = Buffered::default();
        loop {
            tokio::select! {
                _ = done.changed() => break,
                outbound = outgoing.recv() => {
                    let Some(outbound) = outbound else { break };
                    let pending = self.pending.lock().unwrap().contains_key(&outbound.id);
                    if pending
                        && !matches!(
                            timeout(WRITE_TIMEOUT, socket.send(Message::Text(outbound.text))).await,
                            Ok(Ok(()))
                        )
                    {
                        break;
                    }
                }
                message = socket.next() => match message {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(value) = parse_json_text(text.as_str()) {
                            if let Some(id) = value["id"].as_u64() {
                                if let Some(call) = self.pending.lock().unwrap().remove(&id) {
                                    let _ = call.send(value);
                                }
                            } else if value["method"].as_str().is_some() && self.events.receiver_count() != 0 {
                                let Some(event) = buffer.bounded(value, text.len(), EVENT_BUFFER) else {
                                    break;
                                };
                                let _ = self.events.send(Event(Arc::new(event)));
                            }
                        }
                    }
                    Some(Ok(Message::Ping(_))) => {
                        if !matches!(timeout(WRITE_TIMEOUT, socket.flush()).await, Ok(Ok(()))) {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
        self.stop.send_replace(true);
        self.requests.close();
        self.pending.lock().unwrap().clear();
        let _ = timeout(Duration::from_millis(250), socket.close(None)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    #[tokio::test]
    async fn replies_correlate_out_of_order_and_subscription_is_bound_to_its_target() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = loopback_endpoint(&format!(
            "ws://{}/devtools/browser/6e688dc7-9db3-4b16-8060-efdea7d87011",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = tokio::spawn(async move {
            let (accepted, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(accepted).await.unwrap();
            let mut pending = Vec::new();
            for _ in 0..2 {
                let text = socket.next().await.unwrap().unwrap().into_text().unwrap();
                pending.push(parse_json_text(text.as_str()).unwrap());
            }
            for session in ["separate", "current"] {
                let event = json!({"method":"Page.loadEventFired","sessionId":session,"params":{}});
                socket
                    .send(Message::Text(event.stringify().into()))
                    .await
                    .unwrap();
            }
            for request in pending.iter().rev() {
                let reply = json!({"id":request["id"],"result":request["method"]});
                socket
                    .send(Message::Text(reply.stringify().into()))
                    .await
                    .unwrap();
            }
            // Close with an unanswered request still in flight.
            let _ = socket.next().await;
            socket.close(None).await.unwrap();
        });
        let client = Client::connect(url).await.unwrap();
        let session = JsString::from("current");
        let mut events = client.subscribe(Some(&session));
        let (a, b) = tokio::try_join!(
            client.request("Page.getNavigationHistory", json!({}), Some(&session)),
            client.request("Target.getTargets", json!({}), None)
        )
        .unwrap();
        assert_eq!(a, "Page.getNavigationHistory");
        assert_eq!(b, "Target.getTargets");
        let event = events.next().await.unwrap();
        assert_eq!(event.method(), "Page.loadEventFired");
        assert_eq!(event.session_id(), Some(&session));
        assert!(
            client
                .request("Browser.getVersion", json!({}), None)
                .await
                .is_err()
        );
        server.await.unwrap();
    }
}
