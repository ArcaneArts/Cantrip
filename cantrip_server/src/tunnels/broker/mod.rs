//! Synchronous opaque stream routing. Calls serialize like the Source event
//! loop, while endpoint/activity callbacks may reenter and revoke a route.
mod receive;
use crate::wire::{JsString, Value, coercion, value::json};
use anyhow::{Result, bail};
use indexmap::IndexMap;
use parking_lot::ReentrantMutex;
use std::sync::{Arc, Mutex, Weak};

pub type SendFrame = Arc<dyn Fn(&Value, &[u8]) -> bool + Send + Sync>;
pub type Activity = Arc<dyn Fn(&Value, &Value) -> bool + Send + Sync>;
pub type Consume = Arc<dyn Fn(&Value, &Value, usize) -> bool + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;
pub struct Options {
    pub idle_ms: f64,
    pub lifetime_ms: f64,
    pub bytes_per_second: f64,
    pub max_connections: f64,
    pub max_connections_per_tunnel: f64,
    pub max_routes: f64,
    pub clock: Clock,
    pub activity: Activity,
    pub consume: Consume,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            idle_ms: 300000.0,
            lifetime_ms: 43200000.0,
            bytes_per_second: 67108864.0,
            max_connections: 1024.0,
            max_connections_per_tunnel: 64.0,
            max_routes: 2048.0,
            clock: Arc::new(|| chrono::Utc::now().timestamp_millis() as f64),
            activity: Arc::new(|_, _| true),
            consume: Arc::new(|_, _, _| true),
        }
    }
}
pub struct Registration {
    pub tunnel: Value,
    pub attachment: Value,
    pub source: Value,
    pub destination: Value,
    pub target: Value,
    pub owner: Option<Value>,
    pub worker: Option<Value>,
    pub diagnostic: Option<Value>,
    pub send_source: SendFrame,
    pub send_destination: SendFrame,
}
struct Route {
    key: JsString,
    registration: Registration,
    cleanup: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
}
#[derive(Clone, Copy, PartialEq)]
pub enum Side {
    Source,
    Destination,
}
struct Connection {
    route: Arc<Route>,
    id: Value,
    created: f64,
    last: f64,
    window: f64,
    bandwidth: f64,
    source_sequence: f64,
    destination_sequence: f64,
    source_credit: f64,
    destination_credit: f64,
    source_half: bool,
    destination_half: bool,
    open: bool,
}
type ConnectionRef = Arc<Mutex<Connection>>;
const REASONS: [&str; 8] = [
    "normal",
    "revoked",
    "endpoint-disconnected",
    "idle-timeout",
    "lifetime-expired",
    "congested",
    "bandwidth-limit",
    "protocol-error",
];
struct State {
    routes: IndexMap<JsString, Arc<Route>>,
    connections: IndexMap<JsString, ConnectionRef>,
    bytes_from: f64,
    bytes_to: f64,
    closed: f64,
    opened: f64,
    rejected: f64,
    terminations: [f64; 8],
}
pub struct Broker {
    serial: ReentrantMutex<()>,
    state: Mutex<State>,
    options: Options,
}
#[derive(Clone)]
pub struct Handle {
    broker: Weak<Broker>,
    route: Arc<Route>,
}
fn key(parts: &[&Value]) -> JsString {
    let mut units = Vec::new();
    for (index, value) in parts.iter().enumerate() {
        if index > 0 {
            units.push(0);
        }
        units.extend_from_slice(coercion::string(value).expect("routing identity").units());
    }
    JsString::new(units)
}
fn connection_key(route: &Route, id: &Value) -> JsString {
    key(&[&json!(route.key), id])
}
impl Broker {
    pub fn new(options: Options) -> Arc<Self> {
        Arc::new(Self {
            serial: ReentrantMutex::new(()),
            state: Mutex::new(State {
                routes: IndexMap::new(),
                connections: IndexMap::new(),
                bytes_from: 0.0,
                bytes_to: 0.0,
                closed: 0.0,
                opened: 0.0,
                rejected: 0.0,
                terminations: [0.0; 8],
            }),
            options,
        })
    }
    pub fn register(self: &Arc<Self>, registration: Registration) -> Result<Handle> {
        let _serial = self.serial.lock();
        if registration.source == registration.destination {
            bail!("Tunnel route endpoints require distinct identities.");
        }
        let key = key(&[&registration.tunnel, &registration.attachment]);
        let mut state = self.state.lock().unwrap();
        if state.routes.contains_key(&key) {
            bail!("Tunnel attachment route is already registered.");
        }
        if state.routes.len() as f64 >= self.options.max_routes {
            bail!("Tunnel route limit reached.");
        }
        let route = Arc::new(Route {
            key: key.clone(),
            registration,
            cleanup: Mutex::new(Vec::new()),
        });
        state.routes.insert(key, route.clone());
        Ok(Handle {
            broker: Arc::downgrade(self),
            route,
        })
    }
    fn current_route(&self, route: &Arc<Route>) -> bool {
        self.state
            .lock()
            .unwrap()
            .routes
            .get(&route.key)
            .is_some_and(|r| Arc::ptr_eq(r, route))
    }
    fn activity(&self, route: &Arc<Route>) -> bool {
        (self.options.activity)(&route.registration.tunnel, &route.registration.attachment)
            && self.current_route(route)
    }
    pub fn record_activity(&self, tunnel: &Value, attachment: &Value) -> bool {
        let _serial = self.serial.lock();
        let route = self
            .state
            .lock()
            .unwrap()
            .routes
            .get(&key(&[tunnel, attachment]))
            .cloned();
        route.is_some_and(|route| self.activity(&route))
    }
    pub fn revoke_attachment(&self, attachment: &Value) -> usize {
        let _serial = self.serial.lock();
        let routes = self
            .state
            .lock()
            .unwrap()
            .routes
            .values()
            .filter(|r| r.registration.attachment == *attachment)
            .cloned()
            .collect::<Vec<_>>();
        for route in &routes {
            self.remove(route, "revoked");
        }
        routes.len()
    }
    pub fn sweep(&self, now: Option<f64>) {
        let _serial = self.serial.lock();
        let now = now.unwrap_or_else(|| (self.options.clock)());
        let connections = self
            .state
            .lock()
            .unwrap()
            .connections
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for connection in connections {
            let reason = {
                let connection = connection.lock().unwrap();
                if now - connection.created >= self.options.lifetime_ms {
                    Some("lifetime-expired")
                } else if now - connection.last >= self.options.idle_ms {
                    Some("idle-timeout")
                } else {
                    None
                }
            };
            if let Some(reason) = reason {
                self.terminate(&connection, reason);
            }
        }
    }
    pub fn close(&self) {
        let _serial = self.serial.lock();
        let routes = self
            .state
            .lock()
            .unwrap()
            .routes
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for route in routes {
            self.remove(&route, "endpoint-disconnected");
        }
    }
    pub fn stats(&self) -> Value {
        let _serial = self.serial.lock();
        let s = self.state.lock().unwrap();
        let reasons = Value::object(
            REASONS
                .iter()
                .zip(s.terminations)
                .map(|(reason, count)| (*reason, json!(count))),
        );
        json!({"activeConnections":s.connections.len(),"activeRoutes":s.routes.len(),"bytesFromSource":s.bytes_from,"bytesToSource":s.bytes_to,"closedConnections":s.closed,"openedConnections":s.opened,"rejectedConnections":s.rejected,"terminationsByReason":reasons})
    }
    fn identities(route: &Route, id: &Value, sequence: f64) -> Value {
        let r = &route.registration;
        json!({"protocolVersion":1,"tunnelId":r.tunnel,"attachmentId":r.attachment,"sourceEndpointId":r.source,"destinationEndpointId":r.destination,"connectionId":id,"sequence":sequence})
    }
    fn send(route: &Route, recipient: Side, header: &Value, payload: &[u8]) -> bool {
        if recipient == Side::Source {
            (route.registration.send_source)(header, payload)
        } else {
            (route.registration.send_destination)(header, payload)
        }
    }
    fn forward(&self, connection: &ConnectionRef, recipient: Side, header: &Value, payload: &[u8]) {
        let route = connection.lock().unwrap().route.clone();
        if !Self::send(&route, recipient, header, payload) {
            self.terminate(connection, "congested");
        }
    }
    fn finish(&self, connection: &ConnectionRef) {
        let key = {
            let c = connection.lock().unwrap();
            connection_key(&c.route, &c.id)
        };
        let mut state = self.state.lock().unwrap();
        if state.connections.shift_remove(&key).is_some() {
            state.closed += 1.0;
        }
    }
    fn terminate(&self, connection: &ConnectionRef, reason: &str) {
        let (route, source, destination) = {
            let c = connection.lock().unwrap();
            let mut s = self.state.lock().unwrap();
            if !s.connections.contains_key(&connection_key(&c.route, &c.id)) {
                return;
            }
            s.terminations[REASONS
                .iter()
                .position(|r| *r == reason)
                .expect("tunnel close code")] += 1.0;
            (
                c.route.clone(),
                Self::identities(&c.route, &c.id, c.destination_sequence),
                Self::identities(&c.route, &c.id, c.source_sequence),
            )
        };
        for (side, mut header) in [(Side::Source, source), (Side::Destination, destination)] {
            header["kind"] = json!("close");
            header["code"] = json!(reason);
            Self::send(&route, side, &header, &[]);
        }
        self.finish(connection);
    }
    fn remove(&self, route: &Arc<Route>, reason: &str) {
        let connections = {
            let mut s = self.state.lock().unwrap();
            if !s
                .routes
                .get(&route.key)
                .is_some_and(|r| Arc::ptr_eq(r, route))
            {
                return;
            }
            s.routes.shift_remove(&route.key);
            s.connections
                .values()
                .filter(|c| Arc::ptr_eq(&c.lock().unwrap().route, route))
                .cloned()
                .collect::<Vec<_>>()
        };
        for c in connections {
            self.terminate(&c, reason);
        }
        let cleanup = std::mem::take(&mut *route.cleanup.lock().unwrap());
        for unsubscribe in cleanup {
            unsubscribe();
        }
    }
}
impl Handle {
    /// Installation and cancellation serialize with route removal. Source
    /// subscriptions are removed after connection close frames, in order.
    pub fn retain(&self, unsubscribe: impl FnOnce() + Send + 'static) {
        let mut unsubscribe: Option<Box<dyn FnOnce() + Send>> = Some(Box::new(unsubscribe));
        if let Some(broker) = self.broker.upgrade() {
            let _serial = broker.serial.lock();
            if broker.current_route(&self.route) {
                self.route
                    .cleanup
                    .lock()
                    .unwrap()
                    .push(unsubscribe.take().unwrap());
            }
        }
        if let Some(unsubscribe) = unsubscribe {
            unsubscribe();
        }
    }
    pub fn is_active(&self) -> bool {
        self.broker.upgrade().is_some_and(|b| {
            let _serial = b.serial.lock();
            b.current_route(&self.route)
        })
    }
    pub fn close(&self) {
        if let Some(broker) = self.broker.upgrade() {
            let _serial = broker.serial.lock();
            broker.remove(&self.route, "normal");
        }
    }
    pub fn disconnect(&self) {
        if let Some(broker) = self.broker.upgrade() {
            let _serial = broker.serial.lock();
            broker.remove(&self.route, "endpoint-disconnected");
        }
    }
    pub fn receive(&self, sender: Side, header: &Value, payload: &[u8]) {
        if let Some(broker) = self.broker.upgrade() {
            let _serial = broker.serial.lock();
            broker.receive(&self.route, sender, header, payload);
        }
    }
}
