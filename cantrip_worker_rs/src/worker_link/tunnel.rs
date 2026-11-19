//! Host tunnel destinations and the carriers that own their logical streams.
mod legacy;
mod tcp;

use super::{Coordinator, id};
use crate::{logging::Logs, protected_content::open_tunnel_record};
use cantrip_framing::tunnel::{self as wire, Frame};
use cantrip_wire::{JsString, Value, value::json};
pub(super) use legacy::Legacy;
use std::{
    collections::HashMap,
    net::{Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{Arc, Weak},
};
use tokio::{
    sync::{Semaphore, mpsc, watch},
    task::{AbortHandle, JoinSet},
};
use uuid::Uuid;

pub(super) const MAX_STREAMS: usize = 256;
const INBOUND_FRAMES: usize = 128;
const FROM_SOURCE: &str = "source-to-destination";
const FROM_DESTINATION: &str = "destination-to-source";

pub(super) enum Inbound {
    Retained,
    Consumed,
    Reply(Frame),
}

pub(super) enum Output {
    Queued,
    Pending,
    Closed,
}

pub(super) struct Tunnel {
    pub attachment: JsString,
    resource: JsString,
    source: Value,
    destination: Value,
    link: Link,
    limit: Arc<Semaphore>,
    streams: Streams,
}

struct Streams {
    capacity: watch::Sender<()>,
    active: HashMap<[JsString; 3], StreamSlot>,
    tasks: JoinSet<()>,
}

struct StreamSlot {
    source: Value,
    destination: Value,
    input: mpsc::Sender<Frame>,
    stop: watch::Sender<Option<Stop>>,
    task: AbortHandle,
    next: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stop {
    RemoteClosed,
    Protocol,
    Congested,
}

#[derive(Clone)]
enum Carrier {
    WorkerLink { channel: JsString, token: Uuid },
    Legacy { token: Uuid },
}

#[derive(Clone)]
struct Link {
    gateway: Weak<Coordinator>,
    logs: Arc<Logs>,
    carrier: Carrier,
}

impl Tunnel {
    pub fn open(
        gateway: &Arc<Coordinator>,
        header: &Value,
        grant: &Value,
    ) -> Result<Box<Self>, &'static str> {
        let resource = &grant["resource"];
        let attachment = resource["attachmentId"]
            .as_js_string()
            .ok_or("resource-unavailable")?;
        let operations = grant["operations"].as_array().unwrap();
        if !operations.contains(&json!("stream:read"))
            || !operations.contains(&json!("stream:write"))
            || operations.contains(&json!("stream:guest-connect"))
            || operations.contains(&json!("stream:guest-listen"))
        {
            return Err("resource-unavailable");
        }
        Ok(Box::new(Self {
            attachment: attachment.clone(),
            resource: id(resource, "resourceId").clone(),
            source: json!(format!("worker-link-client:{}", id(grant, "grantId"))),
            destination: json!(format!("worker-link-worker:{}", gateway.worker)),
            link: Link {
                gateway: Arc::downgrade(gateway),
                logs: gateway.logs.clone(),
                carrier: Carrier::WorkerLink {
                    channel: id(&header["channel"], "channelId").clone(),
                    token: Uuid::new_v4(),
                },
            },
            limit: gateway.tunnel_streams.clone(),
            streams: Streams::default(),
        }))
    }

    pub fn token(&self) -> Uuid {
        let Carrier::WorkerLink { token, .. } = &self.link.carrier else {
            unreachable!("WorkerLink attachment carrier");
        };
        *token
    }

    pub fn writable(&self) {
        self.streams.capacity.send_replace(());
    }

    pub fn receive(&mut self, bytes: &[u8]) -> Result<Inbound, &'static str> {
        let frame = wire::decode(bytes.into()).map_err(|_| "protocol-error")?;
        let header = frame.header();
        let protected = &header["target"];
        if !is_source_frame(header)
            || header["tunnelId"].as_js_string() != Some(&self.resource)
            || header["attachmentId"].as_js_string() != Some(&self.attachment)
            || header["sourceEndpointId"] != self.source
            || header["destinationEndpointId"] != self.destination
            || (header["kind"] == "connect"
                && (protected["kind"] != "protected-tunnel"
                    || protected["recordId"].as_js_string() != Some(&self.resource)))
        {
            return Err("protocol-error");
        }
        self.streams.receive(frame, &self.link, &self.limit)
    }
}

fn is_source_frame(header: &Value) -> bool {
    match header["kind"].as_str() {
        Some("connect" | "close" | "error") => true,
        Some("data" | "half-close") => header["direction"] == FROM_SOURCE,
        Some("credit") => header["direction"] == FROM_DESTINATION,
        _ => false,
    }
}

impl Default for Streams {
    fn default() -> Self {
        Self {
            capacity: watch::channel(()).0,
            active: HashMap::new(),
            tasks: JoinSet::new(),
        }
    }
}

impl Streams {
    fn receive(
        &mut self,
        frame: Frame,
        link: &Link,
        limit: &Arc<Semaphore>,
    ) -> Result<Inbound, &'static str> {
        let header = frame.header();
        let key = ["tunnelId", "attachmentId", "connectionId"].map(|name| id(header, name).clone());
        if header["kind"] == "connect" {
            while self.tasks.try_join_next().is_some() {}
            self.active.retain(|_, slot| !slot.task.is_finished());
            if self.active.contains_key(&key) {
                return Ok(Inbound::Reply(
                    Reply::new(header).rejected("protocol-error"),
                ));
            }
            let Ok(permit) = limit.clone().try_acquire_owned() else {
                return Ok(Inbound::Reply(
                    Reply::new(header).rejected("limit-exceeded"),
                ));
            };
            let (sender, receiver) = mpsc::channel(INBOUND_FRAMES);
            let (stop, stopped) = watch::channel(None);
            let source = header["sourceEndpointId"].clone();
            let destination = header["destinationEndpointId"].clone();
            let link = link.clone();
            let capacity = self.capacity.subscribe();
            let task = self.tasks.spawn(async move {
                let _permit = permit;
                tcp::serve(link, capacity, frame, receiver, stopped).await;
            });
            self.active.insert(
                key,
                StreamSlot {
                    source,
                    destination,
                    input: sender,
                    stop,
                    task,
                    next: 1,
                },
            );
            return Ok(Inbound::Consumed);
        }
        let Some(slot) = self.active.get_mut(&key) else {
            return Ok(Inbound::Consumed);
        };
        if slot.source != header["sourceEndpointId"]
            || slot.destination != header["destinationEndpointId"]
        {
            return Err("protocol-error");
        }
        if slot.stop.borrow().is_some() {
            return Ok(Inbound::Consumed);
        }
        if header["sequence"].as_u64() != Some(slot.next) {
            slot.stop.send_replace(Some(Stop::Protocol));
            return Ok(Inbound::Consumed);
        }
        slot.next += 1;
        if matches!(header["kind"].as_str(), Some("close" | "error")) {
            // The next frame can reuse this exact connection ID. Retire the
            // old slot in ingress order and fence its output before returning.
            slot.stop.send_replace(Some(Stop::RemoteClosed));
            self.active.remove(&key);
            return Ok(Inbound::Consumed);
        }
        match slot.input.try_send(frame) {
            Ok(()) => Ok(Inbound::Retained),
            Err(mpsc::error::TrySendError::Closed(_)) => Ok(Inbound::Consumed),
            Err(mpsc::error::TrySendError::Full(_)) => {
                slot.stop.send_replace(Some(Stop::Congested));
                Err("congested")
            }
        }
    }
}

impl Link {
    fn active(&self) -> bool {
        self.gateway
            .upgrade()
            .is_some_and(|gateway| match &self.carrier {
                Carrier::WorkerLink { channel, token } => {
                    gateway.update_channels(|channels| channels.tunnel_active(channel, *token))
                }
                Carrier::Legacy { token } => legacy::active(&gateway, *token),
            })
    }

    fn send(&self, frame: &Frame, stopped: &watch::Receiver<Option<Stop>>) -> Output {
        let remote_closed = || *stopped.borrow() == Some(Stop::RemoteClosed);
        self.gateway
            .upgrade()
            .map_or(Output::Closed, |gateway| match &self.carrier {
                Carrier::WorkerLink { channel, token } => gateway.update_channels(|channels| {
                    if remote_closed() {
                        Output::Closed
                    } else {
                        channels.tunnel_output(channel, *token, frame.bytes())
                    }
                }),
                Carrier::Legacy { token } => legacy::send(&gateway, *token, frame, remote_closed),
            })
    }

    fn credit(&self, frame: &Frame) {
        self.credit_bytes(frame.bytes().len());
    }

    fn credit_bytes(&self, bytes: usize) {
        if bytes > 0
            && let Carrier::WorkerLink { channel, token } = &self.carrier
            && let Some(gateway) = self.gateway.upgrade()
        {
            gateway.update_channels(|channels| {
                channels.tunnel_credit(channel, *token, bytes);
            });
        }
    }
}

struct Destination {
    host: String,
    port: u16,
    protection: Value,
}

enum TargetError {
    BindingMismatch,
    RecordUnavailable,
    WorkerMismatch,
    KindMismatch,
    ShareUnavailable,
}

impl TargetError {
    fn code(&self) -> &'static str {
        match self {
            Self::RecordUnavailable => "protected-record-unavailable",
            Self::ShareUnavailable => "protected-endpoint-unavailable",
            Self::BindingMismatch | Self::WorkerMismatch | Self::KindMismatch => {
                "protected-target-invalid"
            }
        }
    }

    fn reason(&self) -> &'static str {
        match self {
            Self::BindingMismatch => "invalid-target-binding",
            Self::RecordUnavailable => "protected-record-open-failed",
            Self::WorkerMismatch => "worker-id-mismatch",
            Self::KindMismatch => "target-kind-mismatch",
            Self::ShareUnavailable => "project-share-preparation-failed",
        }
    }
}

impl Destination {
    async fn open(gateway: &Coordinator, header: &Value) -> Result<Self, TargetError> {
        let target = &header["target"];
        if target["kind"] != "protected-tunnel" || target["recordId"] != header["tunnelId"] {
            return Err(TargetError::BindingMismatch);
        }
        let content = open_tunnel_record(
            &gateway.encryption,
            &header["tunnelId"],
            &target["protectedRecord"],
        )
        .map_err(|_| TargetError::RecordUnavailable)?;
        let destination = &content["destination"];
        if destination["workerId"].as_js_string() != Some(&gateway.worker) {
            return Err(TargetError::WorkerMismatch);
        }
        if content["source"]["kind"] == "worker-os-listener" {
            return Err(TargetError::KindMismatch);
        }
        let (host, port) = match destination["kind"].as_str() {
            Some("worker-tcp") if target["targetKind"] == "tcp" => (
                destination["host"].as_str().unwrap().to_owned(),
                destination["port"].as_u64().unwrap() as u16,
            ),
            Some("worker-project-share" | "worker-chat-share")
                if target["targetKind"] == "project-share"
                    && destination["resourceId"] == header["tunnelId"] =>
            {
                let addr = gateway
                    .shares
                    .endpoint(id(header, "tunnelId"), destination)
                    .await
                    .map_err(|_| TargetError::ShareUnavailable)?;
                (addr.ip().to_string(), addr.port())
            }
            _ => return Err(TargetError::KindMismatch),
        };
        Ok(Self {
            host,
            port,
            protection: content["dataProtection"].clone(),
        })
    }

    fn addresses(&self) -> Vec<SocketAddr> {
        let v4 = SocketAddr::from((Ipv4Addr::LOCALHOST, self.port));
        let v6 = SocketAddr::from((Ipv6Addr::LOCALHOST, self.port));
        match self.host.as_str() {
            "127.0.0.1" => vec![v4],
            "::1" => vec![v6],
            "localhost" => vec![v6, v4],
            _ => unreachable!("validated TCP destination host"),
        }
    }
}

struct Reply {
    base: Value,
    sequence: u64,
}

impl Reply {
    fn new(source: &Value) -> Self {
        Self {
            base: Value::object(
                [
                    "protocolVersion",
                    "tunnelId",
                    "attachmentId",
                    "sourceEndpointId",
                    "destinationEndpointId",
                    "connectionId",
                ]
                .map(|name| (name, source[name].clone())),
            ),
            sequence: 0,
        }
    }

    fn header(&self, kind: &str, fields: &[(&str, Value)]) -> Value {
        let mut header = self.base.clone();
        header["sequence"] = json!(self.sequence);
        header["kind"] = json!(kind);
        for (field, value) in fields {
            header[*field] = value.clone();
        }
        header
    }

    fn control(&self, kind: &str, fields: &[(&str, Value)]) -> Frame {
        wire::create(self.header(kind, fields), &[]).expect("validated tunnel control frame")
    }

    fn rejected(&self, code: &'static str) -> Frame {
        self.control("rejected", &[("code", json!(code))])
    }
}
